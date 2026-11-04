import {
  carryIds,
  type Doc,
  inlineText,
  parseMarkdown,
  reconcile,
  toMarkdown,
  walk,
} from "@tempra/editor/doc";
import type { RootContent } from "mdast";
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
import { diagramLint } from "./diagrams";
import { figureLint } from "./figure-lint";
import { imageLint } from "./images";
import { isObject, lintFields } from "./lint";
import { scanDoc, takeSection, targets } from "./markdown";
import {
  isExternal,
  isReserved,
  normalizePath,
  resolveLinkPath,
  safeDecode,
  splitAnchor,
} from "./paths";
import { normalizeVerified } from "./trust";
import type {
  Json,
  JsonObject,
  LintWarning,
  PageRecord,
  StoredLink,
  StoredSource,
  Verification,
} from "./types";

/** Keys the server owns: taken from the writer only on import (spec: the page format). */
export const SERVER_OWNED = new Set(["generated", "verified"]);
/** Keys the server computes at read time; never stored, ignored on write. */
export const COMPUTED = new Set([
  "trust_tier",
  "stale",
  "effective_status",
  "inbound_links",
  "usage_count",
]);
/** Known fields render first, in this order; other keys follow in arrival order. */
const FIELD_ORDER = [
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

export interface ParsedPage {
  /** Frontmatter entries in arrival order, server-owned and computed keys removed. */
  entries: [string, Json][];
  /** Frontmatter text kept verbatim when it is not a parseable YAML mapping. */
  rawFm: string | null;
  body: string;
  /** `generated` as the writer sent it. */
  generated: JsonObject | null;
  /** `verified` as the writer sent it, normalized to a list; null when absent. */
  verified: Verification[] | null;
  /** True when `verified` was a bare mapping rather than a list. */
  verifiedBare: boolean;
  lint: LintWarning[];
  /** Why the frontmatter is unusable (missing or not a YAML mapping), for writes that refuse it. */
  fmError: string | null;
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

/** Parses page markdown into frontmatter entries and body, with parse-level lint. */
export function parsePage(md: string): ParsedPage {
  const { fm, body } = splitFrontmatter(md);
  const lint: LintWarning[] = [];
  const out: ParsedPage = {
    entries: [],
    rawFm: null,
    body,
    generated: null,
    verified: null,
    verifiedBare: false,
    lint,
    fmError: null,
  };
  if (fm === null) {
    out.fmError =
      "There is no YAML frontmatter block. Start the file with `---`, then `title: …`, `description: …` and any other fields, then `---`.";
    lint.push({
      code: "missing_frontmatter",
      message:
        "No YAML frontmatter block; a page starts with one, holding its `title` and `description`.",
    });
    return out;
  }
  const doc = parseDocument(fm, { version: "1.2", uniqueKeys: false });
  if (doc.errors.length > 0 || (doc.contents !== null && !isMap(doc.contents))) {
    out.rawFm = fm;
    const err = doc.errors[0];
    const why = err?.message.split("\n")[0] ?? "not a YAML mapping";
    lint.push({
      code: "unparseable_frontmatter",
      message: `Frontmatter could not be parsed: ${why}`,
    });
    // The frontmatter starts on the file's second line, after the opening `---`.
    const line = err?.linePos?.[0]?.line;
    const where = line ? ` (line ${line + 1} of the file)` : "";
    const what = why.replace(/ at line \d+, column \d+:?$/, "").trimEnd();
    out.fmError = `The frontmatter is not valid YAML${where}: ${what}${/[.!?]$/.test(what) ? "" : "."}`;
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
      out.verifiedBare = !!value && typeof value === "object" && !Array.isArray(value);
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
  /** The stored body this version follows, whose block IDs it keeps where blocks match. */
  prev?: Doc | null;
  /** The tree the app sent, whose block IDs are kept where they name blocks of `prev`. */
  hints?: Doc | null;
}

export interface BuiltPage {
  record: PageRecord;
  lint: LintWarning[];
  /**
   * What the writer should know about this write but has nothing to fix in the stored page
   * (fields the server ignored): returned with the write, never stored as lint.
   */
  notices: LintWarning[];
  /** Verifications carried by an imported file, to be recorded as verify events. */
  verified: Verification[];
  footnoteRefs: string[];
  /** The `sources` entries whose `url` was stored as `resource` (TEMPRA-199), by index. */
  aliased: number[];
}

/**
 * Builds a content version from parsed markdown: parses the body into the stored tree (block IDs
 * carried over from `prev`), applies the v0.1 upgrades OKF bundles may carry, stamps `generated` on ordinary
 * writes, scans links and footnotes, and lints. Link targets are left unresolved (null); the store
 * resolves them against the library.
 */
export function buildRecord(parsed: ParsedPage, opts: BuildOptions): BuiltPage {
  const lint = [...parsed.lint];
  const notices: LintWarning[] = [];
  let entries = parsed.entries.map(([k, v]) => [k, v] as [string, Json]);
  const doc = parseMarkdown(parsed.body);
  if (opts.hints) carryIds(opts.hints, doc);

  // v0.1: `timestamp` is superseded by generated.at.
  let legacyTimestamp: string | null = null;
  const ts = entries.find(([k]) => k === "timestamp");
  if (ts) {
    legacyTimestamp = String(ts[1]);
    entries = entries.filter(([k]) => k !== "timestamp");
    lint.push({
      code: "v01_timestamp",
      message: "v0.1 `timestamp` migrated: superseded by `generated.at`.",
    });
  }
  // v0.1: a `# Citations` body list is superseded by `sources`.
  const migrated = migrateCitations(doc, entries);
  if (migrated) {
    entries = migrated;
    lint.push({
      code: "v01_citations",
      message: "v0.1 `# Citations` list migrated into `sources`.",
    });
  }

  // `url` is what a writer reaches for in a citation; a source's link is its `resource`
  // (TEMPRA-199). Imports keep what the bundle says.
  const aliased = opts.mode === "write" ? aliasSourceUrls(entries) : [];
  if (aliased.length > 0) {
    notices.push({
      code: "source_url_alias",
      message: `${aliased.map((i) => `\`sources[${i}]\``).join(", ")}: \`url\` stored as \`resource\`. A source entry is \`id\`, \`title\` and \`resource\` (a URL, or a path in this library).`,
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
      notices.push({
        code: "generated_ignored",
        message:
          "`generated` is stamped by the server from your token; the value you sent was ignored.",
      });
    }
  }
  if (opts.mode !== "import" && parsed.verified !== null) {
    if (!jsonEqual(parsed.verified, opts.stored?.verified ?? [])) {
      notices.push({
        code: "verified_ignored",
        message:
          "`verified` is set when a person verifies the page in the app; the value you sent was ignored.",
      });
    }
  } else if (opts.mode === "import" && parsed.verifiedBare) {
    lint.push({
      code: "verified_bare_mapping",
      message: "`verified` is a bare mapping; it is treated as a one-element list.",
    });
  }

  reconcile(opts.prev ?? null, doc);
  const scan = scanDoc(doc, opts.path);
  const links: StoredLink[] = scan.links.map((l) => ({ ...l, target: null }));
  const verified = opts.mode === "import" ? (parsed.verified ?? []) : [];
  if (parsed.rawFm === null) {
    lint.push(...lintFields(entries, generated, verified, scan, { strict: opts.mode === "write" }));
  }
  lint.push(...diagramLint(doc), ...figureLint(doc));
  lint.push(...imageLint(doc));
  const record: PageRecord = {
    fm: entries,
    raw_fm: parsed.rawFm,
    generated,
    doc,
    body: toMarkdown(doc),
    links,
  };
  return { record, lint, notices, verified, footnoteRefs: scan.footnoteRefs, aliased };
}

/**
 * Renames `url` to `resource`, in place and in the same position, in each `sources` entry that
 * has a string `url` and no `resource`; returns the entries' indexes.
 */
function aliasSourceUrls(entries: [string, Json][]): number[] {
  const at = entries.findIndex(([k]) => k === "sources");
  const list = entries[at]?.[1];
  if (!Array.isArray(list)) return [];
  const out: number[] = [];
  const next = list.map((s, i) => {
    if (!isObject(s) || "resource" in s || typeof s.url !== "string") return s;
    out.push(i);
    return Object.fromEntries(Object.entries(s).map(([k, v]) => [k === "url" ? "resource" : k, v]));
  });
  if (out.length > 0) entries[at] = ["sources", next];
  return out;
}

/** The entries as the writer sent them: `resource` back to `url` where it was aliased. */
export function unaliasSourceUrls(entries: [string, Json][], aliased: number[]): [string, Json][] {
  if (aliased.length === 0) return entries;
  return entries.map(([k, v]) => {
    if (k !== "sources" || !Array.isArray(v)) return [k, v];
    return [
      k,
      v.map((s, i) =>
        aliased.includes(i) && isObject(s)
          ? Object.fromEntries(
              Object.entries(s).map(([sk, sv]) => [sk === "resource" ? "url" : sk, sv]),
            )
          : s,
      ),
    ];
  });
}

/** A v0.1 `# Citations` list, taken out of the body into `sources`; null when there is none. */
function migrateCitations(doc: Doc, entries: [string, Json][]): [string, Json][] | null {
  const existing = entries.find(([k]) => k === "sources");
  if (existing && !Array.isArray(existing[1])) return null;
  const cited: JsonObject[] = [];
  const probe: Doc = { type: "root", children: [...doc.children] };
  for (const node of takeSection(probe, "Citations") ?? []) {
    walk(node, (n) => {
      if (n.type !== "listItem") return undefined;
      const para = n.children.find((c) => c.type === "paragraph");
      if (para?.type !== "paragraph") return false;
      const link = para.children.find((c) => c.type === "link");
      if (link?.type === "link") {
        // An autolink's text is its URL: no title.
        const title = inlineText(link.children).trim();
        cited.push(
          title && title !== link.url ? { resource: link.url, title } : { resource: link.url },
        );
      } else {
        const text = inlineText(para.children).trim();
        if (text) cited.push({ resource: text });
      }
      return false;
    });
  }
  if (cited.length === 0) return null;
  doc.children = probe.children as RootContent[];
  const next = entries.map(([k, v]) => [k, v] as [string, Json]);
  const sources = next.find(([k]) => k === "sources");
  if (sources && Array.isArray(sources[1])) sources[1] = [...sources[1], ...cited];
  else next.push(["sources", cited]);
  return next;
}

/** Canonical serialization of a record; its SHA-256 is the content-version hash. */
export function serializeRecord(r: PageRecord): string {
  return JSON.stringify({
    fm: r.fm,
    raw_fm: r.raw_fm,
    generated: r.generated,
    doc: r.doc,
    body: r.body,
    links: r.links.map((l) => ({
      at: l.at,
      raw: l.raw,
      path: l.path,
      anchor: l.anchor,
      form: l.form,
      target: l.target,
    })),
    ...(r.sources?.length
      ? {
          sources: r.sources.map((x) => ({
            index: x.index,
            raw: x.raw,
            path: x.path,
            anchor: x.anchor,
            form: x.form,
            target: x.target,
          })),
        }
      : {}),
  });
}

/** A `sources[].resource` that may name a file in the bundle, with the paths it could mean. */
export interface SourceCandidate {
  index: number;
  raw: string;
  anchor: string | null;
  /** Readings to try in order; the first that names a file wins. */
  options: { form: StoredSource["form"]; path: string }[];
  /** The reading kept when none resolves, or null when the value does not look like a path. */
  fallback: { form: StoredSource["form"]; path: string } | null;
}

/**
 * The internal-looking `sources[].resource` values of a page at `pagePath` (spec: Page
 * model, Links). A bare path is tried relative to the page, then to the bundle root.
 */
export function sourceCandidates(pagePath: string, fm: [string, Json][]): SourceCandidate[] {
  const list = fm.find(([k]) => k === "sources")?.[1];
  if (!Array.isArray(list)) return [];
  const out: SourceCandidate[] = [];
  list.forEach((s, index) => {
    if (!s || typeof s !== "object" || Array.isArray(s)) return;
    const raw = s.resource;
    if (typeof raw !== "string" || raw.trim() === "" || isExternal(raw)) return;
    const split = splitAnchor(raw.trim());
    const written = safeDecode(split.path);
    if (written === "" || written.endsWith("/")) return;
    const options: SourceCandidate["options"] = [];
    const add = (form: StoredSource["form"], path: string | null) => {
      if (path && !isReserved(path) && !options.some((o) => o.path === path)) {
        options.push({ form, path });
      }
    };
    if (written.startsWith("/")) add("absolute", normalizePath(written));
    else {
      add("relative", resolveLinkPath(pagePath, written));
      if (!written.startsWith("./") && !written.startsWith("../"))
        add("root", normalizePath(written));
    }
    if (options.length === 0) return;
    const pathLike =
      written.startsWith("/") ||
      written.startsWith("./") ||
      written.startsWith("../") ||
      written.endsWith(".md");
    const fallback = pathLike
      ? (options.find((o) => o.form === "root") ?? options[0] ?? null)
      : null;
    out.push({ index, raw, anchor: split.anchor, options, fallback });
  });
  return out;
}

export function deserializeRecord(s: string): PageRecord {
  return JSON.parse(s) as PageRecord;
}

/** A frontmatter field of a record, or undefined. */
export function field(r: PageRecord, key: string): Json | undefined {
  return r.fm.find(([k]) => k === key)?.[1];
}

export interface RenderOptions {
  verified: Verification[];
  /** The href to emit for each stored link; defaults to the link as written. */
  href?: (link: StoredLink) => string;
  /** The `resource` to emit for each internal source; defaults to the value as written. */
  sourceHref?: (source: StoredSource) => string;
  /** Computed values appended to the frontmatter on request. */
  computed?: [string, Json][];
}

/** Renders a record as page markdown with canonical frontmatter (spec: Reads and export). */
export function renderPage(r: PageRecord, opts: RenderOptions): string {
  const body = renderBody(r, opts.href);
  if (r.raw_fm !== null) return `---\n${r.raw_fm}\n---\n${body}`;
  const fm = renderSources(r, opts.sourceHref);
  const ordered: [string, Json][] = [];
  for (const key of FIELD_ORDER) {
    const e = fm.find(([k]) => k === key);
    if (e) ordered.push(e);
  }
  for (const e of fm) if (!FIELD_ORDER.includes(e[0])) ordered.push(e);
  if (r.generated) ordered.push(["generated", r.generated]);
  if (opts.verified.length > 0) {
    ordered.push(["verified", opts.verified.map((v) => ({ by: v.by, at: v.at }))]);
  }
  for (const e of opts.computed ?? []) ordered.push(e);
  if (ordered.length === 0) return body;
  return `---\n${stringifyFrontmatter(ordered)}---\n${body}`;
}

/** The frontmatter entries with each internal source's `resource` as `sourceHref` renders it. */
function renderSources(r: PageRecord, sourceHref?: (s: StoredSource) => string) {
  if (!sourceHref || !r.sources?.length) return r.fm;
  const stored = r.sources;
  return r.fm.map(([k, v]): [string, Json] => {
    if (k !== "sources" || !Array.isArray(v)) return [k, v];
    return [
      k,
      v.map((entry, i) => {
        const s = stored.find((x) => x.index === i);
        if (!s || !entry || typeof entry !== "object" || Array.isArray(entry)) return entry;
        const resource = sourceHref(s);
        return resource === s.raw ? entry : { ...entry, resource };
      }),
    ];
  });
}

/**
 * The body with each link at the target `href` gives it (its target's current path): the stored
 * markdown when no link moved, else the tree written anew.
 */
export function renderBody(r: PageRecord, href?: (link: StoredLink) => string): string {
  if (!href) return r.body;
  const doc = renderDoc(r, href);
  return doc === r.doc ? r.body : toMarkdown(doc);
}

/** The tree with each link at the target `href` gives it; the stored tree itself when none moved. */
export function renderDoc(r: PageRecord, href?: (link: StoredLink) => string): Doc {
  if (!href) return r.doc;
  const moved = r.links.flatMap((l) => {
    const url = href(l);
    return url === l.raw ? [] : [[l.at, url] as const];
  });
  if (moved.length === 0) return r.doc;
  const doc = structuredClone(r.doc);
  const nodes = targets(doc);
  for (const [at, url] of moved) {
    const node = nodes[at];
    if (node) node.url = url;
  }
  return doc;
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
  // The format's examples write `{ by, at }` but `[a, b]`; the yaml library pads both, so unpad lists.
  return doc
    .toString({ lineWidth: 0, minContentWidth: 0 })
    .replace(/^(\s*(?:- )?[^\s:][^:]*: )\[ (.*) \]$/gm, "$1[$2]");
}

/** Flow style for lists of scalars and for `generated`, as in the format's examples (`tags: [a, b]`, `{ by, at }`). */
function styleNode(node: unknown, key: string | null) {
  if (isSeq(node)) {
    const seq = node as YAMLSeq;
    if (seq.items.every((i) => isScalar(i))) seq.flow = seq.items.length > 0;
    // A list of mappings (`sources`, `verified`) stays block style, one key per line, as agents
    // write it, whatever its length (tempra-dev: decisions/structured-documents, TEMPRA-42).
    for (const item of seq.items) styleNode(item, null);
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
