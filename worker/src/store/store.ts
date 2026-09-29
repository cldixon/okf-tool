import { hmac } from "@noble/hashes/hmac.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, hexToBytes, randomBytes } from "@noble/hashes/utils.js";
import { stringify as yamlStringify } from "yaml";
import {
  buildRecord,
  deserializeRecord,
  field,
  parseConcept,
  renderConcept,
  serializeRecord,
  sourceCandidates,
} from "../okf/concept";
import { type LogRequest, renderIndex, renderLog } from "../okf/derived";
import { unifiedDiff } from "../okf/diff";
import { sha256Hex } from "../okf/hash";
import { lintFields } from "../okf/lint";
import { scanBody } from "../okf/markdown";
import {
  basename,
  dirname,
  isConceptPath,
  isReserved,
  normalizeDir,
  normalizePath,
  relativePath,
  resolveLinkPath,
  safeDecode,
  splitAnchor,
  underPrefix,
} from "../okf/paths";
import { effectiveStatus, isStale, trustTier } from "../okf/trust";
import type {
  ConceptRecord,
  Json,
  JsonObject,
  LintWarning,
  StoredLink,
  StoredSource,
  TrustTier,
  Verification,
} from "../okf/types";
import { notFound, OkfError } from "./errors";
import { migrate } from "./schema";
import type { SqlHandle } from "./sql";

/** Concepts over this many bytes of rendered markdown are refused (spec: OKF conformance). */
export const DEFAULT_CONCEPT_CAP = 100 * 1024;

export interface RequestContext {
  actor: string;
  request_id: string;
  note?: string | null;
}

export interface BlobRef {
  hash: string;
  size: number;
  media: string | null;
}

export type ConceptContent = string | { frontmatter: JsonObject; body: string };

export type WriteOp =
  | {
      op: "write";
      path: string;
      content: ConceptContent;
      if_match?: string | null;
      if_none_match?: boolean;
    }
  | { op: "attach"; path: string; blob: BlobRef; if_match?: string | null; if_none_match?: boolean }
  | { op: "edit"; path: string; edits: { old: string; new: string }[]; if_match?: string | null }
  | { op: "move"; path: string; to: string }
  | { op: "delete"; path: string; if_match?: string | null };

export interface OpResult {
  op: string;
  path: string;
  hash: string | null;
  seq: number;
  lint: LintWarning[];
}

export interface WriteResult {
  request_id: string;
  seq: number;
  results: OpResult[];
}

export type ImportFile = { path: string; markdown: string } | { path: string; blob: BlobRef };

export interface ImportResult {
  request_id: string;
  seq: number;
  files: number;
  skipped: string[];
  warnings: { path: string; lint: LintWarning[] }[];
}

export interface EventRow {
  seq: number;
  ts: string;
  actor: string;
  request_id: string;
  op: string;
  path: string;
  prev_hash: string | null;
  hash: string | null;
  concept_id: string;
  meta: JsonObject | null;
}

export interface RequestRow {
  request_id: string;
  ts: string;
  actor: string;
  note: string | null;
  events: EventRow[];
}

export type Kind = "concept" | "attachment";

interface Entry {
  path: string;
  concept_id: string;
  hash: string;
  kind: Kind;
  seq: number;
}

interface PathRow extends Entry {
  created_seq: number;
}

/** The path-to-hash map of a library as of a sequence number (spec: The ledger, Snapshots). */
class Snapshot {
  readonly byPath = new Map<string, Entry>();
  readonly byId = new Map<string, Entry>();
  constructor(
    readonly seq: number,
    entries: Entry[],
  ) {
    for (const e of entries) {
      this.byPath.set(e.path, e);
      this.byId.set(e.concept_id, e);
    }
  }

  /** A path as addressed by a client: with or without the `.md` suffix. */
  lookup(path: string): Entry | undefined {
    return (
      this.byPath.get(path) ?? (path.endsWith(".md") ? undefined : this.byPath.get(`${path}.md`))
    );
  }

  sorted(): Entry[] {
    return [...this.byPath.values()].sort((a, b) => (a.path < b.path ? -1 : 1));
  }
}

export interface ConceptRow {
  path: string;
  kind: Kind;
  hash: string;
  seq: number;
  type?: string;
  title?: string | null;
  description?: string | null;
  status?: string;
  tags?: string[];
  trust_tier?: TrustTier;
  stale?: boolean;
  size?: number;
  media?: string | null;
}

export type FileView =
  | {
      kind: "concept";
      path: string;
      hash: string;
      seq: number;
      markdown: string;
      frontmatter: JsonObject;
      body: string;
      lint: LintWarning[];
      trust_tier: TrustTier;
      stale: boolean;
      inbound_links: number;
    }
  | {
      kind: "attachment";
      path: string;
      hash: string;
      seq: number;
      size: number;
      media: string | null;
    }
  | { kind: "derived"; path: string; seq: number; markdown: string };

export interface ExportFile {
  path: string;
  text?: string;
  blob?: BlobRef;
}

export interface StoreOptions {
  conceptCap?: number;
  /** Server clock, injectable for tests. */
  now?: () => Date;
}

function iso(d: Date): string {
  return d.toISOString().replace(/\.\d{3}Z$/, "Z");
}

function escapeLike(s: string): string {
  return s.replace(/[\\%_]/g, (c) => `\\${c}`);
}

function utf8Length(s: string): number {
  return new TextEncoder().encode(s).length;
}

function str(v: Json | undefined): string | null {
  return typeof v === "string" ? v : v === undefined || v === null ? null : String(v);
}

function tagsOf(r: ConceptRecord): string[] {
  const t = field(r, "tags");
  if (Array.isArray(t)) return t.filter((x) => x !== null).map((x) => String(x));
  return typeof t === "string" ? [t] : [];
}

type LinkKind = "body" | "source";

/** A record's links into the library: body links, then internal source resources. */
function linkGraph(r: ConceptRecord): [StoredLink | StoredSource, LinkKind][] {
  const out: [StoredLink | StoredSource, LinkKind][] = [];
  for (const l of r.links) if (!isDerivedTarget(l)) out.push([l, "body"]);
  for (const s of r.sources ?? []) out.push([s, "source"]);
  return out;
}

function brokenLink(kind: string, raw: string, path: string): LintWarning {
  const what = kind === "source" ? `Source resource ${raw}` : `Link ${raw}`;
  return {
    code: "broken_link",
    message: `${what} points to /${path}, which does not exist.`,
    target: path,
  };
}

/** Links to `index.md`, `log.md` or a directory name synthesized files, not concepts. */
function isDerivedTarget(link: { raw: string; path: string }): boolean {
  const raw = splitAnchor(link.raw.replace(/^<|>$/g, "")).path;
  return isReserved(link.path) || raw.endsWith("/");
}

/**
 * One library's storage: blobs, the ledger and derived indexes (spec: Data model, The ledger,
 * Write path). Synchronous and free of Worker APIs, so it runs in the Library DO and under bun.
 */
export class LibraryStore {
  private readonly cap: number;
  private readonly clock: () => Date;
  private readonly records = new Map<string, ConceptRecord>();
  private readonly snapshots = new Map<number, Snapshot>();

  constructor(
    private readonly sql: SqlHandle,
    opts: StoreOptions = {},
  ) {
    this.cap = opts.conceptCap ?? DEFAULT_CONCEPT_CAP;
    this.clock = opts.now ?? (() => new Date());
    migrate(sql);
  }

  // ---------------------------------------------------------------- ledger primitives

  headSeq(): number {
    return this.sql.all<{ s: number }>("SELECT COALESCE(MAX(seq), 0) AS s FROM events")[0]?.s ?? 0;
  }

  private appendEvent(
    ctx: RequestContext,
    ts: string,
    e: {
      op: string;
      path: string;
      prev_hash: string | null;
      hash: string | null;
      concept_id: string;
      meta?: JsonObject;
    },
  ): number {
    const meta: JsonObject = { ...(e.meta ?? {}) };
    if (ctx.note) meta.note = ctx.note;
    const rows = this.sql.all<{ seq: number }>(
      `INSERT INTO events (ts, actor, request_id, op, path, prev_hash, hash, concept_id, meta)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING seq`,
      ts,
      ctx.actor,
      ctx.request_id,
      e.op,
      e.path,
      e.prev_hash,
      e.hash,
      e.concept_id,
      Object.keys(meta).length > 0 ? JSON.stringify(meta) : null,
    );
    const seq = rows[0]?.seq;
    if (seq === undefined) throw new Error("event insert returned no seq");
    return seq;
  }

  private putRecord(r: ConceptRecord): string {
    const content = serializeRecord(r);
    const hash = sha256Hex(content);
    this.sql.run(
      "INSERT OR IGNORE INTO blobs (hash, size, location, content, media) VALUES (?, ?, 'inline', ?, 'text/markdown')",
      hash,
      utf8Length(content),
      content,
    );
    this.records.set(hash, r);
    return hash;
  }

  private record(hash: string): ConceptRecord {
    const cached = this.records.get(hash);
    if (cached) return cached;
    const row = this.sql.all<{ content: string | ArrayBuffer }>(
      "SELECT content FROM blobs WHERE hash = ?",
      hash,
    )[0];
    if (!row) throw new Error(`missing blob ${hash}`);
    const text =
      typeof row.content === "string" ? row.content : new TextDecoder().decode(row.content);
    const r = deserializeRecord(text);
    if (this.records.size > 2000) this.records.clear();
    this.records.set(hash, r);
    return r;
  }

  private blobInfo(hash: string): BlobRef & { location: string } {
    const row = this.sql.all<{ size: number; media: string | null; location: string }>(
      "SELECT size, media, location FROM blobs WHERE hash = ?",
      hash,
    )[0];
    if (!row) throw new Error(`missing blob ${hash}`);
    return { hash, size: row.size, media: row.media, location: row.location };
  }

  private pathRow(path: string): PathRow | undefined {
    return this.sql.all<PathRow>(
      "SELECT path, concept_id, hash, kind, last_seq AS seq, created_seq FROM paths WHERE path = ?",
      path,
    )[0];
  }

  /** A path as a client addresses it: exact, or a concept without its `.md` suffix. */
  private lookupRow(path: string): PathRow | undefined {
    return this.pathRow(path) ?? (path.endsWith(".md") ? undefined : this.pathRow(`${path}.md`));
  }

  private verifiedAt(conceptId: string, seq: number): Verification[] {
    return this.sql.all<Verification>(
      "SELECT by, at FROM verifications WHERE concept_id = ? AND seq <= ? ORDER BY seq",
      conceptId,
      seq,
    );
  }

  private redirectAt(path: string, seq: number): string | undefined {
    return this.sql.all<{ concept_id: string }>(
      "SELECT concept_id FROM redirects WHERE old_path IN (?, ?) AND since_seq <= ? ORDER BY since_seq DESC LIMIT 1",
      path,
      `${path}.md`,
      seq,
    )[0]?.concept_id;
  }

  /**
   * The snapshot at `at` (default head). Committed snapshots are immutable and cached; `live`
   * builds an uncached one from `paths`, for reads inside a write transaction.
   */
  private snapshot(at?: number, live = false): Snapshot {
    const head = this.headSeq();
    if (live) return new Snapshot(head, this.headEntries());
    const seq = at === undefined ? head : at;
    if (!Number.isInteger(seq) || seq < 0 || seq > head) {
      throw new OkfError(400, "bad_seq", `Sequence ${at} is outside 0..${head}.`);
    }
    const cached = this.snapshots.get(seq);
    if (cached) return cached;
    const entries =
      seq === head
        ? this.headEntries()
        : this.sql
            .all<Entry & { location: string }>(
              `SELECT e.path, e.concept_id, e.hash, e.seq, b.location FROM events e
               JOIN (SELECT concept_id, MAX(seq) AS m FROM events WHERE seq <= ? GROUP BY concept_id) x
                 ON e.seq = x.m
               JOIN blobs b ON b.hash = e.hash
               WHERE e.hash IS NOT NULL`,
              seq,
            )
            .map((e) => ({ ...e, kind: (e.location === "r2" ? "attachment" : "concept") as Kind }));
    const snap = new Snapshot(seq, entries);
    if (this.snapshots.size > 32) this.snapshots.clear();
    this.snapshots.set(seq, snap);
    return snap;
  }

  private headEntries(): Entry[] {
    return this.sql.all<Entry>("SELECT path, concept_id, hash, kind, last_seq AS seq FROM paths");
  }

  // ---------------------------------------------------------------- writes

  /** Applies ops as one all-or-nothing request (spec: Write path, Tier 1; POST /batch). */
  apply(ctx: RequestContext, ops: WriteOp[]): WriteResult {
    if (ops.length === 0) throw new OkfError(400, "empty_request", "No operations to apply.");
    return this.guard(() =>
      this.sql.transaction(() => {
        const w = this.begin(ctx);
        for (const op of ops) this.planCreate(w, op);
        const results = ops.map((op) => this.applyOp(w, op));
        return {
          request_id: ctx.request_id,
          seq: this.headSeq(),
          results: this.finish(w, results),
        };
      }),
    );
  }

  /**
   * Imports a bundle as one request (spec: Import and export). Keeps each file's own `generated`
   * and records its `verified` entries as verify events; incoming `index.md` and `log.md` are
   * discarded because the service synthesizes them.
   */
  import(ctx: RequestContext, files: ImportFile[], source?: string): ImportResult {
    return this.guard(() =>
      this.sql.transaction(() => {
        const w = this.begin(ctx);
        w.mode = "import";
        w.source = source ?? null;
        const skipped: string[] = [];
        const ops: WriteOp[] = [];
        for (const f of files) {
          const path = normalizePath(f.path);
          if (!path) throw new OkfError(400, "bad_path", `Invalid path ${f.path}.`);
          if (isReserved(path)) {
            skipped.push(path);
            continue;
          }
          ops.push(
            "markdown" in f
              ? { op: "write", path, content: f.markdown }
              : { op: "attach", path, blob: f.blob },
          );
        }
        for (const op of ops) this.planCreate(w, op);
        const results = this.finish(
          w,
          ops.map((op) => this.applyOp(w, op)),
        );
        return {
          request_id: ctx.request_id,
          seq: this.headSeq(),
          files: ops.length,
          skipped,
          warnings: results
            .filter((r) => r.lint.length > 0)
            .map((r) => ({ path: r.path, lint: r.lint })),
        };
      }),
    );
  }

  /** Forward-only rollback of one path to its state at `to_seq`, or of a whole request. */
  revert(ctx: RequestContext, target: { path: string; to_seq: number } | { request_id: string }) {
    return this.guard(() =>
      this.sql.transaction(() => {
        const w = this.begin(ctx);
        const results =
          "request_id" in target
            ? this.revertRequest(w, target.request_id)
            : this.revertPath(w, target.path, target.to_seq);
        if (results.length === 0) {
          throw new OkfError(
            409,
            "nothing_to_revert",
            "The target state equals the current state.",
          );
        }
        return {
          request_id: ctx.request_id,
          seq: this.headSeq(),
          results: this.finish(w, results),
        };
      }),
    );
  }

  private guard<T>(fn: () => T): T {
    try {
      return fn();
    } catch (e) {
      // A rolled-back transaction may have cached state for sequence numbers it never committed.
      this.snapshots.clear();
      throw e;
    }
  }

  private begin(ctx: RequestContext): WriteState {
    if (!ctx.actor) throw new OkfError(400, "no_actor", "Writes need an actor.");
    if (!ctx.request_id) throw new OkfError(400, "no_request_id", "Writes need a request id.");
    return {
      ctx,
      now: iso(this.clock()),
      mode: "write",
      source: null,
      pending: new Map(),
      written: new Map(),
      affected: new Set(),
    };
  }

  /** Pre-assigns ids to paths this request creates, so links between new files resolve. */
  private planCreate(w: WriteState, op: WriteOp) {
    if (op.op !== "write" && op.op !== "attach") return;
    const path = op.op === "write" ? this.conceptPath(op.path) : normalizePath(op.path);
    if (path && !this.pathRow(path) && !w.pending.has(path)) {
      w.pending.set(path, crypto.randomUUID());
    }
  }

  private applyOp(w: WriteState, op: WriteOp): OpResult {
    switch (op.op) {
      case "write":
        return this.writeConcept(w, op.path, op.content, op.if_match, op.if_none_match);
      case "attach":
        return this.writeAttachment(w, op.path, op.blob, op.if_match, op.if_none_match);
      case "edit":
        return this.edit(w, op.path, op.edits, op.if_match);
      case "move":
        return this.move(w, op.path, op.to);
      case "delete":
        return this.remove(w, op.path, op.if_match);
      default:
        throw new OkfError(400, "bad_op", `Unknown op ${(op as { op: string }).op}.`);
    }
  }

  /** Adds broken-link lint to each written concept and refreshes flags on affected concepts. */
  private finish(w: WriteState, results: OpResult[]): OpResult[] {
    for (const id of w.affected) this.refreshBroken(id);
    for (const r of results) {
      const id = w.written.get(r.path);
      if (!id || r.hash === null) continue;
      const broken = this.refreshBroken(id);
      if (broken.length > 0) r.lint = [...r.lint, ...broken];
    }
    return results;
  }

  private conceptPath(input: string): string {
    const p = normalizePath(input);
    if (!p) throw new OkfError(400, "bad_path", `Invalid path ${JSON.stringify(input)}.`);
    return p.endsWith(".md") ? p : `${p}.md`;
  }

  private checkPreconditions(
    path: string,
    cur: PathRow | undefined,
    ifMatch: string | null | undefined,
    ifNoneMatch: boolean | undefined,
    mode: WriteMode,
  ) {
    if (mode === "import") return;
    const current_hash = cur?.hash ?? null;
    if (ifNoneMatch && cur) {
      throw new OkfError(412, "exists", `${path} already exists.`, { current_hash });
    }
    if (ifMatch) {
      if (!cur || cur.hash !== ifMatch) {
        throw new OkfError(412, "precondition_failed", `${path} does not match If-Match.`, {
          current_hash,
        });
      }
    } else if (cur) {
      throw new OkfError(
        412,
        "exists",
        `${path} already exists; send its current hash as If-Match to replace it.`,
        { current_hash },
      );
    }
  }

  private writeConcept(
    w: WriteState,
    input: string,
    content: ConceptContent,
    ifMatch?: string | null,
    ifNoneMatch?: boolean,
  ): OpResult {
    const path = this.conceptPath(input);
    if (isReserved(path)) {
      throw new OkfError(405, "reserved_path", `${basename(path)} is synthesized by the server.`);
    }
    const cur = this.pathRow(path);
    this.checkPreconditions(path, cur, ifMatch, ifNoneMatch, w.mode);
    const markdown =
      typeof content === "string"
        ? content
        : `---\n${yamlStringify(content.frontmatter ?? {})}---\n${content.body ?? ""}`;
    const curConcept = cur?.kind === "concept" ? cur : undefined;
    const storedVerified = curConcept ? this.verifiedAt(curConcept.concept_id, cur?.seq ?? 0) : [];
    const built = buildRecord(parseConcept(markdown), {
      path,
      mode: w.mode === "import" ? "import" : "write",
      actor: w.ctx.actor,
      now: w.now,
      stored: curConcept
        ? { generated: this.record(curConcept.hash).generated, verified: storedVerified }
        : null,
    });
    this.resolveTargets(built.record, path, w);
    const verified = w.mode === "import" ? built.verified : storedVerified;
    const size = utf8Length(renderConcept(built.record, { verified }));
    if (size > this.cap) {
      throw new OkfError(
        413,
        "concept_too_large",
        `${path} renders to ${size} bytes, over the ${this.cap}-byte concept cap. Split it into smaller concepts linked from a short overview.`,
      );
    }
    const hash = this.putRecord(built.record);
    const conceptId = cur?.concept_id ?? w.pending.get(path) ?? crypto.randomUUID();
    let seq = cur?.seq ?? 0;
    if (!cur || cur.hash !== hash) {
      seq = this.appendEvent(w.ctx, w.now, {
        op: w.mode === "import" ? "import" : "put",
        path,
        prev_hash: cur?.hash ?? null,
        hash,
        concept_id: conceptId,
        meta: w.source ? { source: w.source } : undefined,
      });
      this.setPath(path, conceptId, hash, "concept", seq, cur?.created_seq ?? seq);
      this.indexConcept(conceptId, path, built.record, built.lint, seq);
      this.healLinksTo(w, path, conceptId);
    }
    if (w.mode === "import") {
      for (const v of built.verified) {
        if (storedVerified.some((s) => s.by === v.by && s.at === v.at)) continue;
        seq = this.recordVerification(w, conceptId, path, hash, v);
      }
    }
    w.written.set(path, conceptId);
    return { op: w.mode === "import" ? "import" : "put", path, hash, seq, lint: built.lint };
  }

  private recordVerification(
    w: WriteState,
    conceptId: string,
    path: string,
    hash: string,
    v: Verification,
  ): number {
    const seq = this.appendEvent(w.ctx, w.now, {
      op: "verify",
      path,
      prev_hash: hash,
      hash,
      concept_id: conceptId,
      meta: { by: v.by, at: v.at },
    });
    this.sql.run(
      "INSERT INTO verifications (concept_id, by, at, seq) VALUES (?, ?, ?, ?)",
      conceptId,
      v.by,
      v.at,
      seq,
    );
    this.sql.run("UPDATE paths SET last_seq = ? WHERE concept_id = ?", seq, conceptId);
    return seq;
  }

  private writeAttachment(
    w: WriteState,
    input: string,
    blob: BlobRef,
    ifMatch?: string | null,
    ifNoneMatch?: boolean,
  ): OpResult {
    const path = normalizePath(input);
    if (!path) throw new OkfError(400, "bad_path", `Invalid path ${JSON.stringify(input)}.`);
    if (isReserved(path)) {
      throw new OkfError(405, "reserved_path", `${basename(path)} is synthesized by the server.`);
    }
    if (path.endsWith(".md")) {
      throw new OkfError(400, "bad_attachment", "Markdown files are concepts, not attachments.");
    }
    if (!/^[0-9a-f]{64}$/.test(blob.hash)) {
      throw new OkfError(400, "bad_blob", "Attachment hash must be a lowercase hex SHA-256.");
    }
    const cur = this.pathRow(path);
    this.checkPreconditions(path, cur, ifMatch, ifNoneMatch, w.mode);
    this.sql.run(
      "INSERT OR IGNORE INTO blobs (hash, size, location, content, media) VALUES (?, ?, 'r2', NULL, ?)",
      blob.hash,
      blob.size,
      blob.media,
    );
    const conceptId = cur?.concept_id ?? w.pending.get(path) ?? crypto.randomUUID();
    let seq = cur?.seq ?? 0;
    if (!cur || cur.hash !== blob.hash) {
      seq = this.appendEvent(w.ctx, w.now, {
        op: w.mode === "import" ? "import" : "put",
        path,
        prev_hash: cur?.hash ?? null,
        hash: blob.hash,
        concept_id: conceptId,
        meta: w.source ? { source: w.source } : undefined,
      });
      if (cur?.kind === "concept") this.unindex(cur.concept_id);
      this.setPath(path, conceptId, blob.hash, "attachment", seq, cur?.created_seq ?? seq);
      this.healLinksTo(w, path, conceptId);
    }
    return { op: w.mode === "import" ? "import" : "put", path, hash: blob.hash, seq, lint: [] };
  }

  /** Find-and-replace on the rendered document, frontmatter included (spec: PATCH /files). */
  private edit(
    w: WriteState,
    input: string,
    edits: { old: string; new: string }[],
    ifMatch?: string | null,
  ): OpResult {
    const p = normalizePath(input);
    const row = p ? this.lookupRow(p) : undefined;
    if (row?.kind !== "concept") throw notFound(input);
    if (ifMatch && ifMatch !== row.hash) {
      throw new OkfError(412, "precondition_failed", `${row.path} does not match If-Match.`, {
        current_hash: row.hash,
      });
    }
    if (!Array.isArray(edits) || edits.length === 0) {
      throw new OkfError(400, "no_edits", "Send at least one { old, new } edit.");
    }
    let doc = this.renderEntry(this.snapshot(undefined, true), row, false);
    for (const e of edits) {
      if (typeof e.old !== "string" || e.old === "" || typeof e.new !== "string") {
        throw new OkfError(
          400,
          "bad_edit",
          "Each edit needs a non-empty `old` and a string `new`.",
        );
      }
      const first = doc.indexOf(e.old);
      const count = first === -1 ? 0 : doc.split(e.old).length - 1;
      if (count !== 1) {
        throw new OkfError(
          409,
          "edit_mismatch",
          count === 0
            ? `\`old\` text not found in ${row.path}: ${JSON.stringify(e.old.slice(0, 80))}`
            : `\`old\` text matches ${count} times in ${row.path}; include more context so it matches once.`,
          { current_hash: row.hash, current: doc },
        );
      }
      doc = doc.slice(0, first) + e.new + doc.slice(first + e.old.length);
    }
    return this.writeConcept(w, row.path, doc, row.hash);
  }

  /** Moves a file, or every file under a directory prefix, one event each (spec: Moves). */
  private move(w: WriteState, input: string, toInput: string): OpResult {
    const from = normalizePath(input);
    const to = normalizePath(toInput);
    if (!from || !to) throw new OkfError(400, "bad_path", "Move needs valid `path` and `to`.");
    const single = this.lookupRow(from);
    let pairs: [PathRow, string][];
    if (single) {
      const dest = single.kind === "concept" && !to.endsWith(".md") ? `${to}.md` : to;
      pairs = [[single, dest]];
    } else {
      const rows = this.sql.all<PathRow>(
        "SELECT path, concept_id, hash, kind, last_seq AS seq, created_seq FROM paths WHERE path LIKE ? ESCAPE '\\' ORDER BY path",
        `${escapeLike(from)}/%`,
      );
      if (rows.length === 0) throw notFound(input);
      if (underPrefix(to, from)) {
        throw new OkfError(400, "bad_move", "Cannot move a directory into itself.");
      }
      pairs = rows.map((r) => [r, to + r.path.slice(from.length)]);
    }
    const moving = new Set(pairs.map(([r]) => r.path));
    for (const [row, dest] of pairs) {
      if (isReserved(dest)) {
        throw new OkfError(405, "reserved_path", `${basename(dest)} is synthesized by the server.`);
      }
      if (row.kind === "concept" && !isConceptPath(dest)) {
        throw new OkfError(400, "bad_path", `A concept path must end in .md: ${dest}.`);
      }
      if (row.kind === "attachment" && dest.endsWith(".md")) {
        throw new OkfError(400, "bad_path", `An attachment path cannot end in .md: ${dest}.`);
      }
      if (dest !== row.path && this.pathRow(dest) && !moving.has(dest)) {
        throw new OkfError(409, "path_exists", `Cannot move to ${dest}: a file is already there.`);
      }
    }
    for (const [row] of pairs) this.sql.run("DELETE FROM paths WHERE path = ?", row.path);
    let last: OpResult | null = null;
    for (const [row, dest] of pairs) {
      const seq = this.appendEvent(w.ctx, w.now, {
        op: "move",
        path: dest,
        prev_hash: row.hash,
        hash: row.hash,
        concept_id: row.concept_id,
        meta: { from_path: row.path },
      });
      this.setPath(dest, row.concept_id, row.hash, row.kind, seq, row.created_seq);
      this.sql.run(
        "INSERT INTO redirects (old_path, concept_id, since_seq) VALUES (?, ?, ?) ON CONFLICT(old_path) DO UPDATE SET concept_id = excluded.concept_id, since_seq = excluded.since_seq",
        row.path,
        row.concept_id,
        seq,
      );
      this.healLinksTo(w, dest, row.concept_id);
      last = { op: "move", path: dest, hash: row.hash, seq, lint: [] };
    }
    if (!last) throw notFound(input);
    return pairs.length === 1 ? last : { ...last, path: to };
  }

  private remove(w: WriteState, input: string, ifMatch?: string | null): OpResult {
    const p = normalizePath(input);
    const row = p ? this.lookupRow(p) : undefined;
    if (!row) throw notFound(input);
    if (!ifMatch) {
      throw new OkfError(428, "if_match_required", "Delete needs If-Match with the current hash.", {
        current_hash: row.hash,
      });
    }
    if (ifMatch !== row.hash) {
      throw new OkfError(412, "precondition_failed", `${row.path} does not match If-Match.`, {
        current_hash: row.hash,
      });
    }
    const seq = this.appendEvent(w.ctx, w.now, {
      op: "delete",
      path: row.path,
      prev_hash: row.hash,
      hash: null,
      concept_id: row.concept_id,
    });
    this.dropPath(w, row);
    return { op: "delete", path: row.path, hash: null, seq, lint: [] };
  }

  private dropPath(w: WriteState, row: PathRow) {
    this.sql.run("DELETE FROM paths WHERE path = ?", row.path);
    this.unindex(row.concept_id);
    for (const r of this.sql.all<{ from_id: string }>(
      "SELECT DISTINCT from_id FROM links WHERE to_id = ?",
      row.concept_id,
    )) {
      w.affected.add(r.from_id);
    }
  }

  // ---------------------------------------------------------------- revert

  private revertPath(w: WriteState, input: string, toSeq: number): OpResult[] {
    const p = normalizePath(input);
    if (!p) throw new OkfError(400, "bad_path", `Invalid path ${JSON.stringify(input)}.`);
    const then = this.snapshot(toSeq).lookup(p);
    const now = this.lookupRow(p);
    if (!then && !now) throw notFound(input);
    if (!then && now) return [this.restore(w, now.concept_id, now.path, null, toSeq)];
    if (!then) return [];
    if (now && now.concept_id !== then.concept_id) {
      throw new OkfError(
        409,
        "path_occupied",
        `${now.path} now holds a different file than at seq ${toSeq}; move or delete it first.`,
      );
    }
    const elsewhere = this.sql.all<PathRow>(
      "SELECT path FROM paths WHERE concept_id = ?",
      then.concept_id,
    )[0];
    if (!now && elsewhere) {
      throw new OkfError(
        409,
        "moved",
        `The file at ${then.path} as of seq ${toSeq} now lives at ${elsewhere.path}; revert that path, or move it back first.`,
      );
    }
    if (now && now.hash === then.hash) return [];
    return [this.restore(w, then.concept_id, then.path, then.hash, toSeq)];
  }

  private revertRequest(w: WriteState, requestId: string): OpResult[] {
    const events = this.sql.all<{ seq: number; concept_id: string; op: string }>(
      "SELECT seq, concept_id, op FROM events WHERE request_id = ? ORDER BY seq",
      requestId,
    );
    const first = events[0];
    if (!first) throw new OkfError(404, "not_found", `No request ${requestId}.`);
    const base = first.seq - 1;
    const before = this.snapshot(base);
    const ids = [...new Set(events.filter((e) => e.op !== "verify").map((e) => e.concept_id))];
    const plan = ids.map((id) => ({
      id,
      before: before.byId.get(id),
      now: this.sql.all<PathRow>(
        "SELECT path, concept_id, hash, kind, last_seq AS seq, created_seq FROM paths WHERE concept_id = ?",
        id,
      )[0],
    }));
    const results: OpResult[] = [];
    // Deletions first, then moves back, then content, so paths free up before they are reused.
    for (const { id, before: b, now } of plan) {
      if (!b && now) results.push(this.restore(w, id, now.path, null, base));
    }
    for (const { before: b, now } of plan) {
      if (b && now && now.path !== b.path) {
        const r = this.move(w, now.path, b.path);
        results.push(r);
      }
    }
    for (const { id, before: b } of plan) {
      if (!b) continue;
      const cur = this.sql.all<PathRow>(
        "SELECT path, concept_id, hash, kind, last_seq AS seq, created_seq FROM paths WHERE concept_id = ?",
        id,
      )[0];
      if (cur && cur.hash === b.hash) continue;
      results.push(this.restore(w, id, b.path, b.hash, base));
    }
    return results;
  }

  /** Points a concept at an earlier content version (or none) with a `revert` event. */
  private restore(
    w: WriteState,
    conceptId: string,
    path: string,
    hash: string | null,
    revertedSeq: number,
  ): OpResult {
    const cur = this.pathRow(path);
    if (cur && cur.concept_id !== conceptId) {
      throw new OkfError(409, "path_occupied", `Cannot restore ${path}: another file is there.`);
    }
    const seq = this.appendEvent(w.ctx, w.now, {
      op: "revert",
      path,
      prev_hash: cur?.hash ?? null,
      hash,
      concept_id: conceptId,
      meta: { reverted_seq: revertedSeq },
    });
    if (hash === null) {
      if (cur) this.dropPath(w, cur);
      return { op: "revert", path, hash, seq, lint: [] };
    }
    const info = this.blobInfo(hash);
    const kind: Kind = info.location === "r2" ? "attachment" : "concept";
    const created = this.sql.all<{ s: number }>(
      "SELECT MIN(seq) AS s FROM events WHERE concept_id = ?",
      conceptId,
    )[0]?.s;
    this.setPath(path, conceptId, hash, kind, seq, cur?.created_seq ?? created ?? seq);
    let lint: LintWarning[] = [];
    if (kind === "concept") {
      const r = this.record(hash);
      lint = this.fieldLint(r, path, this.verifiedAt(conceptId, seq));
      this.indexConcept(conceptId, path, r, lint, seq);
      w.written.set(path, conceptId);
    }
    this.healLinksTo(w, path, conceptId);
    return { op: "revert", path, hash, seq, lint };
  }

  // ---------------------------------------------------------------- derived indexes

  private setPath(
    path: string,
    id: string,
    hash: string,
    kind: Kind,
    seq: number,
    created: number,
  ) {
    this.sql.run("DELETE FROM paths WHERE concept_id = ? AND path <> ?", id, path);
    this.sql.run(
      `INSERT INTO paths (path, concept_id, hash, kind, last_seq, created_seq) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(path) DO UPDATE SET concept_id = excluded.concept_id, hash = excluded.hash,
         kind = excluded.kind, last_seq = excluded.last_seq, created_seq = excluded.created_seq`,
      path,
      id,
      hash,
      kind,
      seq,
      created,
    );
  }

  /** The concept a path names: an existing path, a file created in this request, or a redirect. */
  private resolvePath(p: string, w: WriteState): string | null {
    return (
      this.lookupRow(p)?.concept_id ??
      w.pending.get(p) ??
      (p.endsWith(".md") ? undefined : w.pending.get(`${p}.md`)) ??
      this.sql.all<{ concept_id: string }>(
        "SELECT r.concept_id FROM redirects r JOIN paths p ON p.concept_id = r.concept_id WHERE r.old_path IN (?, ?)",
        p,
        `${p}.md`,
      )[0]?.concept_id ??
      null
    );
  }

  /**
   * Resolves each body link and each internal `sources[].resource` of a record written at `path`
   * to a concept ID (spec: Concept model, Links).
   */
  private resolveTargets(r: ConceptRecord, path: string, w: WriteState) {
    for (const link of r.links) {
      if (isDerivedTarget(link)) continue;
      link.target = this.resolvePath(link.path, w);
    }
    const sources: StoredSource[] = [];
    for (const c of sourceCandidates(path, r.fm)) {
      const base = { index: c.index, raw: c.raw, anchor: c.anchor };
      let found: StoredSource | null = null;
      for (const o of c.options) {
        const target = this.resolvePath(o.path, w);
        if (target) {
          found = { ...base, ...o, target };
          break;
        }
      }
      if (!found && c.fallback) found = { ...base, ...c.fallback, target: null };
      if (found) sources.push(found);
    }
    if (sources.length > 0) r.sources = sources;
    else delete r.sources;
  }

  private indexConcept(
    id: string,
    path: string,
    r: ConceptRecord,
    lint: LintWarning[],
    seq: number,
  ) {
    const typed = new Set([
      "type",
      "title",
      "description",
      "resource",
      "status",
      "stale_after",
      "tags",
      "sources",
    ]);
    const extra = r.fm.filter(([k]) => !typed.has(k));
    const gen = r.generated;
    this.sql.run(
      `INSERT INTO concepts (concept_id, type, title, description, resource, status, stale_after,
         generated_by, generated_at, extra, lint)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(concept_id) DO UPDATE SET type = excluded.type, title = excluded.title,
         description = excluded.description, resource = excluded.resource, status = excluded.status,
         stale_after = excluded.stale_after, generated_by = excluded.generated_by,
         generated_at = excluded.generated_at, extra = excluded.extra, lint = excluded.lint`,
      id,
      str(field(r, "type")) ?? "",
      str(field(r, "title")),
      str(field(r, "description")),
      str(field(r, "resource")),
      effectiveStatus(field(r, "status")),
      str(field(r, "stale_after")),
      gen ? str(gen.by) : null,
      gen ? str(gen.at) : null,
      JSON.stringify(extra),
      JSON.stringify(lint),
    );
    const tags = tagsOf(r);
    this.sql.run("DELETE FROM tags WHERE concept_id = ?", id);
    for (const t of new Set(tags))
      this.sql.run("INSERT INTO tags (concept_id, tag) VALUES (?, ?)", id, t);

    this.sql.run("DELETE FROM links WHERE from_id = ?", id);
    for (const [l, kind] of linkGraph(r)) {
      this.sql.run(
        "INSERT INTO links (from_id, to_id, to_path, anchor, form, raw, kind) VALUES (?, ?, ?, ?, ?, ?, ?)",
        id,
        l.target,
        l.path,
        l.anchor,
        l.form,
        l.raw,
        kind,
      );
    }

    this.sql.run("DELETE FROM sources WHERE concept_id = ?", id);
    const sources = field(r, "sources");
    if (Array.isArray(sources)) {
      const counts = scanBody(r.body, path).footnoteCounts;
      sources.forEach((s, i) => {
        if (!s || typeof s !== "object" || Array.isArray(s)) return;
        const resource = str(s.resource);
        if (!resource) return;
        const sid = str(s.id);
        this.sql.run(
          "INSERT INTO sources (concept_id, id, resource, internal_id, cited) VALUES (?, ?, ?, ?, ?)",
          id,
          sid,
          resource,
          r.sources?.find((x) => x.index === i)?.target ?? null,
          sid ? (counts.get(sid) ?? 0) : 0,
        );
      });
    }

    this.sql.run("DELETE FROM fts WHERE concept_id = ?", id);
    this.sql.run(
      "INSERT INTO fts (concept_id, title, body, tags) VALUES (?, ?, ?, ?)",
      id,
      str(field(r, "title")) ?? "",
      r.body,
      tags.join(" "),
    );

    const nonLink = lint.filter((l) => l.code !== "broken_link");
    if (nonLink.length > 0) {
      this.sql.run(
        `INSERT INTO flags (concept_id, kind, since_seq, detail) VALUES (?, 'lint', ?, ?)
         ON CONFLICT(concept_id, kind) DO UPDATE SET detail = excluded.detail`,
        id,
        seq,
        JSON.stringify(nonLink),
      );
    } else {
      this.sql.run("DELETE FROM flags WHERE concept_id = ? AND kind = 'lint'", id);
    }
  }

  private unindex(id: string) {
    for (const t of ["concepts", "tags", "sources", "flags"]) {
      this.sql.run(`DELETE FROM ${t} WHERE concept_id = ?`, id);
    }
    this.sql.run("DELETE FROM links WHERE from_id = ?", id);
    this.sql.run("DELETE FROM fts WHERE concept_id = ?", id);
  }

  /** Points links written before `path` existed (or whose target was deleted) at its concept. */
  private healLinksTo(w: WriteState, path: string, id: string) {
    const variants = [path, path.endsWith(".md") ? path.slice(0, -3) : `${path}.md`];
    const where = `(to_path = ? OR to_path = ?) AND (to_id IS NULL OR to_id NOT IN (SELECT concept_id FROM paths))`;
    const from = this.sql.all<{ from_id: string }>(
      `SELECT DISTINCT from_id FROM links WHERE ${where}`,
      ...variants,
    );
    if (from.length === 0) return;
    this.sql.run(`UPDATE links SET to_id = ? WHERE ${where}`, id, ...variants);
    for (const r of from) w.affected.add(r.from_id);
  }

  /**
   * Recomputes a concept's broken links: its broken_link flag and the broken_link entries in its
   * stored lint. Returns them as lint.
   */
  private refreshBroken(id: string): LintWarning[] {
    const broken = this.sql.all<{ to_path: string; raw: string; kind: string }>(
      `SELECT to_path, raw, kind FROM links WHERE from_id = ?
         AND (to_id IS NULL OR to_id NOT IN (SELECT concept_id FROM paths))`,
      id,
    );
    const exists = this.sql.all("SELECT 1 FROM paths WHERE concept_id = ?", id).length > 0;
    const lint = exists ? broken.map((b) => brokenLink(b.kind, b.raw, b.to_path)) : [];
    const stored = this.sql.all<{ lint: string | null }>(
      "SELECT lint FROM concepts WHERE concept_id = ?",
      id,
    )[0];
    if (stored) {
      const others = (JSON.parse(stored.lint ?? "[]") as LintWarning[]).filter(
        (l) => l.code !== "broken_link",
      );
      this.sql.run(
        "UPDATE concepts SET lint = ? WHERE concept_id = ?",
        JSON.stringify([...others, ...lint]),
        id,
      );
    }
    if (lint.length === 0) {
      this.sql.run("DELETE FROM flags WHERE concept_id = ? AND kind = 'broken_link'", id);
      return [];
    }
    this.sql.run(
      `INSERT INTO flags (concept_id, kind, since_seq, detail) VALUES (?, 'broken_link', ?, ?)
       ON CONFLICT(concept_id, kind) DO UPDATE SET detail = excluded.detail`,
      id,
      this.headSeq(),
      JSON.stringify(broken.map((b) => b.to_path)),
    );
    return lint;
  }

  // ---------------------------------------------------------------- reads

  /** The href to render for a link, as of the snapshot (spec: Concept model, Reads and export). */
  private href(snap: Snapshot, from: Entry, link: StoredLink | StoredSource): string {
    if (isDerivedTarget(link)) return link.raw;
    const target = this.targetAt(snap, link);
    if (!target) return link.raw;
    const source = "index" in link;
    const angle = !source && link.raw.startsWith("<") && link.raw.endsWith(">");
    const written = splitAnchor(angle ? link.raw.slice(1, -1) : link.raw).path;
    const resolved =
      link.form === "root"
        ? normalizePath(safeDecode(written))
        : resolveLinkPath(from.path, safeDecode(written));
    if (resolved === target.path || `${resolved}.md` === target.path) return link.raw;
    let next: string;
    if (link.form === "absolute") next = `/${target.path}`;
    else if (link.form === "root") next = target.path;
    else {
      next = relativePath(from.path, target.path);
      if (written.startsWith("./") && !next.startsWith("../")) next = `./${next}`;
    }
    // A link written as a concept ID (no `.md`) keeps that form.
    if (!written.endsWith(".md") && next.endsWith(".md")) next = next.slice(0, -3);
    // A frontmatter value needs no URL escaping.
    if (source) return next + (link.anchor ?? "");
    next = angle ? next : next.replace(/[ ()]/g, (c) => encodeURIComponent(c));
    const out = next + (link.anchor ?? "");
    return angle ? `<${out}>` : out;
  }

  /** A link's target as of the snapshot: by ID, else by path, else through a redirect. */
  private targetAt(snap: Snapshot, link: { path: string; target: string | null }) {
    let target = link.target ? snap.byId.get(link.target) : undefined;
    if (!target) target = snap.lookup(link.path);
    if (!target) {
      const id = this.redirectAt(link.path, snap.seq);
      if (id) target = snap.byId.get(id);
    }
    return target;
  }

  /** Field lint of a content version, as a write of it would report (spec: OKF conformance). */
  private fieldLint(r: ConceptRecord, path: string, verified: Verification[]): LintWarning[] {
    if (r.raw_fm !== null) {
      return [
        { code: "unparseable_frontmatter", message: "Frontmatter could not be parsed as YAML." },
      ];
    }
    return lintFields(r.fm, r.generated, verified, scanBody(r.body, path));
  }

  /** Lint of a past version: its field lint and its links that were broken as of the snapshot. */
  private lintAt(snap: Snapshot, e: Entry, r: ConceptRecord, verified: Verification[]) {
    const lint = this.fieldLint(r, e.path, verified);
    for (const [l, kind] of linkGraph(r)) {
      if (!this.targetAt(snap, l)) lint.push(brokenLink(kind, l.raw, l.path));
    }
    return lint;
  }

  private renderEntry(snap: Snapshot, e: Entry, computed: boolean): string {
    const r = this.record(e.hash);
    const verified = this.verifiedAt(e.concept_id, snap.seq);
    return renderConcept(r, {
      verified,
      href: (l) => this.href(snap, e, l),
      sourceHref: (s) => this.href(snap, e, s),
      computed: computed ? this.computedValues(snap, e, r, verified) : undefined,
    });
  }

  private computedValues(snap: Snapshot, e: Entry, r: ConceptRecord, verified: Verification[]) {
    const out: [string, Json][] = [
      ["trust_tier", trustTier(r.generated, verified)],
      ["stale", isStale(field(r, "stale_after"), this.clock().getTime())],
    ];
    if (snap.seq === this.headSeq()) out.push(["inbound_links", this.inboundCount(e.concept_id)]);
    return out;
  }

  private inboundCount(id: string): number {
    return (
      this.sql.all<{ n: number }>(
        "SELECT COUNT(DISTINCT from_id) AS n FROM links WHERE to_id = ? AND from_id <> ?",
        id,
        id,
      )[0]?.n ?? 0
    );
  }

  /** GET /files/{path}: a concept, an attachment's metadata, or a synthesized index.md / log.md. */
  read(input: string, opts: { at?: number; computed?: boolean } = {}): FileView {
    const snap = this.snapshot(opts.at);
    const path = normalizePath(input) ?? "";
    const name = basename(path);
    if (path === "" || name === "index.md" || name === "log.md") {
      const dir = path === "" || name === "index.md" ? dirname(path) : dirname(path);
      if (name === "log.md") {
        return {
          kind: "derived",
          path,
          seq: snap.seq,
          markdown: this.log({ at: snap.seq, prefix: dir }),
        };
      }
      return {
        kind: "derived",
        path: path || "index.md",
        seq: snap.seq,
        markdown: this.index(dir, snap),
      };
    }
    const e = snap.lookup(path);
    if (!e) throw notFound(input);
    if (e.kind === "attachment") {
      const info = this.blobInfo(e.hash);
      return {
        kind: "attachment",
        path: e.path,
        hash: e.hash,
        seq: e.seq,
        size: info.size,
        media: info.media,
      };
    }
    const markdown = this.renderEntry(snap, e, opts.computed ?? false);
    const parsed = parseConcept(markdown);
    const r = this.record(e.hash);
    const verified = this.verifiedAt(e.concept_id, snap.seq);
    const frontmatter: JsonObject = Object.fromEntries(parsed.entries);
    if (parsed.generated) frontmatter.generated = parsed.generated;
    if (parsed.verified)
      frontmatter.verified = parsed.verified.map((v) => ({ by: v.by, at: v.at }));
    const atHead = snap.seq === this.headSeq();
    const lintRow = atHead
      ? this.sql.all<{ lint: string | null }>(
          "SELECT lint FROM concepts WHERE concept_id = ?",
          e.concept_id,
        )[0]
      : undefined;
    const lint: LintWarning[] = atHead
      ? JSON.parse(lintRow?.lint ?? "[]")
      : this.lintAt(snap, e, r, verified);
    return {
      kind: "concept",
      path: e.path,
      hash: e.hash,
      seq: e.seq,
      markdown,
      frontmatter,
      body: parsed.body,
      lint,
      trust_tier: trustTier(r.generated, verified),
      stale: isStale(field(r, "stale_after"), this.clock().getTime()),
      inbound_links: atHead ? this.inboundCount(e.concept_id) : 0,
    };
  }

  /** The synthesized index.md for a directory (spec: Tier 2). */
  index(dirInput: string, snapOrAt?: Snapshot | number): string {
    const snap = snapOrAt instanceof Snapshot ? snapOrAt : this.snapshot(snapOrAt);
    const dir = normalizeDir(dirInput);
    const subdirs = new Map<string, number>();
    const concepts: { path: string; title: string | null; description: string | null }[] = [];
    const attachments: { path: string }[] = [];
    let any = dir === "";
    for (const e of snap.sorted()) {
      if (!underPrefix(e.path, dir) || e.path === dir) continue;
      any = true;
      const rest = dir === "" ? e.path : e.path.slice(dir.length + 1);
      const slash = rest.indexOf("/");
      if (slash !== -1) {
        const name = rest.slice(0, slash);
        subdirs.set(name, (subdirs.get(name) ?? 0) + (e.kind === "concept" ? 1 : 0));
      } else if (e.kind === "concept") {
        const r = this.record(e.hash);
        concepts.push({
          path: e.path,
          title: str(field(r, "title")),
          description: str(field(r, "description")),
        });
      } else attachments.push({ path: e.path });
    }
    if (!any) throw notFound(dir ? `${dir}/index.md` : "index.md");
    return renderIndex({
      dir,
      subdirs: [...subdirs].map(([name, n]) => ({ name, concepts: n })),
      concepts,
      attachments,
    });
  }

  /** The synthesized log.md: requests newest first, grouped by day (spec: Tier 2). */
  log(opts: { at?: number; prefix?: string } = {}): string {
    const at = opts.at ?? this.headSeq();
    const prefix = normalizeDir(opts.prefix);
    const reqs = this.requestsUpTo(at, prefix);
    const out: LogRequest[] = reqs.map((r) => ({
      ts: r.ts,
      actor: r.actor,
      note: r.note,
      events: r.events.map((e) => ({ op: e.op, path: e.path, created: e.prev_hash === null })),
    }));
    return renderLog(out, prefix ? `Log: ${prefix}` : "Library log");
  }

  private requestsUpTo(at: number, prefix: string): RequestRow[] {
    const events = this.sql.all<EventRow & { meta: string | null }>(
      "SELECT * FROM events WHERE seq <= ? ORDER BY seq DESC",
      at,
    );
    const byReq = new Map<string, EventRow[]>();
    for (const e of events) {
      const row = { ...e, meta: e.meta ? (JSON.parse(e.meta) as JsonObject) : null };
      if (!underPrefix(e.path, prefix)) continue;
      const list = byReq.get(e.request_id) ?? [];
      list.push(row);
      byReq.set(e.request_id, list);
    }
    return [...byReq.entries()].map(([id, evs]) => this.toRequest(id, evs.reverse()));
  }

  private toRequest(id: string, events: EventRow[]): RequestRow {
    const first = events[0];
    return {
      request_id: id,
      ts: first?.ts ?? "",
      actor: first?.actor ?? "",
      note: (first?.meta?.note as string | undefined) ?? null,
      events,
    };
  }

  private row(snap: Snapshot, e: Entry): ConceptRow {
    if (e.kind === "attachment") {
      const info = this.blobInfo(e.hash);
      return {
        path: e.path,
        kind: e.kind,
        hash: e.hash,
        seq: e.seq,
        size: info.size,
        media: info.media,
      };
    }
    const r = this.record(e.hash);
    return {
      path: e.path,
      kind: e.kind,
      hash: e.hash,
      seq: e.seq,
      type: str(field(r, "type")) ?? "",
      title: str(field(r, "title")),
      description: str(field(r, "description")),
      status: effectiveStatus(field(r, "status")),
      tags: tagsOf(r),
      trust_tier: trustTier(r.generated, this.verifiedAt(e.concept_id, snap.seq)),
      stale: isStale(field(r, "stale_after"), this.clock().getTime()),
    };
  }

  /** GET /tree: files under a prefix; with `depth`, deeper levels collapse into directory entries. */
  tree(opts: { prefix?: string; depth?: number; at?: number } = {}) {
    const snap = this.snapshot(opts.at);
    const prefix = normalizeDir(opts.prefix);
    const entries: (ConceptRow | { path: string; kind: "dir"; files: number })[] = [];
    const dirs = new Map<string, number>();
    for (const e of snap.sorted()) {
      if (!underPrefix(e.path, prefix) || e.path === prefix) continue;
      const rest = prefix === "" ? e.path : e.path.slice(prefix.length + 1);
      const parts = rest.split("/");
      if (opts.depth !== undefined && parts.length > opts.depth) {
        const d = [prefix, ...parts.slice(0, opts.depth)].filter(Boolean).join("/");
        dirs.set(d, (dirs.get(d) ?? 0) + 1);
        continue;
      }
      entries.push(this.row(snap, e));
    }
    for (const [path, files] of dirs) entries.push({ path, kind: "dir", files });
    entries.sort((a, b) => (a.path < b.path ? -1 : 1));
    return { seq: snap.seq, entries };
  }

  /** GET /concepts: a frontmatter query; any combination of filters; paginated by offset. */
  concepts(
    q: {
      type?: string;
      tag?: string;
      status?: string;
      trust?: string;
      stale?: boolean;
      prefix?: string;
      at?: number;
      limit?: number;
      offset?: number;
    } = {},
  ) {
    const snap = this.snapshot(q.at);
    const prefix = normalizeDir(q.prefix);
    const limit = Math.min(Math.max(q.limit ?? 100, 1), 1000);
    const offset = Math.max(q.offset ?? 0, 0);
    const rows = snap
      .sorted()
      .filter((e) => e.kind === "concept" && underPrefix(e.path, prefix))
      .map((e) => this.row(snap, e))
      .filter(
        (r) =>
          (q.type === undefined || r.type === q.type) &&
          (q.tag === undefined || (r.tags ?? []).includes(q.tag)) &&
          (q.status === undefined || r.status === q.status) &&
          (q.trust === undefined || r.trust_tier === q.trust) &&
          (q.stale === undefined || r.stale === q.stale),
      );
    const items = rows.slice(offset, offset + limit);
    return {
      seq: snap.seq,
      total: rows.length,
      items,
      next_offset: offset + limit < rows.length ? offset + limit : null,
    };
  }

  /** GET /search: FTS over title, body and tags at head, ranked, with snippets. */
  search(q: string, opts: { prefix?: string; limit?: number } = {}) {
    const terms = q
      .split(/\s+/)
      .filter(Boolean)
      .map((t) => {
        const star = t.endsWith("*");
        const word = (star ? t.slice(0, -1) : t).replace(/"/g, '""');
        return word ? `"${word}"${star ? "*" : ""}` : "";
      })
      .filter(Boolean);
    if (terms.length === 0) throw new OkfError(400, "empty_query", "Send a search query in `q`.");
    const prefix = normalizeDir(opts.prefix);
    const limit = Math.min(Math.max(opts.limit ?? 20, 1), 200);
    const rows = this.sql.all<{ path: string; title: string; snippet: string; score: number }>(
      `SELECT paths.path AS path, fts.title AS title,
              snippet(fts, 2, '**', '**', '…', 16) AS snippet, bm25(fts) AS score
       FROM fts JOIN paths ON paths.concept_id = fts.concept_id
       WHERE fts MATCH ? AND (? = '' OR paths.path = ? OR paths.path LIKE ? ESCAPE '\\')
       ORDER BY score LIMIT ?`,
      terms.join(" "),
      prefix,
      prefix,
      `${escapeLike(prefix)}/%`,
      limit,
    );
    return { seq: this.headSeq(), results: rows };
  }

  /** GET /grep: literal or regex match over rendered concepts, frontmatter included, like grep -n. */
  grep(
    pattern: string,
    opts: { regex?: boolean; prefix?: string; limit?: number; at?: number } = {},
  ) {
    if (!pattern) throw new OkfError(400, "empty_pattern", "Send a pattern.");
    let test: (line: string) => boolean;
    if (opts.regex) {
      let re: RegExp;
      try {
        re = new RegExp(pattern);
      } catch (e) {
        throw new OkfError(400, "bad_regex", `Invalid regular expression: ${(e as Error).message}`);
      }
      test = (line) => re.test(line);
    } else test = (line) => line.includes(pattern);
    const snap = this.snapshot(opts.at);
    const prefix = normalizeDir(opts.prefix);
    const limit = Math.min(Math.max(opts.limit ?? 100, 1), 1000);
    const matches: { path: string; line: number; text: string }[] = [];
    let truncated = false;
    outer: for (const e of snap.sorted()) {
      if (e.kind !== "concept" || !underPrefix(e.path, prefix)) continue;
      const lines = this.renderEntry(snap, e, false).split("\n");
      for (let i = 0; i < lines.length; i++) {
        const text = lines[i] ?? "";
        if (!test(text)) continue;
        if (matches.length >= limit) {
          truncated = true;
          break outer;
        }
        matches.push({ path: e.path, line: i + 1, text });
      }
    }
    return { seq: snap.seq, matches, truncated };
  }

  /** GET /links: outbound links with current targets, inbound links, and broken ones. */
  links(input: string) {
    const snap = this.snapshot();
    const e = snap.lookup(normalizePath(input) ?? "");
    if (e?.kind !== "concept") throw notFound(input);
    const r = this.record(e.hash);
    const outbound: { raw: string; path: string; anchor: string | null; kind: LinkKind }[] = [];
    const broken: { raw: string; path: string; kind: LinkKind }[] = [];
    for (const [l, kind] of linkGraph(r)) {
      const target = this.targetAt(snap, l);
      if (target) outbound.push({ raw: l.raw, path: target.path, anchor: l.anchor, kind });
      else broken.push({ raw: l.raw, path: l.path, kind });
    }
    const inbound = this.sql
      .all<{ from_id: string; raw: string; anchor: string | null; kind: LinkKind }>(
        "SELECT from_id, raw, anchor, kind FROM links WHERE to_id = ? AND from_id <> ?",
        e.concept_id,
        e.concept_id,
      )
      .flatMap((l) => {
        const from = snap.byId.get(l.from_id)?.path;
        return from ? [{ path: from, raw: l.raw, anchor: l.anchor, kind: l.kind }] : [];
      })
      .sort((a, b) => (a.path < b.path ? -1 : 1));
    return { path: e.path, outbound, inbound, broken };
  }

  /** GET /events: the change feed, ascending by seq. */
  events(opts: { since?: number; prefix?: string; actor?: string; limit?: number } = {}) {
    const prefix = normalizeDir(opts.prefix);
    const limit = Math.min(Math.max(opts.limit ?? 100, 1), 1000);
    const rows = this.sql.all<EventRow & { meta: string | null }>(
      `SELECT * FROM events WHERE seq > ?
         AND (? = '' OR path = ? OR path LIKE ? ESCAPE '\\')
         AND (? IS NULL OR actor = ?)
       ORDER BY seq LIMIT ?`,
      opts.since ?? 0,
      prefix,
      prefix,
      `${escapeLike(prefix)}/%`,
      opts.actor ?? null,
      opts.actor ?? null,
      limit,
    );
    const events = rows.map((e) => ({
      ...e,
      meta: e.meta ? (JSON.parse(e.meta) as JsonObject) : null,
    }));
    const last = events.at(-1)?.seq;
    return { head: this.headSeq(), events, next: events.length === limit && last ? last : null };
  }

  /**
   * GET /requests: requests newest first, each with its events. `before` is a seq cursor for
   * paging back; `since` keeps only requests that started after that seq.
   */
  requests(opts: { before?: number; since?: number; prefix?: string; limit?: number } = {}) {
    const prefix = normalizeDir(opts.prefix);
    const limit = Math.min(Math.max(opts.limit ?? 20, 1), 200);
    const ids = this.sql.all<{ request_id: string; last: number }>(
      `SELECT request_id, MIN(seq) AS first, MAX(seq) AS last FROM events
       WHERE (? = '' OR path = ? OR path LIKE ? ESCAPE '\\')
       GROUP BY request_id HAVING last < ? AND first > ? ORDER BY last DESC LIMIT ?`,
      prefix,
      prefix,
      `${escapeLike(prefix)}/%`,
      opts.before ?? Number.MAX_SAFE_INTEGER,
      opts.since ?? 0,
      limit,
    );
    const requests = ids.map((r) => this.request(r.request_id));
    const last = ids.at(-1)?.last;
    return { requests, next: ids.length === limit && last ? last : null };
  }

  request(id: string): RequestRow {
    const rows = this.sql.all<EventRow & { meta: string | null }>(
      "SELECT * FROM events WHERE request_id = ? ORDER BY seq",
      id,
    );
    if (rows.length === 0) throw new OkfError(404, "not_found", `No request ${id}.`);
    return this.toRequest(
      id,
      rows.map((e) => ({ ...e, meta: e.meta ? (JSON.parse(e.meta) as JsonObject) : null })),
    );
  }

  /** GET /history: every event for the path's concept, across moves. */
  history(input: string) {
    const p = normalizePath(input) ?? "";
    let id = this.lookupRow(p)?.concept_id;
    if (!id) {
      id = this.sql.all<{ concept_id: string }>(
        "SELECT concept_id FROM events WHERE path IN (?, ?) ORDER BY seq DESC LIMIT 1",
        p,
        `${p}.md`,
      )[0]?.concept_id;
    }
    if (!id) throw notFound(input);
    const rows = this.sql.all<EventRow & { meta: string | null }>(
      "SELECT * FROM events WHERE concept_id = ? ORDER BY seq",
      id,
    );
    return {
      path: this.pathOf(id) ?? p,
      events: rows.map((e) => ({ ...e, meta: e.meta ? (JSON.parse(e.meta) as JsonObject) : null })),
    };
  }

  private pathOf(id: string): string | undefined {
    return this.sql.all<{ path: string }>("SELECT path FROM paths WHERE concept_id = ?", id)[0]
      ?.path;
  }

  /** The library as a conformant bundle at `at`, with index.md and log.md synthesized. */
  exportBundle(at?: number): { seq: number; files: ExportFile[] } {
    const snap = this.snapshot(at);
    const files: ExportFile[] = [];
    const dirs = new Set<string>([""]);
    for (const e of snap.sorted()) {
      for (let d = dirname(e.path); d !== ""; d = dirname(d)) dirs.add(d);
      if (e.kind === "concept")
        files.push({ path: e.path, text: this.renderEntry(snap, e, false) });
      else {
        const info = this.blobInfo(e.hash);
        files.push({ path: e.path, blob: { hash: e.hash, size: info.size, media: info.media } });
      }
    }
    for (const d of [...dirs].sort()) {
      files.push({ path: d ? `${d}/index.md` : "index.md", text: this.index(d, snap) });
    }
    files.push({ path: "log.md", text: this.log({ at: snap.seq }) });
    return { seq: snap.seq, files };
  }

  // ---------------------------------------------------------------- tier 2: beyond files

  /** GET /sources: a concept's sources with footnote counts and internal targets' signals. */
  sources(input: string) {
    const snap = this.snapshot();
    const e = snap.lookup(normalizePath(input) ?? "");
    if (e?.kind !== "concept") throw notFound(input);
    const r = this.record(e.hash);
    const counts = scanBody(r.body, e.path).footnoteCounts;
    const list = field(r, "sources");
    const ids = new Set<string>();
    const sources: JsonObject[] = [];
    for (const [i, s] of (Array.isArray(list) ? list : []).entries()) {
      if (!s || typeof s !== "object" || Array.isArray(s)) continue;
      const id = str(s.id);
      if (id) ids.add(id);
      const stored = r.sources?.find((x) => x.index === i);
      const target = stored ? this.targetAt(snap, stored) : undefined;
      let internal: JsonObject | null = null;
      if (target?.kind === "concept") {
        const tr = this.record(target.hash);
        internal = {
          path: target.path,
          trust_tier: trustTier(tr.generated, this.verifiedAt(target.concept_id, snap.seq)),
          stale: isStale(field(tr, "stale_after"), this.clock().getTime()),
          status: effectiveStatus(field(tr, "status")),
          inbound_links: this.inboundCount(target.concept_id),
        };
      } else if (target) internal = { path: target.path };
      else if (stored) internal = { path: stored.path, broken: true };
      // The resource as rendered: an internal one shows its target's current path.
      const entry: JsonObject = { ...s };
      if (stored) entry.resource = this.href(snap, e, stored);
      sources.push({ ...entry, cited: id ? (counts.get(id) ?? 0) : 0, internal });
    }
    return {
      path: e.path,
      sources,
      unmatched_footnotes: [...counts.keys()].filter((label) => !ids.has(label)),
    };
  }

  /**
   * GET /diff: unified diff of a concept's rendering between two sequences. `to` defaults to head;
   * `from` defaults to just before the concept's latest content change at or before `to`.
   */
  diff(input: string, opts: { from?: number; to?: number } = {}) {
    const p = normalizePath(input) ?? "";
    const to = opts.to ?? this.headSeq();
    const snapTo = this.snapshot(to);
    const id = snapTo.lookup(p)?.concept_id ?? this.lastConceptAt(p);
    if (!id) throw notFound(input);
    let from = opts.from;
    if (from === undefined) {
      const last = this.sql.all<{ seq: number }>(
        "SELECT seq FROM events WHERE concept_id = ? AND seq <= ? AND op NOT IN ('move', 'verify') ORDER BY seq DESC LIMIT 1",
        id,
        to,
      )[0];
      from = last ? last.seq - 1 : 0;
    }
    const snapFrom = this.snapshot(from);
    const a = snapFrom.byId.get(id);
    const b = snapTo.byId.get(id);
    const text = (snap: Snapshot, e: Entry | undefined) => {
      if (!e) return "";
      if (e.kind === "concept") return this.renderEntry(snap, e, false);
      return `(attachment ${e.hash})\n`;
    };
    const label = (e: Entry | undefined, seq: number) =>
      e ? `${e.path}@${seq}` : `/dev/null@${seq}`;
    return {
      path: (b ?? a)?.path ?? p,
      from,
      to,
      diff: unifiedDiff(text(snapFrom, a), text(snapTo, b), {
        from: label(a, from),
        to: label(b, to),
      }),
    };
  }

  private lastConceptAt(path: string): string | undefined {
    return this.sql.all<{ concept_id: string }>(
      "SELECT concept_id FROM events WHERE path IN (?, ?) ORDER BY seq DESC LIMIT 1",
      path,
      `${path}.md`,
    )[0]?.concept_id;
  }

  /**
   * GET /work: the work queue (spec: Write path and maintainers). Stale concepts are computed at
   * read time until the staleness maintainer arrives; broken links and lint come from flags.
   * Ranked by inbound links, then age.
   */
  work(opts: { kind?: string; limit?: number } = {}) {
    const snap = this.snapshot();
    const now = this.clock().getTime();
    const limit = Math.min(Math.max(opts.limit ?? 50, 1), 500);
    const items: WorkItem[] = [];
    const want = (k: string) => opts.kind === undefined || opts.kind === k;
    if (want("stale")) {
      for (const e of snap.sorted()) {
        if (e.kind !== "concept") continue;
        const staleAfter = field(this.record(e.hash), "stale_after");
        if (!isStale(staleAfter, now)) continue;
        items.push({
          kind: "stale",
          path: e.path,
          since: String(staleAfter),
          detail: `stale_after ${String(staleAfter)} has passed`,
          suggested_action:
            "Re-check the concept against its sources and resource. Update it (which restamps generated) and move stale_after forward, or set status: deprecated if it no longer holds.",
          inbound_links: this.inboundCount(e.concept_id),
        });
      }
    }
    const flags = this.sql.all<{
      concept_id: string;
      kind: string;
      since_seq: number;
      detail: string;
    }>(
      "SELECT f.concept_id, f.kind, f.since_seq, f.detail FROM flags f JOIN paths p ON p.concept_id = f.concept_id",
    );
    for (const f of flags) {
      if (!want(f.kind)) continue;
      const e = snap.byId.get(f.concept_id);
      if (!e) continue;
      const since =
        this.sql.all<{ ts: string }>("SELECT ts FROM events WHERE seq = ?", f.since_seq)[0]?.ts ??
        "";
      let detail = f.detail;
      let action = "Fix the frontmatter or body with edit; the lint messages say what is wrong.";
      if (f.kind === "broken_link") {
        const targets = JSON.parse(f.detail) as string[];
        detail = `links to missing ${targets.map((t) => `/${t}`).join(", ")}`;
        action =
          "Write the missing concept, point the link at an existing one, or remove the link.";
      } else if (f.kind === "lint") {
        detail = (JSON.parse(f.detail) as LintWarning[]).map((l) => l.message).join(" ");
      }
      items.push({
        kind: f.kind,
        path: e.path,
        since,
        detail,
        suggested_action: action,
        inbound_links: this.inboundCount(e.concept_id),
      });
    }
    items.sort((a, b) => b.inbound_links - a.inbound_links || (a.since < b.since ? -1 : 1));
    return { seq: snap.seq, total: items.length, items: items.slice(0, limit) };
  }

  /**
   * POST /verify: adds `{ by, at }` to `verified` as one verify event; the content version is
   * unchanged (spec: OKF conformance). Only `human:` and `process:` actors may verify.
   */
  verify(ctx: RequestContext, input: string): WriteResult {
    if (!ctx.actor.startsWith("human:") && !ctx.actor.startsWith("process:")) {
      throw new OkfError(
        403,
        "cannot_verify",
        "Only human: and process: actors may verify; agents do not claim verification.",
      );
    }
    return this.guard(() =>
      this.sql.transaction(() => {
        const w = this.begin(ctx);
        const p = normalizePath(input);
        const row = p ? this.lookupRow(p) : undefined;
        if (row?.kind !== "concept") throw notFound(input);
        const seq = this.recordVerification(w, row.concept_id, row.path, row.hash, {
          by: ctx.actor,
          at: w.now,
        });
        return {
          request_id: ctx.request_id,
          seq,
          results: [{ op: "verify", path: row.path, hash: row.hash, seq, lint: [] }],
        };
      }),
    );
  }

  /** Counts for the MCP `start` entry point. */
  summary() {
    const snap = this.snapshot();
    const types: Record<string, number> = {};
    let concepts = 0;
    let attachments = 0;
    for (const e of snap.byPath.values()) {
      if (e.kind === "attachment") {
        attachments++;
        continue;
      }
      concepts++;
      const t = str(field(this.record(e.hash), "type")) || "(no type)";
      types[t] = (types[t] ?? 0) + 1;
    }
    return {
      seq: snap.seq,
      concepts,
      attachments,
      types,
      open_work: this.work({ limit: 1 }).total,
    };
  }

  // ---------------------------------------------------------------- signed download URLs

  /** A per-library HMAC key, created on first use; it never leaves the object. */
  private signingKey(): Uint8Array {
    const row = this.sql.all<{ value: string }>(
      "SELECT value FROM meta WHERE key = 'signing_key'",
    )[0];
    if (row) return hexToBytes(row.value);
    const key = randomBytes(32);
    this.sql.run("INSERT INTO meta (key, value) VALUES ('signing_key', ?)", bytesToHex(key));
    return key;
  }

  /** A short-lived token for a download URL: a file's bytes or an export at a seq. */
  signDownload(payload: DownloadPayload, ttlSeconds = 900): string {
    const exp = Math.floor(this.clock().getTime() / 1000) + ttlSeconds;
    const body = b64url(new TextEncoder().encode(JSON.stringify({ ...payload, exp })));
    return `${body}.${b64url(hmac(sha256, this.signingKey(), new TextEncoder().encode(body)))}`;
  }

  /** Checks a download token's signature and expiry. */
  openDownload(token: string): DownloadPayload {
    const [body, sig] = token.split(".");
    const bad = new OkfError(403, "bad_download", "This download link is invalid or has expired.");
    if (!body || !sig) throw bad;
    const expected = b64url(hmac(sha256, this.signingKey(), new TextEncoder().encode(body)));
    if (expected.length !== sig.length || !equalBytes(expected, sig)) throw bad;
    let payload: DownloadPayload & { exp: number };
    try {
      payload = JSON.parse(new TextDecoder().decode(fromB64url(body)));
    } catch {
      throw bad;
    }
    if (payload.exp * 1000 < this.clock().getTime()) throw bad;
    return payload;
  }
}

export type DownloadPayload =
  | { k: "file"; path: string; hash: string; media: string | null }
  | { k: "export"; at: number };

export interface WorkItem {
  kind: string;
  path: string;
  since: string;
  detail: string;
  suggested_action: string;
  inbound_links: number;
}

function b64url(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromB64url(s: string): Uint8Array {
  const bin = atob(s.replace(/-/g, "+").replace(/_/g, "/"));
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

/** Constant-time string comparison. */
function equalBytes(a: string, b: string): boolean {
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

type WriteMode = "write" | "import";

interface WriteState {
  ctx: RequestContext;
  now: string;
  mode: WriteMode;
  source: string | null;
  /** Paths created by this request, with pre-assigned concept IDs. */
  pending: Map<string, string>;
  /** Paths written by this request and their concept IDs. */
  written: Map<string, string>;
  /** Concepts whose outbound links changed state, for flag refresh. */
  affected: Set<string>;
}
