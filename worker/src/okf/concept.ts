import {
  Document,
  isMap,
  isScalar,
  isSeq,
  parseDocument,
  visit,
  YAMLMap,
  type YAMLSeq,
} from "yaml";
import { lintFields } from "./lint";
import { findSection, scanBody } from "./markdown";
import { normalizeVerified } from "./trust";
import type {
  ConceptRecord,
  Json,
  JsonObject,
  LintWarning,
  StoredLink,
  Verification,
} from "./types";

/** Keys the server owns: taken from the writer only on import (spec: OKF conformance). */
export const SERVER_OWNED = new Set(["generated", "verified"]);
/** Keys the server computes at read time; never stored, ignored on write. */
export const COMPUTED = new Set(["trust_tier", "stale", "effective_status", "inbound_links"]);
/** OKF fields render first, in this order; other keys follow in arrival order. */
const OKF_ORDER = [
  "type",
  "title",
  "description",
  "resource",
  "tags",
  "status",
  "stale_after",
  "sources",
  "usage_window",
];

export interface ParsedConcept {
  /** Frontmatter entries in arrival order, server-owned and computed keys removed. */
  entries: [string, Json][];
  /** Frontmatter text kept verbatim when it is not a parseable YAML mapping. */
  rawFm: string | null;
  body: string;
  /** `generated` as the writer sent it. */
  generated: JsonObject | null;
  /** `verified` as the writer sent it, normalized to a list; null when absent. */
  verified: Verification[] | null;
  lint: LintWarning[];
}

/** Splits a markdown file into its frontmatter text (null when absent) and body. */
export function splitFrontmatter(md: string): { fm: string | null; body: string } {
  const s = md.startsWith("﻿") ? md.slice(1) : md;
  const open = /^---[ \t]*\r?\n/.exec(s);
  if (!open) return { fm: null, body: s };
  const rest = s.slice(open[0].length);
  const empty = /^(?:---|\.\.\.)[ \t]*(?:\r?\n|$)/.exec(rest);
  if (empty) return { fm: "", body: rest.slice(empty[0].length) };
  const close = /\r?\n(?:---|\.\.\.)[ \t]*(?:\r?\n|$)/.exec(rest);
  if (!close) return { fm: null, body: s };
  return { fm: rest.slice(0, close.index), body: rest.slice(close.index + close[0].length) };
}

/** Parses OKF markdown into frontmatter entries and body, with parse-level lint. */
export function parseConcept(md: string): ParsedConcept {
  const { fm, body } = splitFrontmatter(md);
  const lint: LintWarning[] = [];
  const out: ParsedConcept = {
    entries: [],
    rawFm: null,
    body,
    generated: null,
    verified: null,
    lint,
  };
  if (fm === null) {
    lint.push({
      code: "missing_frontmatter",
      message: "No YAML frontmatter block; `type` is required.",
    });
    return out;
  }
  const doc = parseDocument(fm, { version: "1.2", uniqueKeys: false });
  if (doc.errors.length > 0 || (doc.contents !== null && !isMap(doc.contents))) {
    out.rawFm = fm;
    const why = doc.errors[0]?.message.split("\n")[0] ?? "not a YAML mapping";
    lint.push({
      code: "unparseable_frontmatter",
      message: `Frontmatter could not be parsed: ${why}`,
    });
    return out;
  }
  if (hasComments(doc)) {
    lint.push({
      code: "yaml_comment_dropped",
      message: "YAML comments in frontmatter are not kept; the rendered file omits them.",
    });
  }
  const map = doc.contents;
  if (!isMap(map)) return out;
  for (const pair of map.items) {
    const key = isScalar(pair.key) ? String(pair.key.value) : String(pair.key);
    const value = (
      isScalar(pair.value) || isMap(pair.value) || isSeq(pair.value) ? pair.value.toJS(doc) : null
    ) as Json;
    if (key === "generated") {
      out.generated = value && typeof value === "object" && !Array.isArray(value) ? value : null;
    } else if (key === "verified") {
      out.verified = normalizeVerified(value);
      if (value && typeof value === "object" && !Array.isArray(value)) {
        lint.push({
          code: "verified_bare_mapping",
          message: "`verified` is a bare mapping; it is treated as a one-element list.",
        });
      }
    } else if (COMPUTED.has(key)) {
      // Computed keys come back on every read with ?computed=true; echoing them is normal.
    } else {
      out.entries.push([key, value]);
    }
  }
  return out;
}

function hasComments(doc: Document): boolean {
  if (doc.comment || doc.commentBefore) return true;
  let found = false;
  visit(doc, {
    Node(_key, node) {
      if (node.comment || node.commentBefore) {
        found = true;
        return visit.BREAK;
      }
    },
  });
  return found;
}

export interface BuildOptions {
  path: string;
  /** `write` stamps `generated`; `import` and `keep` keep the given one. */
  mode: "write" | "import";
  actor: string;
  now: string;
  /** Current server-owned values, for lint when the writer's copy differs. */
  stored?: { generated: JsonObject | null; verified: Verification[] } | null;
}

export interface BuiltConcept {
  record: ConceptRecord;
  lint: LintWarning[];
  /** Verifications carried by an imported file, to be recorded as verify events. */
  verified: Verification[];
  footnoteRefs: string[];
}

/**
 * Builds a content version from parsed markdown: applies v0.1 migrations (OKF §13), stamps
 * `generated` on ordinary writes, scans links and footnotes, and lints. Link targets are left
 * unresolved (null); the store resolves them against the library.
 */
export function buildRecord(parsed: ParsedConcept, opts: BuildOptions): BuiltConcept {
  const lint = [...parsed.lint];
  let entries = parsed.entries.map(([k, v]) => [k, v] as [string, Json]);
  let body = parsed.body;

  // v0.1: `timestamp` is superseded by generated.at.
  let legacyTimestamp: string | null = null;
  const ts = entries.find(([k]) => k === "timestamp");
  if (ts) {
    legacyTimestamp = String(ts[1]);
    entries = entries.filter(([k]) => k !== "timestamp");
    lint.push({
      code: "v01_timestamp",
      message: "v0.1 `timestamp` migrated: superseded by `generated.at` (OKF §13).",
    });
  }
  // v0.1: a `# Citations` body list is superseded by `sources`.
  const migrated = migrateCitations(body, entries);
  if (migrated) {
    body = migrated.body;
    entries = migrated.entries;
    lint.push({
      code: "v01_citations",
      message: "v0.1 `# Citations` list migrated into `sources` (OKF §13).",
    });
  }

  let generated: JsonObject | null;
  if (opts.mode === "import") {
    generated =
      parsed.generated ?? (legacyTimestamp ? { by: opts.actor, at: legacyTimestamp } : null);
  } else {
    generated = { by: opts.actor, at: opts.now };
    const stored = opts.stored?.generated ?? null;
    if (parsed.generated && !jsonEqual(parsed.generated, stored)) {
      lint.push({
        code: "generated_ignored",
        message:
          "`generated` is stamped by the server from your token; the value you sent was ignored.",
      });
    }
  }
  if (opts.mode !== "import" && parsed.verified !== null) {
    if (!jsonEqual(parsed.verified, opts.stored?.verified ?? [])) {
      lint.push({
        code: "verified_ignored",
        message:
          "`verified` is added only through the verify action; the value you sent was ignored.",
      });
    }
  }

  const scan = scanBody(body, opts.path);
  const links: StoredLink[] = scan.links.map((l) => ({ ...l, target: null }));
  const verified = opts.mode === "import" ? (parsed.verified ?? []) : [];
  if (parsed.rawFm === null) {
    lint.push(...lintFields(entries, generated, verified, scan.footnoteRefs));
  }
  const record: ConceptRecord = {
    v: 1,
    fm: entries,
    raw_fm: parsed.rawFm,
    generated,
    body,
    links,
  };
  return { record, lint, verified, footnoteRefs: scan.footnoteRefs };
}

function migrateCitations(body: string, entries: [string, Json][]) {
  const section = findSection(body, "Citations");
  if (!section) return null;
  const text = body.slice(section.start, section.end);
  const cited: JsonObject[] = [];
  for (const line of text.split("\n")) {
    const item = /^\s*[-*+]\s+(.+?)\s*$/.exec(line)?.[1];
    if (!item) continue;
    const link = /\[([^\]]*)\]\(([^)\s]+)\)/.exec(item);
    if (link?.[2])
      cited.push(link[1] ? { resource: link[2], title: link[1] } : { resource: link[2] });
    else cited.push({ resource: item });
  }
  if (cited.length === 0) return null;
  const next = entries.map(([k, v]) => [k, v] as [string, Json]);
  const existing = next.find(([k]) => k === "sources");
  if (existing && Array.isArray(existing[1])) existing[1] = [...existing[1], ...cited];
  else if (!existing) next.push(["sources", cited]);
  else return null;
  return { body: body.slice(0, section.start) + body.slice(section.end), entries: next };
}

/** Canonical serialization of a record; its SHA-256 is the content-version hash. */
export function serializeRecord(r: ConceptRecord): string {
  return JSON.stringify({
    v: r.v,
    fm: r.fm,
    raw_fm: r.raw_fm,
    generated: r.generated,
    body: r.body,
    links: r.links.map((l) => ({
      start: l.start,
      end: l.end,
      raw: l.raw,
      path: l.path,
      anchor: l.anchor,
      form: l.form,
      target: l.target,
    })),
  });
}

export function deserializeRecord(s: string): ConceptRecord {
  return JSON.parse(s) as ConceptRecord;
}

/** A frontmatter field of a record, or undefined. */
export function field(r: ConceptRecord, key: string): Json | undefined {
  return r.fm.find(([k]) => k === key)?.[1];
}

export interface RenderOptions {
  verified: Verification[];
  /** The href to emit for each stored link; defaults to the link as written. */
  href?: (link: StoredLink) => string;
  /** Computed values appended to the frontmatter on request. */
  computed?: [string, Json][];
}

/** Renders a record as OKF markdown with canonical frontmatter (spec: Reads and export). */
export function renderConcept(r: ConceptRecord, opts: RenderOptions): string {
  const body = renderBody(r, opts.href);
  if (r.raw_fm !== null) return `---\n${r.raw_fm}\n---\n${body}`;
  const ordered: [string, Json][] = [];
  for (const key of OKF_ORDER) {
    const e = r.fm.find(([k]) => k === key);
    if (e) ordered.push(e);
  }
  for (const e of r.fm) if (!OKF_ORDER.includes(e[0])) ordered.push(e);
  if (r.generated) ordered.push(["generated", r.generated]);
  if (opts.verified.length > 0) {
    ordered.push(["verified", opts.verified.map((v) => ({ by: v.by, at: v.at }))]);
  }
  for (const e of opts.computed ?? []) ordered.push(e);
  if (ordered.length === 0) return body;
  return `---\n${stringifyFrontmatter(ordered)}---\n${body}`;
}

export function renderBody(r: ConceptRecord, href?: (link: StoredLink) => string): string {
  if (!href || r.links.length === 0) return r.body;
  let out = "";
  let pos = 0;
  for (const link of r.links) {
    out += r.body.slice(pos, link.start) + href(link);
    pos = link.end;
  }
  return out + r.body.slice(pos);
}

function stringifyFrontmatter(entries: [string, Json][]): string {
  const doc = new Document(null, { version: "1.2" });
  const map = new YAMLMap();
  for (const [k, v] of entries) {
    const node = doc.createNode(v);
    styleNode(node, k);
    map.add(doc.createPair(k, node));
  }
  doc.contents = map;
  // OKF's examples write `{ by, at }` but `[a, b]`; the yaml library pads both, so unpad lists.
  return doc
    .toString({ lineWidth: 0, minContentWidth: 0 })
    .replace(/^(\s*(?:- )?[^\s:][^:]*: )\[ (.*) \]$/gm, "$1[$2]");
}

/** Flow style for short collections, as in OKF's own examples (`tags: [a, b]`, `{ by, at }`). */
function styleNode(node: unknown, key: string | null) {
  if (isSeq(node)) {
    const seq = node as YAMLSeq;
    if (seq.items.every((i) => isScalar(i))) seq.flow = seq.items.length > 0;
    for (const item of seq.items) {
      if (
        isMap(item) &&
        item.items.every((p) => isScalar(p.value)) &&
        item.toString().length < 72
      ) {
        item.flow = true;
      } else styleNode(item, null);
    }
  } else if (isMap(node)) {
    if (key === "generated" || key === "usage_window") node.flow = true;
    for (const pair of node.items) styleNode(pair.value, null);
  }
}

export function jsonEqual(a: unknown, b: unknown): boolean {
  return canonicalJson(a) === canonicalJson(b);
}

/** JSON with object keys sorted, for order-insensitive comparison. */
export function canonicalJson(v: unknown): string {
  return JSON.stringify(v, (_k, val) =>
    val && typeof val === "object" && !Array.isArray(val)
      ? Object.fromEntries(Object.entries(val).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
      : val,
  );
}
