import { hmac } from "@noble/hashes/hmac.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, hexToBytes, randomBytes } from "@noble/hashes/utils.js";
import {
  ATOM,
  type Doc,
  docText,
  headingIds,
  linkTarget,
  locate,
  occurrences,
  quoteText,
  selectorAt,
  toMarkdown,
  walk as walkDoc,
} from "@tempra/editor/doc";
import { stringify as yamlStringify } from "yaml";
import { PELE_MESSAGE_FORMAT } from "../../render/src/message";
import { PELE_VERSION, VEGA_LITE_VERSION } from "../../render/src/version";
import { type LogRequest, renderIndex, renderLog } from "../format/derived";
import {
  chartRenderWarning,
  checkedCharts,
  checkedFences,
  diagramLint,
  type RenderFailure,
  unrenderedWarning,
} from "../format/diagrams";
import { unifiedDiff, unifiedDiffExcept } from "../format/diff";
import { figureLint } from "../format/figure-lint";
import { type FigureFact, figureFacts } from "../format/figures";
import { sha256Hex } from "../format/hash";
import { IMAGE_TARGET_CODES, imageLinks, imageLint, imageTargetLint } from "../format/images";
import { danglingFootnotes, FOOTNOTE_CODES, sameLint, sameTargets } from "../format/link-health";
import { lintFields } from "../format/lint";
import { scanDoc } from "../format/markdown";
import {
  buildRecord,
  deserializeRecord,
  field,
  type ParsedPage,
  parsePage,
  renderDoc,
  renderPage,
  serializeRecord,
  sourceCandidates,
  unaliasSourceUrls,
} from "../format/page";
import {
  basename,
  dirname,
  isPagePath,
  isReserved,
  normalizeDir,
  normalizePath,
  relativePath,
  resolveLinkPath,
  safeDecode,
  splitAnchor,
  underPrefix,
} from "../format/paths";
import {
  checkStructure,
  dirIndex,
  dirKey,
  isDirKey,
  type StructureEntry,
  type StructureIssue,
  structureAction,
} from "../format/structure";
import {
  effectiveStatus,
  isStale,
  STALE_SOON_DAYS,
  type Staleness,
  staleness,
  staleTime,
  trustTier,
} from "../format/trust";
import type {
  Json,
  JsonObject,
  LintWarning,
  PageRecord,
  StoredLink,
  StoredSource,
  TrustTier,
  Verification,
} from "../format/types";
import { wordChange } from "../format/words";
import {
  type ActionBy,
  type CommentAction,
  type CommentResult,
  type CommentView,
  checkQuote,
  commentBody,
  type Mention,
  type StoredAnchor,
  type ThreadAction,
  type ThreadStatus,
  type ThreadView,
  threadKind,
} from "./comments";
import { notFound, StoreError } from "./errors";
import {
  READ_WEEK_DAYS,
  type ReadHistory,
  type Reading,
  type ReadRow,
  type ReadSurface,
  readHistory,
} from "./reads";
import { COST_INDEXES, DIAGRAM_RENDERS, LEDGER_COUNTS, migrate } from "./schema";
import type { SqlHandle, Row as SqlRow, SqlValue } from "./sql";

/** Pages over this many bytes of rendered markdown are refused (spec: the page format). */
export const DEFAULT_PAGE_CAP = 100 * 1024;

export interface RequestContext {
  actor: string;
  request_id: string;
  note?: string | null;
  /**
   * The person (users row id) and agent behind the actor (tempra-dev:
   * decisions/agents-act-for-a-person), kept in each event's meta as `by`.
   */
  by?: { person: string; agent?: string } | null;
}

/**
 * Provenance of an attachment fetched from a URL (TEMPRA-157): kept in the attach op's ledger
 * meta as `source`, and read back for the version on screen (`read`); never a citation.
 */
/**
 * An attachment made on the server from another one (TEMPRA-208, MCP `transform`): the file it was
 * made from at the hash it had, and what was done (`resize 1092`, `crop 10,20 300x200`,
 * `convert webp`, `thumbnail 320`, `poster 2.5s`). Kept in the attach op's meta as `made_from`.
 */
export interface MadeFrom {
  path: string;
  hash: string;
  op: string;
}

export interface AttachSource {
  via: "url";
  url: string;
  /** Where the bytes were after redirects, when that differs from `url`. */
  final_url?: string;
  fetched_at: string;
}

/** An attachment's description is short: a line or two for its page (TEMPRA-170). */
export const DESCRIPTION_MAX = 500;
/** Credit and licence are a line each, free text (TEMPRA-170; no licence picker). */
export const CREDIT_MAX = 200;

/** What a writer may say about an attachment version, kept in its attach op's ledger meta. */
export interface AttachFacts {
  /** What the file shows. */
  description?: string;
  /** Who made it, as it should be credited. */
  credit?: string;
  /** Its licence, as free text ("CC BY-SA 4.0"). */
  licence?: string;
}

/** A short text as given: trimmed, at most `max` characters; empty is none. */
function checkText(name: string, d: unknown, max: number): string | undefined {
  if (d === undefined || d === null) return undefined;
  if (typeof d !== "string") {
    throw new StoreError(400, `bad_${name}`, `\`${name}\` is a short text.`);
  }
  const t = d.trim();
  if (t.length > max) {
    throw new StoreError(
      400,
      `bad_${name}`,
      `\`${name}\` is at most ${max} characters; this one is ${t.length}.`,
    );
  }
  return t === "" ? undefined : t;
}

/** A description as given: trimmed, at most DESCRIPTION_MAX characters; empty is none. */
export function checkDescription(d: unknown): string | undefined {
  return checkText("description", d, DESCRIPTION_MAX);
}

/** An attachment's description, credit and licence as given, checked; only those set. */
export function checkFacts(input: {
  description?: unknown;
  credit?: unknown;
  licence?: unknown;
}): AttachFacts {
  const out: AttachFacts = {};
  const description = checkDescription(input.description);
  const credit = checkText("credit", input.credit, CREDIT_MAX);
  const licence = checkText("licence", input.licence, CREDIT_MAX);
  if (description !== undefined) out.description = description;
  if (credit !== undefined) out.credit = credit;
  if (licence !== undefined) out.licence = licence;
  return out;
}

function checkSource(s: AttachSource): void {
  if (
    s?.via !== "url" ||
    typeof s.url !== "string" ||
    !s.url.startsWith("https://") ||
    typeof s.fetched_at !== "string" ||
    (s.final_url !== undefined && typeof s.final_url !== "string")
  ) {
    throw new StoreError(
      400,
      "bad_source",
      "An attachment's source is the URL it was fetched from.",
    );
  }
}

export interface BlobRef {
  hash: string;
  size: number;
  media: string | null;
  /** An image's size in pixels, from its header (TEMPRA-152; `checkAttachment` in media.ts). */
  width?: number;
  height?: number;
  /** What the writer should know about the type (the declared one was ignored); not stored. */
  note?: string;
}

/**
 * A page to write: markdown (agents, import), or the app's frontmatter and stored tree,
 * whose block IDs are kept where they name blocks of the current version.
 */
export type PageContent = string | { frontmatter: JsonObject; doc: Doc };

export type WriteOp =
  | {
      op: "write";
      path: string;
      content: PageContent;
      if_match?: string | null;
      if_none_match?: boolean;
    }
  | {
      op: "attach";
      path: string;
      blob: BlobRef;
      if_match?: string | null;
      if_none_match?: boolean;
      /** Where the bytes came from, when the Worker fetched them (TEMPRA-157). */
      source?: AttachSource;
      /** What the file shows, in the writer's words (at most DESCRIPTION_MAX characters). */
      description?: string;
      /** Who made it and its licence, free text (at most CREDIT_MAX characters each). */
      credit?: string;
      licence?: string;
      /**
       * The handle of the person whose browser sent the bytes for the agent's prepared upload
       * (TEMPRA-196, the upload link); the write stays the agent's.
       */
      supplied_by?: string;
      /**
       * Who had the file for an upload (TEMPRA-205): the person, or the agent that made it and
       * handed it to the person to send. Kept in the event's meta; does not make a write.
       */
      origin?: "person" | "agent";
      /** What it was made from on the server (TEMPRA-208). */
      made_from?: MadeFrom;
    }
  | { op: "edit"; path: string; edits: { old: string; new: string }[]; if_match?: string | null }
  | { op: "move"; path: string; to: string }
  | { op: "delete"; path: string; if_match?: string | null };

export interface OpResult {
  op: string;
  path: string;
  /** move: where the file was. */
  from?: string;
  hash: string | null;
  seq: number;
  lint: LintWarning[];
  /**
   * What the writer should know that is not stored as lint: fields the server ignored, a
   * `stale_after` already past, the page's open comment threads, a link to a missing heading.
   */
  notices?: LintWarning[];
  /** A unified diff from what was sent to what is stored, when the server normalized it. */
  normalized?: string;
}

export interface WriteResult {
  request_id: string;
  seq: number;
  results: OpResult[];
  /** For the Worker's after-commit step (notify.ts), which strips it before answering. */
  notify?: WriteNotice;
  /** Diagrams for the render service to try after the commit (render-lint.ts), also stripped. */
  render?: RenderJob[];
}

/**
 * The diagrams of one written page version that the fast check passed and whose verdict from
 * Pele the library does not know yet (TEMPRA-167), keyed by Pele's version and their source's SHA-256.
 */
export interface RenderJob {
  page_id: string;
  path: string;
  hash: string;
  /** Each with its language when it is not Mermaid (a chart, TEMPRA-207). */
  diagrams: { key: string; source: string; lang?: "vega-lite" }[];
}

/** Pele's verdict on a diagram's source: null when it draws, else where and why it failed. */
export interface RenderVerdict {
  key: string;
  error: RenderFailure | null;
}

/** At most this many diagrams of a request go to the render service; the rest wait for a write. */
export const RENDERS_PER_WRITE = 10;

/**
 * What a committed write means for the people of the library (TEMPRA-116; tempra-dev:
 * v2/notifications): the pages whose content changed, with who had verified each before the
 * change (a person's verification only, TEMPRA-111's rule) and how many content changes came
 * since; verifications by a person; moves. The Worker turns it into Inbox items and closes.
 */
export interface WriteNotice {
  changed: {
    path: string;
    title: string | null;
    deleted: boolean;
    /** People whose latest verification this write superseded: users id when known, actor. */
    verifiers: { person: string | null; actor: string; changes: number }[];
  }[];
  verified: { path: string; person: string | null; actor: string }[];
  moved: { from: string; to: string }[];
}

export type ImportFile = { path: string; markdown: string } | { path: string; blob: BlobRef };

export interface ImportResult {
  request_id: string;
  seq: number;
  files: number;
  skipped: string[];
  warnings: { path: string; lint: LintWarning[] }[];
  notify?: WriteNotice;
  render?: RenderJob[];
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
  page_id: string;
  meta: JsonObject | null;
}

export interface RequestRow {
  request_id: string;
  ts: string;
  actor: string;
  note: string | null;
  /** The person and agent behind the actor, when recorded (from 2026-10, TEMPRA-75). */
  by: { person: string; agent?: string } | null;
  events: EventRow[];
}

export type Kind = "page" | "attachment";

interface Entry {
  path: string;
  page_id: string;
  hash: string;
  kind: Kind;
  seq: number;
}

interface PathRow extends Entry {
  created_seq: number;
}

/** What resolving a link reads of a library at a seq: a file by id or by path. */
interface View {
  readonly seq: number;
  readonly byId: { get(id: string): Entry | undefined };
  lookup(path: string): Entry | undefined;
}

/** The path-to-hash map of a library as of a sequence number (spec: The ledger, Snapshots). */
class Snapshot implements View {
  readonly byPath = new Map<string, Entry>();
  readonly byId = new Map<string, Entry>();
  constructor(
    public seq: number,
    entries: Entry[],
  ) {
    for (const e of entries) {
      this.byPath.set(e.path, e);
      this.byId.set(e.page_id, e);
    }
  }

  /**
   * Moves a head snapshot to `seq` in place (TEMPRA-87): the files of `ids` as they stand now
   * (`rows`; an id with no row was deleted). Every change to `paths` is an event naming its
   * page, so the ids a write's events name are all that can differ.
   */
  advance(seq: number, ids: Iterable<string>, rows: Entry[]) {
    for (const id of ids) {
      const old = this.byId.get(id);
      if (!old) continue;
      this.byId.delete(id);
      if (this.byPath.get(old.path)?.page_id === id) this.byPath.delete(old.path);
    }
    for (const e of rows) {
      this.byPath.set(e.path, e);
      this.byId.set(e.page_id, e);
    }
    this.seq = seq;
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

/**
 * The head as `paths` holds it, looked up file by file with its indexes: what a write reads to
 * resolve its own pages' links, in place of a snapshot of every file (TEMPRA-87).
 */
class LiveView implements View {
  private readonly ids = new Map<string, Entry | undefined>();
  private readonly paths = new Map<string, Entry | undefined>();
  readonly byId = { get: (id: string) => this.one(this.ids, "page_id", id) };
  constructor(
    private readonly sql: SqlHandle,
    readonly seq: number,
  ) {}

  lookup(path: string): Entry | undefined {
    return (
      this.one(this.paths, "path", path) ??
      (path.endsWith(".md") ? undefined : this.one(this.paths, "path", `${path}.md`))
    );
  }

  private one(memo: Map<string, Entry | undefined>, column: string, key: string) {
    if (memo.has(key)) return memo.get(key);
    const e = this.sql.all<Entry>(
      `SELECT path, page_id, hash, kind, last_seq AS seq FROM paths WHERE ${column} = ?`,
      key,
    )[0];
    memo.set(key, e);
    return e;
  }
}

export interface PageRow {
  path: string;
  kind: Kind;
  hash: string;
  seq: number;
  title?: string | null;
  description?: string | null;
  status?: string;
  /** False when the page has no `status`, which reads as stable. */
  status_set?: boolean;
  tags?: string[];
  trust_tier?: TrustTier;
  stale?: boolean;
  size?: number;
  media?: string | null;
}

/** An attachment an image in a page shows (FileView `images`). */
export interface ImageRef {
  hash: string;
  media: string | null;
  /** Its size in bytes (a PDF's card says it, TEMPRA-164). */
  size?: number;
  width?: number | null;
  height?: number | null;
  /** For a video, the image attached beside it as its poster (`demo.poster.png`, TEMPRA-164). */
  poster?: ImageRef;
}

/** A blob the reader's image or media route serves (TEMPRA-162, TEMPRA-164). */
export interface ServedBlob {
  hash: string;
  size: number;
  media: string;
  width: number | null;
  height: number | null;
}

/** The image types a video's poster may be, by the extension after `<name>.poster.`. */
const POSTER_EXTENSIONS = ["png", "jpg", "jpeg", "webp", "avif"];

/** The extensions a video a poster is named for may have (TEMPRA-182). */
const VIDEO_EXTENSIONS = ["mp4", "webm", "m4v", "mov", "ogv"];

export type FileView =
  | {
      kind: "page";
      path: string;
      hash: string;
      seq: number;
      markdown: string;
      frontmatter: JsonObject;
      /** The body as a tree, links at their targets' current paths. */
      doc: Doc;
      lint: LintWarning[];
      trust_tier: TrustTier;
      stale: boolean;
      /** Within STALE_SOON_DAYS of `stale_after`, worked out at read time like `stale`. */
      stale_soon: boolean;
      inbound_links: number;
      /** Open comment threads, at head (0 for an earlier version). */
      open_comments: number;
      /** Its figures from the stored blob rows, when asked for (`figures`; MCP `read`, TEMPRA-154). */
      figures?: FigureFact[];
      /**
       * The attachments its images show, by library path, from their blob rows, when asked for
       * (`images`; the reader, TEMPRA-162): what the image route serves by hash and the size the
       * reader reserves. `width` and `height` are absent when never worked out, null when unknown.
       */
      images?: Record<string, ImageRef>;
      /** How much the page is read and how recently, when asked for (`reads`; TEMPRA-220). */
      reads?: ReadHistory;
    }
  | {
      kind: "attachment";
      path: string;
      hash: string;
      seq: number;
      size: number;
      media: string | null;
      /**
       * An image's or a video's size in pixels; null when it has none (another file, an SVG that
       * does not say, bytes that do not decode), absent when never worked out (an image from
       * before TEMPRA-152, a video from before TEMPRA-164).
       */
      width?: number | null;
      height?: number | null;
      /** A video's poster, the image beside it as `<name>.poster.png` (TEMPRA-182). */
      poster?: { path: string } & ImageRef;
      /** For a video's poster, the video's path (TEMPRA-182). */
      poster_for?: string;
      /** Where this version's bytes were fetched from, when they were (TEMPRA-157). */
      source: AttachSource | null;
      /** What the file shows, in its writer's words (TEMPRA-170). */
      description: string | null;
      /** Who made it and under what licence, when its writer said (TEMPRA-170). */
      credit: string | null;
      licence: string | null;
      /** The person who supplied the bytes through an upload link (TEMPRA-196). */
      supplied_by: string | null;
      /** For an upload, who had the file: the person, or the agent that made it (TEMPRA-205). */
      origin: "person" | "agent" | null;
      /** What this version was made from on the server (TEMPRA-208). */
      made_from: MadeFrom | null;
    }
  | { kind: "derived"; path: string; seq: number; markdown: string };

export interface ExportFile {
  path: string;
  text?: string;
  blob?: BlobRef;
}

export interface StoreOptions {
  pageCap?: number;
  /** Server clock, injectable for tests. */
  now?: () => Date;
  /** Bytes of storage the library uses; the Durable Object passes its SQLite size. */
  size?: () => number;
  /** The render service's Pele version (render/src/version.ts); verdicts are kept per version. */
  peleVersion?: string;
}

/** Reads are counted over this window for internal sources' usage (spec: What the service derives). */
export const USAGE_WINDOW_DAYS = 30;

/** Reads of one page by one reader on one day, counted in memory (TEMPRA-87, TEMPRA-220). */
interface PendingRead {
  id: string;
  surface: string;
  kind: string;
  reader: string;
  n: number;
}

/** Reads counted in memory before they are written to `access_log` (TEMPRA-87). */
export const READ_FLUSH = 100;

/**
 * Requests log.md shows before pointing to the rest: one full page of `GET …/requests` (its
 * largest `limit`), so the next page picks up exactly where the file stops.
 */
export const LOG_REQUESTS = 200;

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

function tagsOf(r: PageRecord): string[] {
  const t = field(r, "tags");
  if (Array.isArray(t)) return t.filter((x) => x !== null).map((x) => String(x));
  return typeof t === "string" ? [t] : [];
}

type LinkKind = "body" | "source";

/** A record's links into the library: body links, then internal source resources. */
function linkGraph(r: PageRecord): [StoredLink | StoredSource, LinkKind][] {
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

/** Links to `index.md`, `log.md` or a directory name synthesized files, not pages. */
function isDerivedTarget(link: { raw: string; path: string }): boolean {
  const raw = splitAnchor(link.raw).path;
  return isReserved(link.path) || raw.endsWith("/");
}

/**
 * Refuses a written page that has no usable frontmatter (tempra-dev:
 * decisions/write-refuses-invalid-concepts, decisions/pages-not-okf). Imports keep such files,
 * with lint.
 */
function refuseInvalid(path: string, parsed: ParsedPage) {
  if (parsed.fmError !== null) {
    throw new StoreError(
      400,
      parsed.rawFm === null ? "missing_frontmatter" : "bad_frontmatter",
      `${path}: ${parsed.fmError} Nothing was written.`,
    );
  }
}

/** Search snippet markers: control characters, which page text never holds. */
/** Events that change a file's content (a write, import, revert or delete), on `events`. */
const CONTENT_EVENT = "op NOT IN ('move', 'verify', 'comment')";

/**
 * Pages by where they stand against verification (`p` the path, `e` its latest content event;
 * a move or a comment is not a change). `person`: only a person's verification counts, else a
 * process's too. `which`: "unverified", changed after the latest verification or never verified
 * (the health summary's `unverified`); "changed", verified and changed since (Needs you's "To
 * verify"); "never", not verified at all (Needs you's counted line, TEMPRA-111).
 */
function unverified(person: boolean, which: "unverified" | "changed" | "never"): string {
  const by = person ? "AND v.by LIKE 'human:%'" : "";
  const verifiedSince = `EXISTS (
    SELECT 1 FROM verifications v WHERE v.page_id = p.page_id AND v.seq > e.seq ${by})`;
  const ever = `EXISTS (SELECT 1 FROM verifications v WHERE v.page_id = p.page_id ${by})`;
  const where =
    which === "unverified"
      ? `NOT ${verifiedSince}`
      : which === "changed"
        ? `${ever} AND NOT ${verifiedSince}`
        : `NOT ${ever}`;
  return `FROM paths p
  JOIN events e ON e.seq = (
    SELECT MAX(seq) FROM events WHERE page_id = p.page_id AND ${CONTENT_EVENT})
  WHERE p.kind = 'page' AND ${where}`;
}

const UNVERIFIED = unverified(false, "unverified");
const CHANGED_SINCE_A_PERSON = unverified(true, "changed");
const NEVER_BY_A_PERSON = unverified(true, "never");

/** The most pages one write's notice names (TEMPRA-116). */
const NOTICE_PAGES = 500;

const MARK_OPEN = "\u0002";
const MARK_CLOSE = "\u0003";
/** A match's end, white space, and the next match's start: one highlight. */
/**
 * BM25's weight for each `fts` column (page_id, title, body, tags): a word in the title counts
 * ten times one in the body, a tag four times (TEMPRA-17).
 */
const SEARCH_WEIGHTS = "0, 10, 1, 4";

/**
 * A search box's words as an FTS5 query (TEMPRA-17): any word matches, so BM25 ranks by how many
 * match and how rare they are, instead of a page needing every one. "A quoted phrase" stays a
 * phrase and `word*` a prefix; everything is quoted, so FTS5's own operators and punctuation are
 * plain words. Null when nothing is left to search for.
 */
export function searchMatch(q: string): string | null {
  const parts: string[] = [];
  for (const m of q.matchAll(/"([^"]*)"|(\S+)/g)) {
    const phrase = m[1];
    if (phrase !== undefined) {
      const words = phrase.trim();
      if (words) parts.push(`"${words}"`);
      continue;
    }
    const raw = m[2] ?? "";
    const star = raw.endsWith("*");
    const word = (star ? raw.slice(0, -1) : raw).replace(/"/g, "");
    if (word) parts.push(`"${word}"${star ? "*" : ""}`);
  }
  return parts.length > 0 ? parts.join(" OR ") : null;
}

const ADJACENT_MARKS = new RegExp(`${MARK_CLOSE}(\\s+)${MARK_OPEN}`, "g");

/** What search indexes of a body: its text as the reader shows it, footnote definitions too. */
function searchText(doc: Doc): string {
  const notes = doc.children.flatMap((n) => (n.type === "footnoteDefinition" ? n.children : []));
  const text = [docText(doc).text, docText({ type: "root", children: notes } as Doc).text];
  return text.join("\n").replaceAll(ATOM, " ");
}

/** The markdown of a tree the app sent; refused when it is not one. */
function bodyOf(doc: unknown): string {
  const bad = () =>
    new StoreError(400, "bad_doc", "`doc` must be a body tree as the API returns it.");
  if (!doc || typeof doc !== "object" || (doc as Doc).type !== "root") throw bad();
  if (!Array.isArray((doc as Doc).children)) throw bad();
  try {
    return toMarkdown(doc as Doc);
  } catch {
    throw bad();
  }
}

/**
 * One library's storage: blobs, the ledger and derived indexes (spec: Data model, The ledger,
 * Write path). Synchronous and free of Worker APIs, so it runs in the Library DO and under bun.
 */
export class LibraryStore {
  private readonly cap: number;
  private readonly clock: () => Date;
  private readonly size: (() => number) | null;
  /** The Pele whose verdicts the library keeps (TEMPRA-167): another version asks again. */
  private readonly peleVersion: string;
  private readonly records = new Map<string, PageRecord>();
  private readonly snapshots = new Map<number, Snapshot>();
  /** Missing-heading lint at head, by page, for the seq it was worked out at (TEMPRA-86). */
  private anchorCache: { seq: number; lint: Map<string, LintWarning[]> } | null = null;
  /**
   * Reads counted in memory (TEMPRA-87), by day, then by page, surface, kind and reader
   * (TEMPRA-220), and how many in all; with the latest read of each page on each surface.
   */
  private readonly reads = new Map<string, Map<string, PendingRead>>();
  private readonly lastReads = new Map<string, { id: string; surface: ReadSurface; at: string }>();
  private unflushed = 0;
  /** The reader of the call in progress (TEMPRA-220), set by `reading`; null for unattributed. */
  private reader: Reading | null = null;
  /** The write in progress: the seq it started from, and the files its content changes touched. */
  private touch: { before: number; ids: Set<string>; paths: Set<string> } | null = null;
  /** Committed writes since the kept lint's seq, in order: what each touched, from and to seq. */
  private anchorTouched: { before: number; after: number; ids: Set<string>; paths: Set<string> }[] =
    [];

  constructor(
    private readonly sql: SqlHandle,
    opts: StoreOptions = {},
  ) {
    this.cap = opts.pageCap ?? DEFAULT_PAGE_CAP;
    this.clock = opts.now ?? (() => new Date());
    this.size = opts.size ?? null;
    this.peleVersion = opts.peleVersion ?? PELE_VERSION;
    migrate(sql);
    this.reindexSearch();
    this.addStaleTimes();
    this.addStructure();
    this.addLedgerCounts();
    this.addFtsRows();
    this.stemSearch();
    this.addBlobDimensions();
    this.sql.script(DIAGRAM_RENDERS);
    this.sql.script(COST_INDEXES);
    this.addExternalImageFlags();
    this.addReadHistory();
    this.addThreadKinds();
  }

  /**
   * Threads have a kind (TEMPRA-222): 'comment', or 'request' for a bigger ask left for people's
   * agents. Libraries from before get the column once, every thread a comment.
   */
  private addThreadKinds() {
    if (this.sql.all("SELECT 1 FROM meta WHERE key = 'thread_kinds'").length > 0) return;
    this.sql.transaction(() => {
      const cols = this.sql.all<{ name: string }>("PRAGMA table_info(threads)");
      if (!cols.some((c) => c.name === "kind")) {
        this.sql.run("ALTER TABLE threads ADD COLUMN kind TEXT NOT NULL DEFAULT 'comment'");
      }
      this.sql.run("INSERT INTO meta (key, value) VALUES ('thread_kinds', '1')");
    });
  }

  /**
   * Reads by surface, reader kind and reader, and the last read per surface (TEMPRA-220).
   * Libraries from before get the columns, the wider unique index and `last_read` once; their
   * counts stay, with '' for surface, kind and reader: in totals and usage_count, in no split.
   */
  private addReadHistory() {
    if (this.sql.all("SELECT 1 FROM meta WHERE key = 'read_history'").length > 0) return;
    this.sql.transaction(() => {
      const cols = this.sql.all<{ name: string }>("PRAGMA table_info(access_log)");
      if (!cols.some((c) => c.name === "surface")) {
        this.sql.run("ALTER TABLE access_log ADD COLUMN surface TEXT NOT NULL DEFAULT ''");
      }
      if (!cols.some((c) => c.name === "kind")) {
        this.sql.run("ALTER TABLE access_log ADD COLUMN kind TEXT NOT NULL DEFAULT ''");
      }
      this.sql.run("UPDATE access_log SET actor = '' WHERE actor IS NULL");
      this.sql.run("DROP INDEX IF EXISTS access_log_key");
      this.sql.run(
        "CREATE UNIQUE INDEX IF NOT EXISTS access_log_reads ON access_log(page_id, day, surface, kind, actor)",
      );
      this.sql.script(
        `CREATE TABLE IF NOT EXISTS last_read (
           page_id TEXT NOT NULL, surface TEXT NOT NULL, at TEXT NOT NULL,
           PRIMARY KEY (page_id, surface)
         );`,
      );
      this.sql.run("INSERT INTO meta (key, value) VALUES ('read_history', '1')");
    });
  }

  /**
   * Runs `fn` as `reader` reads (TEMPRA-220): the reads it counts carry its surface and kind.
   * Store methods are synchronous, so nothing else runs in between.
   */
  reading<T>(reader: Reading | null, fn: () => T): T {
    const before = this.reader;
    this.reader = reader;
    try {
      return fn();
    } finally {
      this.reader = before;
    }
  }

  /**
   * Images keep their width and height beside size and media (TEMPRA-152). Libraries from before
   * get the columns once, empty: each image's size is worked out on its first read
   * (`withDimensions` in client.ts, then `setDimensions`).
   */
  private addBlobDimensions() {
    if (this.sql.all("SELECT 1 FROM meta WHERE key = 'blob_dimensions'").length > 0) return;
    this.sql.transaction(() => {
      const cols = this.sql.all<{ name: string }>("PRAGMA table_info(blobs)");
      if (!cols.some((c) => c.name === "width")) {
        this.sql.run("ALTER TABLE blobs ADD COLUMN width INTEGER");
        this.sql.run("ALTER TABLE blobs ADD COLUMN height INTEGER");
      }
      this.sql.run("INSERT INTO meta (key, value) VALUES ('blob_dimensions', '1')");
    });
  }

  /**
   * Keeps an image's size worked out from its bytes after it was stored (an attachment from
   * before TEMPRA-152); 0 by 0 for one that does not decode. Never overwrites a known size.
   */
  setDimensions(hash: string, width: number, height: number): void {
    const unknown = this.sql.all(
      "SELECT 1 FROM blobs WHERE hash = ? AND location = 'r2' AND width IS NULL",
      hash,
    );
    if (unknown.length === 0) return;
    this.sql.transaction(() => {
      this.sql.run(
        "UPDATE blobs SET width = ?, height = ? WHERE hash = ? AND location = 'r2' AND width IS NULL",
        Math.max(0, Math.floor(width)) || 0,
        Math.max(0, Math.floor(height)) || 0,
        hash,
      );
      // A size now known can make a figure too large (TEMPRA-159).
      const snap = this.live();
      for (const r of this.sql.all<{ from_id: string }>(
        `SELECT DISTINCT l.from_id FROM links l JOIN paths p ON p.page_id = l.to_id
         WHERE p.hash = ? AND p.kind = 'attachment'`,
        hash,
      )) {
        this.refreshImages(snap, r.from_id);
      }
    });
  }

  /**
   * An image this library holds, current or past (a blob row of an attachment, which only a write
   * in this library makes), for the reader's image route (TEMPRA-162): a hash alone grants
   * nothing, so one this library never stored is null, as is a file that is not an image.
   */
  imageBlob(hash: string): ServedBlob | null {
    return this.servedBlob(hash, (m) => m.startsWith("image/"));
  }

  /**
   * A video or audio file this library holds, current or past, for the reader's media route
   * (TEMPRA-164), by the same rule as `imageBlob`: a hash grants nothing.
   */
  mediaBlob(hash: string): ServedBlob | null {
    return this.servedBlob(hash, (m) => m.startsWith("video/") || m.startsWith("audio/"));
  }

  private servedBlob(hash: string, kind: (media: string) => boolean): ServedBlob | null {
    if (!/^[0-9a-f]{64}$/.test(hash)) return null;
    const row = this.sql.all<{
      size: number;
      media: string | null;
      width: number | null;
      height: number | null;
    }>("SELECT size, media, width, height FROM blobs WHERE hash = ? AND location = 'r2'", hash)[0];
    if (!row?.media || !kind(row.media)) return null;
    const sized = (row.width ?? 0) > 0 && (row.height ?? 0) > 0;
    return {
      hash,
      size: row.size,
      media: row.media,
      width: sized ? row.width : null,
      height: sized ? row.height : null,
    };
  }

  /**
   * Search rows are found by rowid through `fts_rows` (TEMPRA-87). Libraries from before get the
   * table once, filled from the rowids their search rows already have.
   */
  private addFtsRows() {
    if (this.sql.all("SELECT 1 FROM meta WHERE key = 'fts_rows'").length > 0) return;
    this.sql.transaction(() => {
      this.sql.script(
        "CREATE TABLE IF NOT EXISTS fts_rows (page_id TEXT PRIMARY KEY, fts_rowid INTEGER NOT NULL);",
      );
      this.sql.run("DELETE FROM fts_rows");
      this.sql.run(
        "INSERT OR REPLACE INTO fts_rows (page_id, fts_rowid) SELECT page_id, rowid FROM fts",
      );
      this.sql.run("INSERT INTO meta (key, value) VALUES ('fts_rows', '1')");
    });
  }

  /**
   * Search is stemmed (TEMPRA-17: Porter over unicode61, so "comments" finds "comment").
   * Libraries from before get it once: their rows copied into a stemmed table that takes the
   * old one's place, and `fts_rows` refilled with the new rowids. Told from the table's own
   * definition, so a new library (created stemmed) does nothing.
   */
  private stemSearch() {
    // Known once (TEMPRA-293): reading sqlite_master on every open reads its every row.
    if (this.sql.all("SELECT 1 FROM meta WHERE key = 'fts_stemmed'").length > 0) return;
    const def = this.sql.all<{ sql: string }>(
      "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'fts'",
    )[0]?.sql;
    if (!def) return;
    if (/porter/i.test(def)) {
      this.sql.run("INSERT OR IGNORE INTO meta (key, value) VALUES ('fts_stemmed', '1')");
      return;
    }
    try {
      this.sql.transaction(() => {
        this.sql.script(
          "CREATE VIRTUAL TABLE fts_stemmed USING fts5(page_id UNINDEXED, title, body, tags, tokenize = 'porter unicode61');",
        );
        this.sql.run(
          "INSERT INTO fts_stemmed (page_id, title, body, tags) SELECT page_id, title, body, tags FROM fts",
        );
        this.sql.script("DROP TABLE fts; ALTER TABLE fts_stemmed RENAME TO fts;");
        this.sql.run("DELETE FROM fts_rows");
        this.sql.run("INSERT INTO fts_rows (page_id, fts_rowid) SELECT page_id, rowid FROM fts");
        this.sql.run("INSERT OR IGNORE INTO meta (key, value) VALUES ('fts_stemmed', '1')");
      });
    } catch (e) {
      // Rolled back: the library keeps its unstemmed search, which still works, rather than
      // failing to open. Tried again the next time it opens.
      console.error("search not stemmed", e);
    }
  }

  /** Removes a page's search row, by rowid (TEMPRA-87). */
  private dropSearchRow(id: string) {
    this.sql.run(
      "DELETE FROM fts WHERE rowid IN (SELECT fts_rowid FROM fts_rows WHERE page_id = ?)",
      id,
    );
    this.sql.run("DELETE FROM fts_rows WHERE page_id = ?", id);
  }

  /**
   * The ledger's counts are kept by triggers (TEMPRA-86). Libraries from before get the tables
   * and triggers once, filled from the ledger as it stands.
   */
  private addLedgerCounts() {
    if (this.sql.all("SELECT 1 FROM meta WHERE key = 'ledger_counts'").length > 0) return;
    this.sql.transaction(() => {
      this.sql.script(LEDGER_COUNTS);
      this.sql.run(
        `UPDATE ledger_counts SET events = (SELECT COUNT(*) FROM events),
           requests = (SELECT COUNT(DISTINCT request_id) FROM events) WHERE id = 1`,
      );
      this.sql.run("DELETE FROM contributors");
      this.sql.run(
        `INSERT INTO contributors (person, agent, agent_key, requests, first_seq, last_seq)
         SELECT person, agent, CASE WHEN agent IS NULL THEN 'n' ELSE 's' || agent END,
                COUNT(DISTINCT request_id), MIN(seq), MAX(seq)
         FROM (SELECT json_extract(meta, '$.by.person') AS person,
                      json_extract(meta, '$.by.agent') AS agent, request_id, seq
               FROM events WHERE meta IS NOT NULL AND json_extract(meta, '$.by.person') IS NOT NULL)
         GROUP BY person, agent`,
      );
      this.sql.run("INSERT INTO meta (key, value) VALUES ('ledger_counts', '1')");
    });
  }

  /**
   * Libraries from before the structure process (TEMPRA-64) get a first run on open, so the work
   * queue has every directory's flags at once, not only those of directories written since.
   */
  private addStructure() {
    if (this.sql.all("SELECT 1 FROM meta WHERE key = 'structure'").length > 0) return;
    this.sql.transaction(() => {
      this.syncStructure(null, this.headSeq());
      this.sql.run("INSERT INTO meta (key, value) VALUES ('structure', '1')");
    });
  }

  /**
   * The staleness process needs `stale_after` as a number it can range over (TEMPRA-63).
   * Libraries created before that get the column and its index once, then a first run, so the
   * work queue never misses a page that went stale before the first alarm.
   */
  private addStaleTimes() {
    if (this.sql.all("SELECT 1 FROM meta WHERE key = 'stale_ms'").length > 0) return;
    const dated = this.sql.transaction(() => {
      const cols = this.sql.all<{ name: string }>("PRAGMA table_info(pages)");
      if (!cols.some((c) => c.name === "stale_ms")) {
        this.sql.run("ALTER TABLE pages ADD COLUMN stale_ms INTEGER");
      }
      this.sql.script(
        "CREATE INDEX IF NOT EXISTS pages_stale ON pages(stale_ms) WHERE stale_ms IS NOT NULL;\n" +
          "CREATE INDEX IF NOT EXISTS flags_kind ON flags(kind);",
      );
      const rows = this.sql.all<{ page_id: string; stale_after: string }>(
        "SELECT page_id, stale_after FROM pages WHERE stale_after IS NOT NULL",
      );
      for (const r of rows) {
        this.sql.run(
          "UPDATE pages SET stale_ms = ? WHERE page_id = ?",
          staleTime(r.stale_after),
          r.page_id,
        );
      }
      this.sql.run("INSERT INTO meta (key, value) VALUES ('stale_ms', '1')");
      return rows.length > 0;
    });
    if (dated) this.maintainStaleness();
  }

  /**
   * Search indexes a page's text, not its markdown, so markup and link targets are neither
   * matched nor highlighted (TEMPRA-28). Libraries indexed before that are reindexed once.
   */
  private reindexSearch() {
    const done = this.sql.all("SELECT 1 FROM meta WHERE key = 'fts_text'").length > 0;
    if (done) return;
    this.sql.transaction(() => {
      const rows = this.sql.all<{ page_id: string; hash: string }>(
        "SELECT page_id, hash FROM paths WHERE kind = 'page'",
      );
      for (const row of rows) {
        this.sql.run(
          "UPDATE fts SET body = ? WHERE page_id = ?",
          searchText(this.record(row.hash).doc),
          row.page_id,
        );
      }
      this.sql.run("INSERT INTO meta (key, value) VALUES ('fts_text', '1')");
    });
  }

  // ---------------------------------------------------------------- ledger primitives

  /** How many files the library holds now (pages and attachments), for the DO's timing line. */
  fileCount(): number {
    // The head snapshot the call just used, when there is one (TEMPRA-293): a count reads every path.
    const snap = this.snapshots.get(this.headSeq());
    if (snap) return snap.byPath.size;
    return this.sql.all<{ n: number }>("SELECT COUNT(*) AS n FROM paths")[0]?.n ?? 0;
  }

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
      page_id: string;
      meta?: JsonObject;
    },
  ): number {
    const meta: JsonObject = { ...(e.meta ?? {}) };
    if (ctx.note) meta.note = ctx.note;
    if (ctx.by?.person) {
      meta.by = ctx.by.agent
        ? { person: ctx.by.person, agent: ctx.by.agent }
        : { person: ctx.by.person };
    }
    const rows = this.sql.all<{ seq: number }>(
      `INSERT INTO events (ts, actor, request_id, op, path, prev_hash, hash, page_id, meta)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING seq`,
      ts,
      ctx.actor,
      ctx.request_id,
      e.op,
      e.path,
      e.prev_hash,
      e.hash,
      e.page_id,
      Object.keys(meta).length > 0 ? JSON.stringify(meta) : null,
    );
    const seq = rows[0]?.seq;
    if (seq === undefined) throw new Error("event insert returned no seq");
    return seq;
  }

  private putRecord(r: PageRecord): string {
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

  private record(hash: string): PageRecord {
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

  private blobInfo(hash: string): BlobRef & {
    location: string;
    /** Null when never worked out. */
    dims: { width: number | null; height: number | null } | null;
  } {
    const row = this.sql.all<{
      size: number;
      media: string | null;
      location: string;
      width: number | null;
      height: number | null;
    }>("SELECT size, media, location, width, height FROM blobs WHERE hash = ?", hash)[0];
    if (!row) throw new Error(`missing blob ${hash}`);
    const sized = row.width !== null && row.width > 0 && row.height !== null && row.height > 0;
    const out: BlobRef & {
      location: string;
      dims: { width: number | null; height: number | null } | null;
    } = {
      hash,
      size: row.size,
      media: row.media,
      location: row.location,
      dims:
        row.width === null
          ? null
          : sized
            ? { width: row.width, height: row.height }
            : { width: null, height: null },
    };
    if (sized) {
      out.width = row.width as number;
      out.height = row.height as number;
    }
    return out;
  }

  private pathRow(path: string): PathRow | undefined {
    return this.sql.all<PathRow>(
      "SELECT path, page_id, hash, kind, last_seq AS seq, created_seq FROM paths WHERE path = ?",
      path,
    )[0];
  }

  /** A path as a client addresses it: exact, or a page without its `.md` suffix. */
  private lookupRow(path: string): PathRow | undefined {
    return this.pathRow(path) ?? (path.endsWith(".md") ? undefined : this.pathRow(`${path}.md`));
  }

  private verifiedAt(pageId: string, seq: number): Verification[] {
    return this.sql.all<Verification>(
      "SELECT by, at FROM verifications WHERE page_id = ? AND seq <= ? ORDER BY seq",
      pageId,
      seq,
    );
  }

  private redirectAt(path: string, seq: number): string | undefined {
    return this.sql.all<{ page_id: string }>(
      "SELECT page_id FROM redirects WHERE old_path IN (?, ?) AND since_seq <= ? ORDER BY since_seq DESC LIMIT 1",
      path,
      `${path}.md`,
      seq,
    )[0]?.page_id;
  }

  /**
   * The snapshot at `at` (default head). Committed snapshots are cached; the head's is moved
   * forward in place by each write (`settle`). Reads inside a write transaction use `live()`.
   */
  private snapshot(at?: number): Snapshot {
    const head = this.headSeq();
    const seq = at === undefined ? head : at;
    if (!Number.isInteger(seq) || seq < 0 || seq > head) {
      throw new StoreError(400, "bad_seq", `Sequence ${at} is outside 0..${head}.`);
    }
    const cached = this.snapshots.get(seq);
    if (cached) return cached;
    const entries =
      seq === head
        ? this.headEntries()
        : this.sql
            .all<Entry & { location: string }>(
              `SELECT e.path, e.page_id, e.hash, e.seq, b.location FROM events e
               JOIN (SELECT page_id, MAX(seq) AS m FROM events
                     WHERE seq <= ? AND op != 'comment' GROUP BY page_id) x
                 ON e.seq = x.m
               JOIN blobs b ON b.hash = e.hash
               WHERE e.hash IS NOT NULL`,
              seq,
            )
            .map((e) => ({ ...e, kind: (e.location === "r2" ? "attachment" : "page") as Kind }));
    const snap = new Snapshot(seq, entries);
    if (this.snapshots.size > 32) this.snapshots.clear();
    this.snapshots.set(seq, snap);
    return snap;
  }

  /** The head inside a write transaction, file by file (TEMPRA-87). */
  private live(): View {
    return new LiveView(this.sql, this.headSeq());
  }

  private headEntries(): Entry[] {
    return this.sql.all<Entry>("SELECT path, page_id, hash, kind, last_seq AS seq FROM paths");
  }

  // ---------------------------------------------------------------- writes

  /** Applies ops as one all-or-nothing request (spec: Write path, Tier 1; POST /batch). */
  apply(ctx: RequestContext, ops: WriteOp[]): WriteResult {
    if (ops.length === 0) throw new StoreError(400, "empty_request", "No operations to apply.");
    const before = this.headSeq();
    try {
      const res: WriteResult = this.guard(() =>
        this.sql.transaction(() => {
          const w = this.begin(ctx);
          const n = ops.length;
          for (const [i, op] of ops.entries()) this.atOp(n, i, op, () => this.planCreate(w, op));
          const results = ops.flatMap((op, i) => this.atOp(n, i, op, () => this.applyOp(w, op)));
          return {
            request_id: ctx.request_id,
            seq: this.headSeq(),
            results: this.finish(w, results),
            ...rendersOf(w),
          };
        }),
      );
      return { ...res, notify: this.writeNotice(before) };
    } catch (e) {
      throw this.asCommitted(e, ops);
    }
  }

  /**
   * An error from a request of several ops, with `current_hash` and `current` as committed. Built
   * inside the transaction, they would show what earlier ops of the request did, which the
   * rollback undid (TEMPRA-44).
   */
  private asCommitted(e: unknown, ops: WriteOp[]): unknown {
    if (!(e instanceof StoreError) || ops.length < 2) return e;
    if (e.extra.current_hash === undefined && e.extra.current === undefined) return e;
    const op = typeof e.extra.op_index === "number" ? ops[e.extra.op_index] : undefined;
    const p = op ? normalizePath(op.path) : null;
    if (!p) return e;
    const row = this.lookupRow(p);
    const extra: Record<string, unknown> = { ...e.extra, current_hash: row?.hash ?? null };
    if (typeof e.extra.current === "string") {
      if (row?.kind === "page") {
        extra.current = this.renderEntry(this.live(), row, false);
      } else delete extra.current;
    }
    return new StoreError(e.status, e.code, e.message, extra);
  }

  /**
   * Imports a bundle as one request (spec: Import and export). Keeps each file's own `generated`
   * and records its `verified` entries as verify events; incoming `index.md` and `log.md` are
   * discarded because the service synthesizes them.
   */
  import(ctx: RequestContext, files: ImportFile[], source?: string): ImportResult {
    const before = this.headSeq();
    const res: ImportResult = this.guard(() =>
      this.sql.transaction(() => {
        const w = this.begin(ctx);
        w.mode = "import";
        w.source = source ?? null;
        const skipped: string[] = [];
        const ops: WriteOp[] = [];
        for (const f of files) {
          const path = normalizePath(f.path);
          if (!path) throw new StoreError(400, "bad_path", `Invalid path ${f.path}.`);
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
          ops.flatMap((op) => this.applyOp(w, op)),
        );
        return {
          request_id: ctx.request_id,
          seq: this.headSeq(),
          files: ops.length,
          skipped,
          warnings: results
            .filter((r) => r.lint.length > 0)
            .map((r) => ({ path: r.path, lint: r.lint })),
          ...rendersOf(w),
        };
      }),
    );
    return { ...res, notify: this.writeNotice(before) };
  }

  /** Forward-only rollback of one path to its state at `to_seq`, or of a whole request. */
  revert(
    ctx: RequestContext,
    target: { path: string; to_seq: number } | { request_id: string },
  ): WriteResult {
    const before = this.headSeq();
    const res: WriteResult = this.guard(() =>
      this.sql.transaction(() => {
        const w = this.begin(ctx);
        const results =
          "request_id" in target
            ? this.revertRequest(w, target.request_id)
            : this.revertPath(w, target.path, target.to_seq);
        if (results.length === 0) {
          throw new StoreError(
            409,
            "nothing_to_revert",
            "The target state equals the current state.",
          );
        }
        return {
          request_id: ctx.request_id,
          seq: this.headSeq(),
          results: this.finish(w, results),
          ...rendersOf(w),
        };
      }),
    );
    return { ...res, notify: this.writeNotice(before) };
  }

  /**
   * What the write after `before` means for the library's people (WriteNotice), read once it has
   * committed, in the same call, so the Worker needs no second trip (TEMPRA-116).
   */
  private writeNotice(before: number): WriteNotice {
    // Only the write's own events, by their seq (TEMPRA-293): grouping by page in SQL walked an
    // index over every event in the library. Each page's last one, in seq order.
    const last = new Map<string, { page_id: string; path: string }>();
    for (const e of this.sql.all<{ page_id: string; path: string }>(
      `SELECT page_id, path FROM events WHERE seq > ? AND ${CONTENT_EVENT} ORDER BY seq`,
      before,
    )) {
      last.delete(e.page_id);
      last.set(e.page_id, e);
    }
    const changed = [...last.values()].slice(0, NOTICE_PAGES).flatMap((e) => {
      const row = this.sql.all<{ path: string; kind: string }>(
        "SELECT path, kind FROM paths WHERE page_id = ?",
        e.page_id,
      )[0];
      if (row && row.kind !== "page") return [];
      if (!row && !e.path.endsWith(".md")) return [];
      const c = this.sql.all<{ title: string | null }>(
        "SELECT title FROM pages WHERE page_id = ?",
        e.page_id,
      )[0];
      const verifiers = row
        ? this.sql
            .all<{ person: string | null; actor: string; seq: number }>(
              `SELECT json_extract(e.meta, '$.by.person') AS person, v.by AS actor, MAX(v.seq) AS seq
                 FROM verifications v JOIN events e ON e.seq = v.seq
                 WHERE v.page_id = ? AND v.by LIKE 'human:%'
                 GROUP BY COALESCE(json_extract(e.meta, '$.by.person'), v.by)`,
              e.page_id,
            )
            .flatMap((v) => {
              const changes =
                this.sql.all<{ n: number }>(
                  `SELECT COUNT(*) AS n FROM events WHERE page_id = ? AND seq > ? AND ${CONTENT_EVENT}`,
                  e.page_id,
                  v.seq,
                )[0]?.n ?? 0;
              return changes > 0 ? [{ person: v.person, actor: v.actor, changes }] : [];
            })
        : [];
      return [
        {
          path: row?.path ?? e.path,
          title: c?.title ?? null,
          deleted: !row,
          verifiers,
        },
      ];
    });
    const verified = this.sql.all<{ path: string; person: string | null; actor: string }>(
      `SELECT COALESCE(p.path, e.path) AS path, json_extract(e.meta, '$.by.person') AS person,
              e.actor
       FROM events e LEFT JOIN paths p ON p.page_id = e.page_id
       WHERE e.seq > ? AND e.op = 'verify' AND e.actor LIKE 'human:%' LIMIT ${NOTICE_PAGES}`,
      before,
    );
    const moved = this.sql
      .all<{ to: string; from: string | null }>(
        `SELECT path AS "to", json_extract(meta, '$.from_path') AS "from" FROM events
         WHERE seq > ? AND op = 'move' LIMIT ${NOTICE_PAGES}`,
        before,
      )
      .flatMap((m) => (m.from ? [{ from: m.from, to: m.to }] : []));
    return { changed, verified, moved };
  }

  private guard<T>(fn: () => T): T {
    // The reads counted so far go in before the write, in their own transaction.
    this.flushReads();
    try {
      const out = fn();
      this.settle();
      return out;
    } catch (e) {
      // A rolled-back transaction may have cached state for sequence numbers it never committed.
      this.snapshots.clear();
      this.anchorCache = null;
      this.anchorTouched = [];
      this.touch = null;
      throw e;
    }
  }

  /**
   * After a committed write: moves the head snapshot forward to it in place (TEMPRA-87), and
   * records what it touched so the kept missing-heading lint catches up when next read
   * (TEMPRA-86). What it touched is what its events name: their pages, paths and moves' origins.
   */
  private settle() {
    const touch = this.touch;
    this.touch = null;
    if (!touch) return;
    const head = this.headSeq();
    if (head === touch.before) return;
    for (const e of this.sql.all<{ page_id: string; path: string; from: string | null }>(
      "SELECT page_id, path, json_extract(meta, '$.from_path') AS \"from\" FROM events WHERE seq > ?",
      touch.before,
    )) {
      touch.ids.add(e.page_id);
      touch.paths.add(e.path);
      if (typeof e.from === "string") touch.paths.add(e.from);
    }
    const snap = this.snapshots.get(touch.before);
    if (snap) {
      this.snapshots.delete(touch.before);
      snap.advance(
        head,
        touch.ids,
        this.sql.all<Entry>(
          `SELECT path, page_id, hash, kind, last_seq AS seq FROM paths
           WHERE page_id IN (SELECT value FROM json_each(?))`,
          JSON.stringify([...touch.ids]),
        ),
      );
      this.snapshots.set(head, snap);
    }
    if (!this.anchorCache) return;
    if (this.anchorTouched.length >= 1000) {
      this.anchorCache = null;
      this.anchorTouched = [];
      return;
    }
    this.anchorTouched.push({ ...touch, after: head });
  }

  /**
   * The kept missing-heading lint brought up to `snap` from the writes since (TEMPRA-86): only the
   * files they touched and the pages with an anchored link to one of them are worked out
   * again. False when the writes since are not all known, so the caller works it all out.
   */
  private catchUpAnchors(snap: Snapshot): boolean {
    const cache = this.anchorCache;
    const touched = this.anchorTouched;
    this.anchorTouched = [];
    if (!cache) return false;
    const ids = new Set<string>();
    const paths = new Set<string>();
    let seq = cache.seq;
    for (const t of touched) {
      if (t.before !== seq) return false;
      for (const id of t.ids) ids.add(id);
      for (const p of t.paths) paths.add(p);
      seq = t.after;
    }
    if (seq !== snap.seq) return false;
    if (ids.size > 0) {
      const idList = JSON.stringify([...ids]);
      const pathList = JSON.stringify(
        [...paths].flatMap((p) => [p, p.endsWith(".md") ? p.slice(0, -3) : `${p}.md`]),
      );
      const affected = new Set(ids);
      for (const { from_id } of this.sql.all<{ from_id: string }>(
        `SELECT DISTINCT from_id FROM links
         WHERE kind = 'body' AND anchor IS NOT NULL AND anchor <> '#' AND (
           to_id IN (SELECT value FROM json_each(?))
           OR to_path IN (SELECT value FROM json_each(?))
           OR to_path IN (SELECT old_path FROM redirects WHERE page_id IN (SELECT value FROM json_each(?)))
           OR to_path || '.md' IN (SELECT old_path FROM redirects WHERE page_id IN (SELECT value FROM json_each(?))))`,
        idList,
        pathList,
        idList,
        idList,
      )) {
        affected.add(from_id);
      }
      const headings = new Map<string, Set<string>>();
      for (const id of affected) {
        const e = snap.byId.get(id);
        const lint = e?.kind === "page" ? this.anchorLint(snap, e, headings) : [];
        if (lint.length > 0) cache.lint.set(id, lint);
        else cache.lint.delete(id);
      }
    }
    cache.seq = snap.seq;
    return true;
  }

  private begin(ctx: RequestContext): WriteState {
    if (!ctx.actor) throw new StoreError(400, "no_actor", "Writes need an actor.");
    if (!ctx.request_id) throw new StoreError(400, "no_request_id", "Writes need a request id.");
    this.touch = { before: this.headSeq(), ids: new Set(), paths: new Set() };
    return {
      ctx,
      now: iso(this.clock()),
      mode: "write",
      source: null,
      pending: new Map(),
      written: new Map(),
      affected: new Set(),
      renders: [],
    };
  }

  /** Pre-assigns ids to paths this request creates, so links between new files resolve. */
  private planCreate(w: WriteState, op: WriteOp) {
    if (op.op !== "write" && op.op !== "attach") return;
    const path = op.op === "write" ? this.pagePath(op.path) : normalizePath(op.path);
    if (path && !this.pathRow(path) && !w.pending.has(path)) {
      w.pending.set(path, crypto.randomUUID());
    }
  }

  /** Runs one op of a request; in a request of several, its errors say which op failed. */
  private atOp<T>(n: number, i: number, op: WriteOp, fn: () => T): T {
    try {
      return fn();
    } catch (e) {
      if (n < 2 || !(e instanceof StoreError)) throw e;
      throw new StoreError(
        e.status,
        e.code,
        `Op ${i + 1} of ${n} (${op.op} ${op.path}): ${e.message}`,
        {
          ...e.extra,
          op_index: i,
        },
      );
    }
  }

  private applyOp(w: WriteState, op: WriteOp): OpResult[] {
    switch (op.op) {
      case "write":
        return [this.writePage(w, op.path, op.content, op.if_match, op.if_none_match)];
      case "attach":
        return [this.writeAttachment(w, op)];
      case "edit":
        return [this.edit(w, op.path, op.edits, op.if_match)];
      case "move":
        return this.move(w, op.path, op.to);
      case "delete":
        return [this.remove(w, op.path, op.if_match)];
      default:
        throw new StoreError(400, "bad_op", `Unknown op ${(op as { op: string }).op}.`);
    }
  }

  /**
   * Adds broken-link and missing-heading lint to each written page and refreshes flags on
   * affected pages.
   */
  private finish(w: WriteState, results: OpResult[]): OpResult[] {
    const snap = this.live();
    for (const id of w.affected) {
      this.refreshBroken(id);
      this.refreshImages(snap, id);
    }
    for (const r of results) {
      const id = w.written.get(r.path);
      if (!id || r.hash === null) continue;
      const broken = this.refreshBroken(id);
      const images = this.refreshImages(snap, id);
      const e = snap.byId.get(id);
      const anchors = e?.kind === "page" ? this.anchorLint(snap, e) : [];
      if (broken.length + images.length + anchors.length > 0) {
        r.lint = [...r.lint, ...broken, ...images, ...anchors];
      }
    }
    this.refreshStructure(results);
    return results;
  }

  /**
   * Keeps the structure flags of the directories a request touched current (TEMPRA-64): where
   * files were written, moved from or deleted.
   */
  private refreshStructure(results: OpResult[]) {
    const dirs = new Set<string>();
    for (const r of results) {
      if (r.op === "verify") continue;
      dirs.add(dirname(r.path));
      if (r.from) dirs.add(dirname(r.from));
    }
    if (dirs.size === 0) return;
    this.syncStructure(dirs, this.headSeq());
  }

  /**
   * What the structure checks read, for the directories given (every file under each) or the
   * whole library: each file's place, and a page's title and description.
   */
  private structureEntries(dirs: Set<string> | null): StructureEntry[] {
    const select = `SELECT p.path, p.kind, p.page_id, c.title, c.description
      FROM paths p LEFT JOIN pages c ON c.page_id = p.page_id`;
    type Row = StructureEntry;
    let rows: Row[];
    if (dirs === null || dirs.has("")) rows = this.sql.all<Row>(select);
    else {
      // The paths under each directory, a range over the primary key ('/' + 1 is '0').
      const seen = new Set<string>();
      rows = [];
      for (const dir of dirs) {
        for (const r of this.sql.all<Row>(
          `${select} WHERE p.path > ? AND p.path < ?`,
          `${dir}/`,
          `${dir}0`,
        )) {
          if (seen.has(r.path)) continue;
          seen.add(r.path);
          rows.push(r);
        }
      }
    }
    return rows;
  }

  /**
   * Brings the stored structure flags in line with the checks, for the directories given or the
   * whole library. A flag that stays keeps the seq it was first raised at. Returns the flags now
   * set in scope, and the keys newly flagged.
   */
  private syncStructure(dirs: Set<string> | null, seq: number) {
    const entries = this.structureEntries(dirs);
    const found = checkStructure(entries, dirs);
    // The stored flags in scope: the directories' own, and their pages'.
    const keys =
      dirs === null
        ? null
        : [
            ...[...dirs].map(dirKey),
            ...entries
              .filter((e) => e.kind === "page" && dirs.has(dirname(e.path)))
              .map((e) => e.page_id),
          ];
    const stored = new Map(
      this.sql
        .all<{ page_id: string; detail: string }>(
          // In scope, each key is looked up by the flags' primary key (TEMPRA-293); the kind's
          // index would walk every structure flag in the library.
          keys
            ? `SELECT f.page_id, f.detail FROM json_each(?) j
               CROSS JOIN flags f ON f.page_id = j.value AND f.kind = 'structure'`
            : "SELECT page_id, detail FROM flags WHERE kind = 'structure'",
          ...(keys ? [JSON.stringify(keys)] : []),
        )
        .map((f) => [f.page_id, f.detail]),
    );
    const mine = new Set(stored.keys());
    const became: string[] = [];
    for (const [key, issues] of found) {
      mine.delete(key);
      const detail = JSON.stringify(issues);
      if (stored.get(key) === detail) continue;
      if (!stored.has(key)) became.push(key);
      this.sql.run(
        `INSERT INTO flags (page_id, kind, since_seq, detail) VALUES (?, 'structure', ?, ?)
         ON CONFLICT(page_id, kind) DO UPDATE SET detail = excluded.detail`,
        key,
        seq,
        detail,
      );
    }
    for (const key of mine) {
      this.sql.run("DELETE FROM flags WHERE page_id = ? AND kind = 'structure'", key);
    }
    return { found, became };
  }

  private pagePath(input: string): string {
    const p = normalizePath(input);
    if (!p) throw new StoreError(400, "bad_path", `Invalid path ${JSON.stringify(input)}.`);
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
      throw new StoreError(
        409,
        "exists",
        `${path} already exists; to replace it, send its current hash as if_match.`,
        { current_hash },
      );
    }
    if (ifMatch) {
      if (!cur || cur.hash !== ifMatch) {
        throw new StoreError(412, "precondition_failed", `${path} does not match If-Match.`, {
          current_hash,
        });
      }
    } else if (cur) {
      throw new StoreError(
        409,
        "exists",
        `${path} already exists; to replace it, send its current hash as if_match.`,
        { current_hash },
      );
    }
  }

  private writePage(
    w: WriteState,
    input: string,
    content: PageContent,
    ifMatch?: string | null,
    ifNoneMatch?: boolean,
  ): OpResult {
    const path = this.pagePath(input);
    if (isReserved(path)) {
      throw new StoreError(405, "reserved_path", `${basename(path)} is synthesized by the server.`);
    }
    const cur = this.pathRow(path);
    this.checkPreconditions(path, cur, ifMatch, ifNoneMatch, w.mode);
    const markdown =
      typeof content === "string"
        ? content
        : `---\n${yamlStringify(content.frontmatter ?? {})}---\n${bodyOf(content.doc)}`;
    const curPage = cur?.kind === "page" ? cur : undefined;
    const storedVerified = curPage ? this.verifiedAt(curPage.page_id, cur?.seq ?? 0) : [];
    const prev = curPage ? this.record(curPage.hash) : null;
    const parsed = parsePage(markdown);
    const built = buildRecord(parsed, {
      path,
      mode: w.mode === "import" ? "import" : "write",
      actor: w.ctx.actor,
      now: w.now,
      stored: prev ? { generated: prev.generated, verified: storedVerified } : null,
      prev: prev?.doc ?? null,
      hints: typeof content === "string" ? null : content.doc,
    });
    if (w.mode !== "import") refuseInvalid(path, parsed);
    // An ordinary write lapses every earlier verification (spec: What the service derives); with
    // one-second timestamps, keep the new stamp strictly after the latest one.
    const generated = built.record.generated;
    if (w.mode !== "import" && generated && typeof generated.at === "string") {
      const latest = Math.max(
        ...storedVerified.map((v) => Date.parse(v.at)).filter(Number.isFinite),
      );
      if (Date.parse(generated.at) <= latest) {
        built.record.generated = { ...generated, at: iso(new Date(latest + 1000)) };
      }
    }
    this.resolveTargets(built.record, path, w);
    const verified = w.mode === "import" ? built.verified : storedVerified;
    const size = utf8Length(renderPage(built.record, { verified }));
    if (size > this.cap) {
      throw new StoreError(
        413,
        "page_too_large",
        `${path} renders to ${size} bytes, over the ${this.cap}-byte page cap. Split it into smaller pages linked from a short overview.`,
      );
    }
    const hash = this.putRecord(built.record);
    const pageId = cur?.page_id ?? w.pending.get(path) ?? crypto.randomUUID();
    built.lint.push(...this.renderLint(w, pageId, path, hash, built.record.doc));
    let seq = cur?.seq ?? 0;
    if (!cur || cur.hash !== hash) {
      const meta: JsonObject = w.source ? { source: w.source } : {};
      // A new version of a page says how much of its text changed (Activity's word counts).
      if (prev) meta.words = wordChange(docText(prev.doc).text, docText(built.record.doc).text);
      seq = this.appendEvent(w.ctx, w.now, {
        op: w.mode === "import" ? "import" : "put",
        path,
        prev_hash: cur?.hash ?? null,
        hash,
        page_id: pageId,
        meta,
      });
      this.setPath(path, pageId, hash, "page", seq, cur?.created_seq ?? seq);
      this.indexPage(pageId, path, built.record, built.lint, seq);
      // Only a path that is new here can mend links to it (TEMPRA-293): a new version at the same
      // path leaves every inbound link's target as it was, so their pages need no refresh.
      if (!cur) this.healLinksTo(w, path, pageId);
    }
    if (w.mode === "import") {
      for (const v of built.verified) {
        if (storedVerified.some((s) => s.by === v.by && s.at === v.at)) continue;
        seq = this.recordVerification(w, pageId, path, hash, v);
      }
    }
    w.written.set(path, pageId);
    const result: OpResult = {
      op: w.mode === "import" ? "import" : "put",
      path,
      hash,
      seq,
      lint: built.lint,
    };
    if (w.mode === "import") return result;
    const notices = [...built.notices];
    const staleAfter = field(built.record, "stale_after");
    if (isStale(staleAfter, this.clock().getTime())) {
      notices.push({
        code: "stale_on_write",
        message: `stale_after ${String(staleAfter)} has already passed, so the page is stale (and in \`work\`) from now on; move it forward if it holds.`,
      });
    }
    if (typeof content === "string") {
      // Compared with the server-owned fields as the writer sent them, so an edit of the rendered
      // document (which carries the old stamp) is not reported, nor are ignored fields twice.
      const asSent = renderPage(
        {
          ...built.record,
          fm: unaliasSourceUrls(built.record.fm, built.aliased),
          generated: parsed.generated,
        },
        { verified: parsed.verified ?? [] },
      );
      const tidy = (t: string) =>
        t
          .replace(/^\uFEFF/, "")
          .replace(/\r\n?/g, "\n")
          .trimEnd();
      // Spacing only: blanks and the length of table rules, as in a table's padding.
      const squashLine = (l: string) => l.replace(/\s+/g, "").replace(/-+/g, "-");
      const squash = (t: string) => tidy(t).split("\n").map(squashLine).join("\n");
      // A hunk that only re-spaces lines (or adds and drops blank ones) is left out of the diff.
      const spacingOnly = (removed: string[], added: string[]) => {
        const lines = (ls: string[]) => ls.map(squashLine).filter((l) => l !== "");
        return lines(removed).join("\n") === lines(added).join("\n");
      };
      if (tidy(asSent) !== tidy(markdown)) {
        // The diff shows what is stored, server-owned fields included (TEMPRA-45).
        const { diff, ignored } =
          squash(asSent) === squash(markdown)
            ? { diff: "", ignored: 0 }
            : unifiedDiffExcept(
                `${tidy(markdown)}\n`,
                `${tidy(renderPage(built.record, { verified }))}\n`,
                { from: "sent", to: "stored" },
                spacingOnly,
              );
        if (diff) {
          result.normalized = diff;
          const spaced =
            ignored === 0
              ? ""
              : ` ${ignored === 1 ? "One place" : `${ignored} places`} where only spacing changed (table padding, indentation) ${ignored === 1 ? "is" : "are"} left out of it.`;
          notices.push({
            code: "normalized",
            message: `Stored in canonical form, which differs from what you sent (see the diff); \`edit\` against the stored text, as \`read\` shows it.${spaced}`,
          });
        } else {
          notices.push({
            code: "normalized",
            message:
              "Stored in canonical form; only spacing changed (table padding, indentation). `edit` against the stored text, as `read` shows it.",
          });
        }
      }
    }
    if (prev && curPage && hash !== curPage.hash) {
      notices.push(...this.threadNotices(pageId, prev, built.record));
    }
    if (notices.length > 0) result.notices = notices;
    return result;
  }

  /** The open threads on a page being changed, and the ones this change left outdated. */
  private threadNotices(pageId: string, prev: PageRecord, next: PageRecord) {
    const open = this.sql.all<{ id: string; anchor: string | null }>(
      "SELECT id, anchor FROM threads WHERE page_id = ? AND status = 'open' ORDER BY created_seq",
      pageId,
    );
    if (open.length === 0) return [];
    const out: LintWarning[] = [
      {
        code: "open_comments",
        message: `${open.length} open comment thread${open.length === 1 ? "" : "s"} on this page (${open.map((t) => t.id).join(", ")}): read them with \`comments\`, and answer what your change addressed.`,
      },
    ];
    const before = docText(prev.doc);
    const after = docText(next.doc);
    for (const t of open) {
      if (!t.anchor) continue;
      const anchor = JSON.parse(t.anchor) as StoredAnchor;
      if (locate(before, anchor) && !locate(after, anchor)) {
        out.push({
          code: "comment_outdated",
          message: `Thread ${t.id} was on “${clip(anchor.quote, 80)}”, which is no longer in the body; the thread is now outdated. Reply on it if your change addressed it.`,
        });
      }
    }
    return out;
  }

  /**
   * Links to a heading their target does not have, worked out from the target's current headings
   * whenever the linking page's lint is read, never stored (tempra-dev:
   * decisions/link-lint-at-read-time, TEMPRA-41). `headings` caches each target version's anchors.
   */
  private anchorLint(
    snap: View,
    e: Entry,
    headings = new Map<string, Set<string>>(),
  ): LintWarning[] {
    const out: LintWarning[] = [];
    for (const l of this.record(e.hash).links) {
      if (!l.anchor || l.anchor === "#" || isDerivedTarget(l)) continue;
      const target = this.targetAt(snap, l);
      if (target?.kind !== "page") continue;
      let ids = headings.get(target.hash);
      if (!ids) {
        ids = headingIds(this.record(target.hash).doc);
        headings.set(target.hash, ids);
      }
      const id = safeDecode(l.anchor.slice(1));
      if (ids.has(id)) continue;
      out.push({
        code: "missing_heading",
        message: `Link ${this.href(snap, e, l)} names a heading /${target.path} does not have (#${id}).`,
        target: target.path,
      });
    }
    return out;
  }

  private recordVerification(
    w: WriteState,
    pageId: string,
    path: string,
    hash: string,
    v: Verification,
  ): number {
    const seq = this.appendEvent(w.ctx, w.now, {
      op: "verify",
      path,
      prev_hash: hash,
      hash,
      page_id: pageId,
      meta: { by: v.by, at: v.at },
    });
    this.sql.run(
      "INSERT INTO verifications (page_id, by, at, seq) VALUES (?, ?, ?, ?)",
      pageId,
      v.by,
      v.at,
      seq,
    );
    this.sql.run("UPDATE paths SET last_seq = ? WHERE page_id = ?", seq, pageId);
    return seq;
  }

  /**
   * An attachment version's provenance (TEMPRA-157) and description, from the ledger: the newest
   * attach of these bytes at this file (its page id) up to `seq` that says them. Kept in the
   * events and not with the blob, because a blob is shared by every path holding the same bytes,
   * while where a file came from and what it shows belong to the file.
   */
  private provenance(
    pageId: string,
    hash: string,
    seq: number,
  ): {
    source: AttachSource | null;
    description: string | null;
    credit: string | null;
    licence: string | null;
    supplied_by: string | null;
    origin: "person" | "agent" | null;
    made_from: MadeFrom | null;
  } {
    const rows = this.sql.all<{ meta: string | null }>(
      `SELECT meta FROM events WHERE page_id = ? AND hash = ? AND seq <= ?
         AND op IN ('put', 'import') AND meta IS NOT NULL ORDER BY seq DESC LIMIT 50`,
      pageId,
      hash,
      seq,
    );
    let source: AttachSource | null = null;
    const text: Record<"description" | "credit" | "licence", string | null> = {
      description: null,
      credit: null,
      licence: null,
    };
    // Who supplied these bytes is the version's own fact: from the event that wrote them.
    let supplied: string | null | undefined;
    let origin: "person" | "agent" | null | undefined;
    let madeFrom: MadeFrom | null = null;
    for (const r of rows) {
      const m = JSON.parse(r.meta as string) as JsonObject;
      const s = m.source as Partial<AttachSource> | string | undefined;
      if (!source && s && typeof s === "object" && typeof s.url === "string") {
        source = {
          via: "url",
          url: s.url,
          ...(typeof s.final_url === "string" ? { final_url: s.final_url } : {}),
          fetched_at: String(s.fetched_at ?? ""),
        };
      }
      for (const k of ["description", "credit", "licence"] as const) {
        const v = m[k];
        if (text[k] === null && typeof v === "string") text[k] = v;
      }
      if (supplied === undefined) {
        supplied = typeof m.supplied_by === "string" ? m.supplied_by : null;
        origin = m.origin === "person" || m.origin === "agent" ? m.origin : null;
        const f = m.made_from as Partial<MadeFrom> | undefined;
        madeFrom =
          f && typeof f.path === "string" && typeof f.hash === "string" && typeof f.op === "string"
            ? { path: f.path, hash: f.hash, op: f.op }
            : null;
      }
      if (source && text.description !== null && text.credit !== null && text.licence !== null) {
        break;
      }
    }
    return {
      source,
      ...text,
      supplied_by: supplied ?? null,
      origin: origin ?? null,
      made_from: madeFrom,
    };
  }

  private writeAttachment(w: WriteState, op: Extract<WriteOp, { op: "attach" }>): OpResult {
    const { path: input, blob, if_match: ifMatch, if_none_match: ifNoneMatch } = op;
    const facts = checkFacts(op);
    if (op.source !== undefined) checkSource(op.source);
    const path = normalizePath(input);
    if (!path) throw new StoreError(400, "bad_path", `Invalid path ${JSON.stringify(input)}.`);
    if (isReserved(path)) {
      throw new StoreError(405, "reserved_path", `${basename(path)} is synthesized by the server.`);
    }
    if (path.endsWith(".md")) {
      throw new StoreError(400, "bad_attachment", "Markdown files are pages, not attachments.");
    }
    if (!/^[0-9a-f]{64}$/.test(blob.hash)) {
      throw new StoreError(400, "bad_blob", "Attachment hash must be a lowercase hex SHA-256.");
    }
    const cur = this.pathRow(path);
    this.checkPreconditions(path, cur, ifMatch, ifNoneMatch, w.mode);
    // An image's size from its header (TEMPRA-152). Without one it stays unknown (NULL), and the
    // first read works it out from the bytes (`withDimensions` in client.ts).
    const sized = !!blob.width && !!blob.height;
    const width = sized ? (blob.width as number) : null;
    const height = sized ? (blob.height as number) : null;
    const before = this.sql.all<{ media: string | null }>(
      "SELECT media FROM blobs WHERE hash = ?",
      blob.hash,
    )[0];
    // The type belongs to the bytes, so new bytes' type is stored with them, and a type that
    // changes for the same bytes is a write of its own (TEMPRA-105 §2), not a no-op.
    const retyped = !!before && !!blob.media && before.media !== blob.media;
    if (!before) {
      this.sql.run(
        "INSERT INTO blobs (hash, size, location, content, media, width, height) VALUES (?, ?, 'r2', NULL, ?, ?, ?)",
        blob.hash,
        blob.size,
        blob.media,
        width,
        height,
      );
    } else {
      if (retyped) this.sql.run("UPDATE blobs SET media = ? WHERE hash = ?", blob.media, blob.hash);
      if (width !== null) {
        this.sql.run(
          "UPDATE blobs SET width = ?, height = ? WHERE hash = ? AND (width IS NULL OR ?)",
          width,
          height,
          blob.hash,
          retyped ? 1 : 0,
        );
      }
    }
    const pageId = cur?.page_id ?? w.pending.get(path) ?? crypto.randomUUID();
    let seq = cur?.seq ?? 0;
    const sameBytes = cur?.hash === blob.hash;
    // A new source, description, credit or licence for the same bytes is a write of its own, as
    // a new type is.
    const had = cur && sameBytes ? this.provenance(cur.page_id, cur.hash, cur.seq) : null;
    const described =
      !!had &&
      ((op.source !== undefined &&
        (had.source?.url !== op.source.url || had.source?.final_url !== op.source.final_url)) ||
        (["description", "credit", "licence"] as const).some(
          (k) => facts[k] !== undefined && had[k] !== facts[k],
        ) ||
        (op.supplied_by !== undefined && had.supplied_by !== op.supplied_by));
    if (!cur || !sameBytes || retyped || described) {
      const meta: JsonObject = {};
      if (w.source) meta.source = w.source;
      else if (op.source) meta.source = { ...op.source } as unknown as JsonObject;
      for (const [k, v] of Object.entries(facts)) meta[k] = v;
      if (op.supplied_by) meta.supplied_by = op.supplied_by;
      if (op.origin) meta.origin = op.origin;
      if (op.made_from) meta.made_from = { ...op.made_from };
      if (retyped) meta.media = { from: before?.media ?? null, to: blob.media };
      seq = this.appendEvent(w.ctx, w.now, {
        op: w.mode === "import" ? "import" : "put",
        path,
        prev_hash: cur?.hash ?? null,
        hash: blob.hash,
        page_id: pageId,
        meta: Object.keys(meta).length > 0 ? meta : undefined,
      });
      if (cur?.kind === "page") this.unindex(cur.page_id);
      this.setPath(path, pageId, blob.hash, "attachment", seq, cur?.created_seq ?? seq);
      // New bytes or a new type: what links here is checked again (broken links, figure lint).
      this.healLinksTo(w, path, pageId);
    }
    const result: OpResult = {
      op: w.mode === "import" ? "import" : "put",
      path,
      hash: blob.hash,
      seq,
      lint: [],
    };
    const notices: LintWarning[] = [];
    if (blob.note) notices.push({ code: "media_from_bytes", message: blob.note });
    if (retyped) {
      notices.push({
        code: "media_changed",
        message: `Same bytes, new type: ${before?.media ?? "none"} → ${blob.media}.`,
      });
    }
    if (notices.length > 0) result.notices = notices;
    return result;
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
    if (row?.kind !== "page") throw notFound(input);
    if (ifMatch && ifMatch !== row.hash) {
      throw new StoreError(412, "precondition_failed", `${row.path} does not match If-Match.`, {
        current_hash: row.hash,
      });
    }
    if (!Array.isArray(edits) || edits.length === 0) {
      throw new StoreError(400, "no_edits", "Send at least one { old, new } edit.");
    }
    let doc = this.renderEntry(this.live(), row, false);
    for (const e of edits) {
      if (typeof e.old !== "string" || e.old === "" || typeof e.new !== "string") {
        throw new StoreError(
          400,
          "bad_edit",
          "Each edit needs a non-empty `old` and a string `new`.",
        );
      }
      const first = doc.indexOf(e.old);
      const count = first === -1 ? 0 : doc.split(e.old).length - 1;
      if (count !== 1) {
        throw new StoreError(
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
    return this.writePage(w, row.path, doc, row.hash);
  }

  /** Moves a file, or every file under a directory prefix, one event each (spec: Moves). */
  private move(w: WriteState, input: string, toInput: string): OpResult[] {
    const from = normalizePath(input);
    const to = normalizePath(toInput);
    if (!from || !to) throw new StoreError(400, "bad_path", "Move needs valid `path` and `to`.");
    const single = this.lookupRow(from);
    let pairs: [PathRow, string][];
    if (single) {
      const dest = single.kind === "page" && !to.endsWith(".md") ? `${to}.md` : to;
      pairs = [[single, dest]];
    } else {
      const rows = this.sql.all<PathRow>(
        "SELECT path, page_id, hash, kind, last_seq AS seq, created_seq FROM paths WHERE path LIKE ? ESCAPE '\\' ORDER BY path",
        `${escapeLike(from)}/%`,
      );
      if (rows.length === 0) throw notFound(input);
      if (underPrefix(to, from)) {
        throw new StoreError(400, "bad_move", "Cannot move a directory into itself.");
      }
      pairs = rows.map((r) => [r, to + r.path.slice(from.length)]);
    }
    const moving = new Set(pairs.map(([r]) => r.path));
    for (const [row, dest] of pairs) {
      if (isReserved(dest)) {
        throw new StoreError(
          405,
          "reserved_path",
          `${basename(dest)} is synthesized by the server.`,
        );
      }
      if (row.kind === "page" && !isPagePath(dest)) {
        throw new StoreError(400, "bad_path", `A page path must end in .md: ${dest}.`);
      }
      if (row.kind === "attachment" && dest.endsWith(".md")) {
        throw new StoreError(400, "bad_path", `An attachment path cannot end in .md: ${dest}.`);
      }
      if (dest !== row.path && this.pathRow(dest) && !moving.has(dest)) {
        throw new StoreError(
          409,
          "path_exists",
          `Cannot move to ${dest}: a file is already there.`,
        );
      }
    }
    for (const [row] of pairs) this.sql.run("DELETE FROM paths WHERE path = ?", row.path);
    const results: OpResult[] = [];
    for (const [row, dest] of pairs) {
      const seq = this.appendEvent(w.ctx, w.now, {
        op: "move",
        path: dest,
        prev_hash: row.hash,
        hash: row.hash,
        page_id: row.page_id,
        meta: { from_path: row.path },
      });
      this.setPath(dest, row.page_id, row.hash, row.kind, seq, row.created_seq);
      this.sql.run(
        "INSERT INTO redirects (old_path, page_id, since_seq) VALUES (?, ?, ?) ON CONFLICT(old_path) DO UPDATE SET page_id = excluded.page_id, since_seq = excluded.since_seq",
        row.path,
        row.page_id,
        seq,
      );
      this.healLinksTo(w, dest, row.page_id);
      results.push({ op: "move", path: dest, from: row.path, hash: row.hash, seq, lint: [] });
    }
    if (results.length === 0) throw notFound(input);
    return results;
  }

  private remove(w: WriteState, input: string, ifMatch?: string | null): OpResult {
    const p = normalizePath(input);
    const row = p ? this.lookupRow(p) : undefined;
    if (!row) throw notFound(input);
    if (!ifMatch) {
      throw new StoreError(
        428,
        "if_match_required",
        "Delete needs If-Match with the current hash.",
        {
          current_hash: row.hash,
        },
      );
    }
    if (ifMatch !== row.hash) {
      throw new StoreError(412, "precondition_failed", `${row.path} does not match If-Match.`, {
        current_hash: row.hash,
      });
    }
    this.refuseOpenThreads(row, "deleting it");
    const seq = this.appendEvent(w.ctx, w.now, {
      op: "delete",
      path: row.path,
      prev_hash: row.hash,
      hash: null,
      page_id: row.page_id,
    });
    this.dropPath(w, row);
    return { op: "delete", path: row.path, hash: null, seq, lint: [], ...this.brokenBy(row) };
  }

  /** A note naming the pages whose links a removal just broke (TEMPRA-49). */
  private brokenBy(row: PathRow): Pick<OpResult, "notices"> {
    const from = this.sql
      .all<{ path: string }>(
        `SELECT DISTINCT p.path FROM links l JOIN paths p ON p.page_id = l.from_id
         WHERE l.to_id = ? AND l.from_id <> ? ORDER BY p.path`,
        row.page_id,
        row.page_id,
      )
      .map((r) => r.path);
    if (from.length === 0) return {};
    return {
      notices: [
        {
          code: "broken_links",
          message: `${from.length} page${from.length === 1 ? " now links" : "s now link"} to ${row.path}, which is gone: ${from.join(", ")}. Fix the links, or revert the delete.`,
        },
      ],
    };
  }

  /**
   * A page with open comment threads is not deleted (tempra-dev: app/comments, TEMPRA-26): the
   * threads are people's requests, and a deleted page's threads are listed nowhere.
   */
  private refuseOpenThreads(row: PathRow, doing: string) {
    const open = this.sql.all<{ id: string }>(
      "SELECT id FROM threads WHERE page_id = ? AND status = 'open' ORDER BY created_seq",
      row.page_id,
    );
    if (open.length === 0) return;
    const ids = open.map((t) => t.id);
    throw new StoreError(
      409,
      "open_comments",
      `${row.path} has ${ids.length} open comment thread${ids.length === 1 ? "" : "s"} (${ids.join(", ")}); resolve ${ids.length === 1 ? "it" : "them"} before ${doing}. Read them with \`comments\`.`,
      { threads: ids },
    );
  }

  private dropPath(w: WriteState, row: PathRow) {
    this.sql.run("DELETE FROM paths WHERE path = ?", row.path);
    this.unindex(row.page_id);
    for (const r of this.sql.all<{ from_id: string }>(
      "SELECT DISTINCT from_id FROM links WHERE to_id = ?",
      row.page_id,
    )) {
      w.affected.add(r.from_id);
    }
  }

  // ---------------------------------------------------------------- revert

  private revertPath(w: WriteState, input: string, toSeq: number): OpResult[] {
    const p = normalizePath(input);
    if (!p) throw new StoreError(400, "bad_path", `Invalid path ${JSON.stringify(input)}.`);
    const then = this.snapshot(toSeq).lookup(p);
    const now = this.lookupRow(p);
    if (!then && !now) throw notFound(input);
    if (!then && now) return [this.restore(w, now.page_id, now.path, null, toSeq)];
    if (!then) return [];
    if (now && now.page_id !== then.page_id) {
      throw new StoreError(
        409,
        "path_occupied",
        `${now.path} now holds a different file than at seq ${toSeq}; move or delete it first.`,
      );
    }
    const elsewhere = this.sql.all<PathRow>(
      "SELECT path FROM paths WHERE page_id = ?",
      then.page_id,
    )[0];
    if (!now && elsewhere) {
      throw new StoreError(
        409,
        "moved",
        `The file at ${then.path} as of seq ${toSeq} now lives at ${elsewhere.path}; revert that path, or move it back first.`,
      );
    }
    if (now && now.hash === then.hash) return [];
    return [this.restore(w, then.page_id, then.path, then.hash, toSeq)];
  }

  private revertRequest(w: WriteState, requestId: string): OpResult[] {
    const events = this.sql.all<{ seq: number; page_id: string; op: string }>(
      "SELECT seq, page_id, op FROM events WHERE request_id = ? ORDER BY seq",
      requestId,
    );
    const first = events[0];
    if (!first) throw new StoreError(404, "not_found", `No request ${requestId}.`);
    const base = first.seq - 1;
    const before = this.snapshot(base);
    // Verifications and comments are not content: reverting a request leaves them be.
    const ids = [
      ...new Set(
        events.filter((e) => e.op !== "verify" && e.op !== "comment").map((e) => e.page_id),
      ),
    ];
    const plan = ids.map((id) => ({
      id,
      before: before.byId.get(id),
      now: this.sql.all<PathRow>(
        "SELECT path, page_id, hash, kind, last_seq AS seq, created_seq FROM paths WHERE page_id = ?",
        id,
      )[0],
    }));
    const results: OpResult[] = [];
    // Deletions first, then moves back, then content, so paths free up before they are reused.
    for (const { id, before: b, now } of plan) {
      if (!b && now) results.push(this.restore(w, id, now.path, null, base));
    }
    for (const { before: b, now } of plan) {
      if (b && now && now.path !== b.path) results.push(...this.move(w, now.path, b.path));
    }
    for (const { id, before: b } of plan) {
      if (!b) continue;
      const cur = this.sql.all<PathRow>(
        "SELECT path, page_id, hash, kind, last_seq AS seq, created_seq FROM paths WHERE page_id = ?",
        id,
      )[0];
      if (cur && cur.hash === b.hash) continue;
      results.push(this.restore(w, id, b.path, b.hash, base));
    }
    return results;
  }

  /** Points a page at an earlier content version (or none) with a `revert` event. */
  private restore(
    w: WriteState,
    pageId: string,
    path: string,
    hash: string | null,
    revertedSeq: number,
  ): OpResult {
    const cur = this.pathRow(path);
    if (cur && cur.page_id !== pageId) {
      throw new StoreError(409, "path_occupied", `Cannot restore ${path}: another file is there.`);
    }
    if (hash === null && cur) this.refuseOpenThreads(cur, "reverting it away");
    const kind: Kind | null =
      hash === null ? null : this.blobInfo(hash).location === "r2" ? "attachment" : "page";
    const meta: JsonObject = { reverted_seq: revertedSeq };
    // Back to an earlier version of a page: how much of its text changed, as for a write.
    if (hash !== null && kind === "page" && cur?.kind === "page") {
      meta.words = wordChange(
        docText(this.record(cur.hash).doc).text,
        docText(this.record(hash).doc).text,
      );
    }
    const seq = this.appendEvent(w.ctx, w.now, {
      op: "revert",
      path,
      prev_hash: cur?.hash ?? null,
      hash,
      page_id: pageId,
      meta,
    });
    if (hash === null || kind === null) {
      if (!cur) return { op: "revert", path, hash, seq, lint: [] };
      this.dropPath(w, cur);
      return { op: "revert", path, hash, seq, lint: [], ...this.brokenBy(cur) };
    }
    const created = this.sql.all<{ s: number }>(
      "SELECT MIN(seq) AS s FROM events WHERE page_id = ?",
      pageId,
    )[0]?.s;
    this.setPath(path, pageId, hash, kind, seq, cur?.created_seq ?? created ?? seq);
    let lint: LintWarning[] = [];
    if (kind === "page") {
      const r = this.record(hash);
      lint = this.fieldLint(r, path, this.verifiedAt(pageId, seq), true);
      lint.push(...this.renderLint(w, pageId, path, hash, r.doc));
      this.indexPage(pageId, path, r, lint, seq);
      w.written.set(path, pageId);
    }
    this.healLinksTo(w, path, pageId);
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
    this.sql.run("DELETE FROM paths WHERE page_id = ? AND path <> ?", id, path);
    this.sql.run(
      `INSERT INTO paths (path, page_id, hash, kind, last_seq, created_seq) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(path) DO UPDATE SET page_id = excluded.page_id, hash = excluded.hash,
         kind = excluded.kind, last_seq = excluded.last_seq, created_seq = excluded.created_seq`,
      path,
      id,
      hash,
      kind,
      seq,
      created,
    );
  }

  /** The page a path names: an existing path, a file created in this request, or a redirect. */
  private resolvePath(p: string, w: WriteState): string | null {
    return (
      this.lookupRow(p)?.page_id ??
      w.pending.get(p) ??
      (p.endsWith(".md") ? undefined : w.pending.get(`${p}.md`)) ??
      this.sql.all<{ page_id: string }>(
        "SELECT r.page_id FROM redirects r JOIN paths p ON p.page_id = r.page_id WHERE r.old_path IN (?, ?)",
        p,
        `${p}.md`,
      )[0]?.page_id ??
      null
    );
  }

  /**
   * Resolves each body link and each internal `sources[].resource` of a record written at `path`
   * to a page ID (spec: Page model, Links).
   */
  private resolveTargets(r: PageRecord, path: string, w: WriteState) {
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

  private indexPage(id: string, path: string, r: PageRecord, lint: LintWarning[], seq: number) {
    const typed = new Set([
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
    const staleAfter = str(field(r, "stale_after"));
    const before = this.sql.all<{ stale_after: string | null }>(
      "SELECT stale_after FROM pages WHERE page_id = ?",
      id,
    )[0];
    this.sql.run(
      `INSERT INTO pages (page_id, title, description, resource, status, stale_after,
         stale_ms, generated_by, generated_at, extra, lint)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(page_id) DO UPDATE SET title = excluded.title,
         description = excluded.description, resource = excluded.resource, status = excluded.status,
         stale_after = excluded.stale_after, stale_ms = excluded.stale_ms,
         generated_by = excluded.generated_by, generated_at = excluded.generated_at,
         extra = excluded.extra, lint = excluded.lint`,
      id,
      str(field(r, "title")),
      str(field(r, "description")),
      str(field(r, "resource")),
      effectiveStatus(field(r, "status")),
      staleAfter,
      staleTime(staleAfter),
      gen ? str(gen.by) : null,
      gen ? str(gen.at) : null,
      JSON.stringify(extra),
      JSON.stringify(lint),
    );
    // Tags, links and sources: only the rows that changed are written (TEMPRA-293). Deleting and
    // inserting them all rewrote a page's every source and link on a one-word edit.
    const tags = tagsOf(r);
    this.syncRows(
      "tags",
      "page_id",
      id,
      ["tag"],
      [...new Set(tags)].map((t) => [t]),
    );
    this.syncRows(
      "links",
      "from_id",
      id,
      ["to_id", "to_path", "anchor", "form", "raw", "kind"],
      linkGraph(r).map(([l, kind]) => [l.target, l.path, l.anchor, l.form, l.raw, kind]),
    );
    const sources = field(r, "sources");
    const sourceRows: SqlValue[][] = [];
    if (Array.isArray(sources)) {
      const counts = scanDoc(r.doc, path).footnoteCounts;
      sources.forEach((s, i) => {
        if (!s || typeof s !== "object" || Array.isArray(s)) return;
        const resource = str(s.resource);
        if (!resource) return;
        const sid = str(s.id);
        sourceRows.push([
          sid,
          resource,
          r.sources?.find((x) => x.index === i)?.target ?? null,
          sid ? (counts.get(sid) ?? 0) : 0,
        ]);
      });
    }
    this.syncRows("sources", "page_id", id, ["id", "resource", "internal_id", "cited"], sourceRows);

    this.dropSearchRow(id);
    this.sql.run(
      "INSERT INTO fts (page_id, title, body, tags) VALUES (?, ?, ?, ?)",
      id,
      str(field(r, "title")) ?? "",
      searchText(r.doc),
      tags.join(" "),
    );
    this.sql.run("INSERT INTO fts_rows (page_id, fts_rowid) VALUES (?, last_insert_rowid())", id);

    this.setLintFlag(id, lint, seq);

    // Only a new stale_after moves the clock (TEMPRA-63): any other write leaves the flags as
    // the staleness process last set them.
    if (!before || before.stale_after !== staleAfter) this.setStaleFlag(id, staleAfter, seq);
  }

  /**
   * Makes a page's rows in `table` (keyed by `key` = `id`) the given `rows` of `cols`, writing
   * only the difference (TEMPRA-293): rows already there stay, missing ones are inserted and
   * extra ones deleted, matched as a multiset. Order is not kept, and nothing reads these
   * tables in insertion order.
   */
  private syncRows(table: string, key: string, id: string, cols: string[], rows: SqlValue[][]) {
    const sig = (r: SqlValue[]) => JSON.stringify(r);
    const want = new Map<string, SqlValue[][]>();
    for (const r of rows) {
      const k = sig(r);
      const list = want.get(k);
      if (list) list.push(r);
      else want.set(k, [r]);
    }
    const stale: number[] = [];
    for (const have of this.sql.all<SqlRow>(
      `SELECT rowid AS rid, ${cols.join(", ")} FROM ${table} WHERE ${key} = ?`,
      id,
    )) {
      const k = sig(cols.map((c) => have[c] ?? null));
      const list = want.get(k);
      if (list && list.length > 0) list.pop();
      else stale.push(Number(have.rid));
    }
    if (stale.length > 0) {
      this.sql.run(
        `DELETE FROM ${table} WHERE rowid IN (SELECT value FROM json_each(?))`,
        JSON.stringify(stale),
      );
    }
    const insert = `INSERT INTO ${table} (${key}, ${cols.join(", ")}) VALUES (${["?", ...cols.map(() => "?")].join(", ")})`;
    for (const list of want.values()) for (const r of list) this.sql.run(insert, id, ...r);
  }

  /** Sets a page's stale or stale_soon flag from its `stale_after`, clearing the other. */
  private setStaleFlag(id: string, staleAfter: string | null, seq: number): Staleness | null {
    // The clock is read only when there is a date to weigh (tests count its calls).
    const now = staleAfter === null ? null : this.clock();
    const state = now ? staleness(staleAfter ?? undefined, now.getTime()) : null;
    this.sql.run(
      "DELETE FROM flags WHERE page_id = ? AND kind IN ('stale', 'stale_soon') AND kind IS NOT ?",
      id,
      state,
    );
    if (state) {
      this.sql.run(
        `INSERT INTO flags (page_id, kind, since_seq, detail) VALUES (?, ?, ?, ?)
         ON CONFLICT(page_id, kind) DO UPDATE SET detail = excluded.detail`,
        id,
        state,
        seq,
        JSON.stringify({ stale_after: staleAfter, at: iso(now ?? this.clock()) }),
      );
    }
    return state;
  }

  private unindex(id: string) {
    for (const t of ["pages", "tags", "sources", "flags"]) {
      this.sql.run(`DELETE FROM ${t} WHERE page_id = ?`, id);
    }
    this.sql.run("DELETE FROM links WHERE from_id = ?", id);
    this.dropSearchRow(id);
  }

  /**
   * Points links written before `path` existed (or whose target was deleted) at its page, and
   * marks every page linking to it for a refresh: a restored page's inbound links still
   * name it by ID, and their broken-link lint must clear (TEMPRA-25).
   */
  private healLinksTo(w: WriteState, path: string, id: string) {
    const variants = [path, path.endsWith(".md") ? path.slice(0, -3) : `${path}.md`];
    const where = `(to_path = ? OR to_path = ?) AND (to_id IS NULL OR NOT EXISTS (SELECT 1 FROM paths p WHERE p.page_id = links.to_id))`;
    const from = this.sql.all<{ from_id: string }>(
      `SELECT DISTINCT from_id FROM links WHERE ${where}`,
      ...variants,
    );
    if (from.length > 0) this.sql.run(`UPDATE links SET to_id = ? WHERE ${where}`, id, ...variants);
    for (const r of from) w.affected.add(r.from_id);
    for (const r of this.sql.all<{ from_id: string }>(
      "SELECT DISTINCT from_id FROM links WHERE to_id = ? AND from_id <> ?",
      id,
      id,
    )) {
      w.affected.add(r.from_id);
    }
  }

  /**
   * Recomputes a page's broken links: its broken_link flag and the broken_link entries in its
   * stored lint. Returns them as lint.
   */
  private refreshBroken(id: string): LintWarning[] {
    const broken = this.sql.all<{ to_path: string; raw: string; kind: string }>(
      `SELECT to_path, raw, kind FROM links WHERE from_id = ?
         AND (to_id IS NULL OR NOT EXISTS (SELECT 1 FROM paths p WHERE p.page_id = links.to_id))`,
      id,
    );
    const exists = this.sql.all("SELECT 1 FROM paths WHERE page_id = ?", id).length > 0;
    const lint = exists ? broken.map((b) => brokenLink(b.kind, b.raw, b.to_path)) : [];
    const stored = this.sql.all<{ lint: string | null }>(
      "SELECT lint FROM pages WHERE page_id = ?",
      id,
    )[0];
    // Written only when it changed (TEMPRA-293): a write refreshes every page linking to it.
    if (stored) {
      const others = (JSON.parse(stored.lint ?? "[]") as LintWarning[]).filter(
        (l) => l.code !== "broken_link",
      );
      const next = JSON.stringify([...others, ...lint]);
      if (next !== (stored.lint ?? "[]")) {
        this.sql.run("UPDATE pages SET lint = ? WHERE page_id = ?", next, id);
      }
    }
    const flag = this.sql.all<{ detail: string | null }>(
      "SELECT detail FROM flags WHERE page_id = ? AND kind = 'broken_link'",
      id,
    )[0];
    if (lint.length === 0) {
      if (flag) this.sql.run("DELETE FROM flags WHERE page_id = ? AND kind = 'broken_link'", id);
      return [];
    }
    const detail = JSON.stringify(broken.map((b) => b.to_path));
    if (flag?.detail === detail) return lint;
    this.sql.run(
      `INSERT INTO flags (page_id, kind, since_seq, detail) VALUES (?, 'broken_link', ?, ?)
       ON CONFLICT(page_id, kind) DO UPDATE SET detail = excluded.detail`,
      id,
      this.headSeq(),
      detail,
    );
    return lint;
  }

  /**
   * Figure lint that depends on what a page's images point to (TEMPRA-159, format/images.ts):
   * recomputed, like broken links, when the page is written or an attachment it shows is
   * replaced, retyped or deleted. Kept in the stored lint and the page's lint flag (`work`).
   */
  private refreshImages(snap: View, id: string): LintWarning[] {
    const e = snap.byId.get(id);
    const stored = this.sql.all<{ lint: string | null }>(
      "SELECT lint FROM pages WHERE page_id = ?",
      id,
    )[0];
    if (e?.kind !== "page" || !stored) return [];
    const lint = this.imageTargets(snap, this.record(e.hash));
    const before = JSON.parse(stored.lint ?? "[]") as LintWarning[];
    const others = before.filter((l) => !IMAGE_TARGET_CODES.has(l.code));
    if (others.length === before.length && lint.length === 0) return [];
    const all = [...others, ...lint];
    this.sql.run("UPDATE pages SET lint = ? WHERE page_id = ?", JSON.stringify(all), id);
    this.setLintFlag(id, all, this.headSeq());
    return lint;
  }

  /**
   * Libraries linted before TEMPRA-163 hold `image_external` in their lint flags: moved once into
   * `external_image` flags, so the same image is never listed under both kinds.
   */
  private addExternalImageFlags() {
    if (this.sql.all("SELECT 1 FROM meta WHERE key = 'external_image_flags'").length > 0) return;
    this.sql.transaction(() => {
      for (const f of this.sql.all<{ page_id: string; since_seq: number; detail: string }>(
        "SELECT page_id, since_seq, detail FROM flags WHERE kind = 'lint' AND detail LIKE '%image_external%'",
      )) {
        this.setLintFlag(f.page_id, JSON.parse(f.detail) as LintWarning[], f.since_seq);
      }
      this.sql.run("INSERT INTO meta (key, value) VALUES ('external_image_flags', '1')");
    });
  }

  /** The target-dependent figure lint of a page version, as of the snapshot. */
  private imageTargets(snap: View, r: PageRecord): LintWarning[] {
    return imageTargetLint(imageLinks(r.doc, r.links), (l) => {
      const t = this.targetAt(snap, l);
      if (t?.kind !== "attachment") return null;
      return (
        this.sql.all<{
          size: number;
          media: string | null;
          width: number | null;
          height: number | null;
        }>("SELECT size, media, width, height FROM blobs WHERE hash = ?", t.hash)[0] ?? null
      );
    });
  }

  // ---------------------------------------------------------------- reads

  /** The href to render for a link, as of the snapshot (spec: Page model, Reads and export). */
  private href(snap: View, from: Entry, link: StoredLink | StoredSource): string {
    if (isDerivedTarget(link)) return link.raw;
    const target = this.targetAt(snap, link);
    if (!target) return link.raw;
    const written = splitAnchor(link.raw).path;
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
    // A link written as a page ID (no `.md`) keeps that form.
    if (!written.endsWith(".md") && next.endsWith(".md")) next = next.slice(0, -3);
    return next + (link.anchor ?? "");
  }

  /** A link's target as of the snapshot: by ID, else by path, else through a redirect. */
  private targetAt(snap: View, link: { path: string; target: string | null }) {
    let target = link.target ? snap.byId.get(link.target) : undefined;
    if (!target) target = snap.lookup(link.path);
    if (!target) {
      const id = this.redirectAt(link.path, snap.seq);
      if (id) target = snap.byId.get(id);
    }
    return target;
  }

  /**
   * `diagram_unrendered` lint for a page version's diagrams from Pele's known verdicts
   * (TEMPRA-167), and, inside a write, a render job for those the fast check passed whose verdict
   * is not known yet (up to RENDERS_PER_WRITE in the request). Synchronous: the render itself is
   * the Worker's, after the commit.
   */
  private renderLint(
    w: WriteState | null,
    pageId: string,
    path: string,
    hash: string,
    doc: Doc,
  ): LintWarning[] {
    // Mermaid by Pele, and charts by Vega (TEMPRA-207), each verdict kept by its renderer's
    // version and the source's hash.
    const fences = [
      ...checkedFences(doc).map((f) => ({ f, lang: undefined })),
      ...checkedCharts(doc).map((f) => ({ f, lang: "vega-lite" as const })),
    ];
    if (fences.length === 0) return [];
    const out: LintWarning[] = [];
    const unknown: RenderJob["diagrams"] = [];
    for (const { f, lang } of fences) {
      // The message's format too (TEMPRA-184): a verdict kept in an older shape is asked again.
      const key = lang
        ? `vl-${VEGA_LITE_VERSION}:${sha256Hex(f.source)}`
        : `${this.peleVersion}:m${PELE_MESSAGE_FORMAT}:${sha256Hex(f.source)}`;
      const row = this.sql.all<{ error: string | null }>(
        "SELECT error FROM diagram_renders WHERE key = ?",
        key,
      )[0];
      if (!row) {
        if (!unknown.some((u) => u.key === key)) {
          unknown.push({ key, source: f.source, ...(lang ? { lang } : {}) });
        }
      } else if (row.error) {
        const e = JSON.parse(row.error) as RenderFailure;
        out.push(lang ? chartRenderWarning(f, e) : unrenderedWarning(f, e));
      }
    }
    if (w && unknown.length > 0) {
      const room = RENDERS_PER_WRITE - w.renders.reduce((n, j) => n + j.diagrams.length, 0);
      const diagrams = unknown.slice(0, Math.max(0, room));
      if (diagrams.length > 0) w.renders.push({ page_id: pageId, path, hash, diagrams });
    }
    return out;
  }

  /**
   * Keeps Pele's verdicts from the render service and, for each page still at the version
   * they were asked for, replaces its `diagram_unrendered` lint (TEMPRA-167); a page that has
   * moved on keeps its lint, as its newer write asked for its own. Not a write: no ledger event,
   * no new version. Returns each updated page's `diagram_unrendered` lint by path.
   */
  setDiagramRenders(
    jobs: { page_id: string; hash: string; verdicts: RenderVerdict[] }[],
  ): { path: string; hash: string; lint: LintWarning[] }[] {
    return this.sql.transaction(() => {
      for (const j of jobs) {
        for (const v of j.verdicts) {
          this.sql.run(
            "INSERT OR REPLACE INTO diagram_renders (key, error) VALUES (?, ?)",
            v.key,
            v.error ? JSON.stringify(v.error) : null,
          );
        }
      }
      const out: { path: string; hash: string; lint: LintWarning[] }[] = [];
      for (const j of jobs) {
        const row = this.sql.all<{ path: string; hash: string; kind: string; last_seq: number }>(
          "SELECT path, hash, kind, last_seq FROM paths WHERE page_id = ?",
          j.page_id,
        )[0];
        if (row?.kind !== "page" || row.hash !== j.hash) continue;
        const stored = this.sql.all<{ lint: string | null }>(
          "SELECT lint FROM pages WHERE page_id = ?",
          j.page_id,
        )[0];
        if (!stored) continue;
        const unrendered = this.renderLint(
          null,
          j.page_id,
          row.path,
          row.hash,
          this.record(row.hash).doc,
        );
        const lint = [
          ...(JSON.parse(stored.lint ?? "[]") as LintWarning[]).filter(
            (l) => l.code !== "diagram_unrendered" && !l.rendered,
          ),
          ...unrendered,
        ];
        this.sql.run(
          "UPDATE pages SET lint = ? WHERE page_id = ?",
          JSON.stringify(lint),
          j.page_id,
        );
        this.setLintFlag(j.page_id, lint, row.last_seq);
        out.push({ path: row.path, hash: row.hash, lint: unrendered });
      }
      return out;
    });
  }

  /**
   * A page's lint flags from its stored lint: hotlinked images (`image_external`) are their own
   * kind of work, `external_image` (TEMPRA-163), so they are never listed twice; the rest is
   * `lint`; broken links have their own flag (refreshBroken). A flag already set keeps its
   * `since_seq`.
   */
  private setLintFlag(id: string, lint: LintWarning[], seq: number) {
    const external = lint.filter((l) => l.code === "image_external");
    const rest = lint.filter((l) => l.code !== "broken_link" && l.code !== "image_external");
    for (const [kind, found] of [
      ["lint", rest],
      ["external_image", external],
    ] as const) {
      if (found.length > 0) {
        this.sql.run(
          `INSERT INTO flags (page_id, kind, since_seq, detail) VALUES (?, ?, ?, ?)
           ON CONFLICT(page_id, kind) DO UPDATE SET detail = excluded.detail`,
          id,
          kind,
          seq,
          JSON.stringify(found),
        );
      } else {
        this.sql.run("DELETE FROM flags WHERE page_id = ? AND kind = ?", id, kind);
      }
    }
  }

  /** Field lint of a content version, as a write of it would report (spec: the page format). */
  private fieldLint(
    r: PageRecord,
    path: string,
    verified: Verification[],
    strict = false,
  ): LintWarning[] {
    if (r.raw_fm !== null) {
      return [
        { code: "unparseable_frontmatter", message: "Frontmatter could not be parsed as YAML." },
        ...diagramLint(r.doc),
        ...figureLint(r.doc),
        ...imageLint(r.doc),
      ];
    }
    return [
      ...lintFields(r.fm, r.generated, verified, scanDoc(r.doc, path), { strict }),
      ...diagramLint(r.doc),
      ...figureLint(r.doc),
      ...imageLint(r.doc),
    ];
  }

  /** Lint of a past version: its field lint and its links that were broken as of the snapshot. */
  private lintAt(snap: Snapshot, e: Entry, r: PageRecord, verified: Verification[]) {
    const lint = this.fieldLint(r, e.path, verified);
    for (const [l, kind] of linkGraph(r)) {
      if (!this.targetAt(snap, l)) lint.push(brokenLink(kind, l.raw, l.path));
    }
    lint.push(...this.imageTargets(snap, r));
    return lint;
  }

  private renderEntry(
    snap: View,
    e: Entry,
    computed: boolean,
    unstamped = false,
    okf = false,
  ): string {
    const stored = this.record(e.hash);
    const r = okfTyped(unstamped ? { ...stored, generated: null } : stored, okf);
    const verified = this.verifiedAt(e.page_id, snap.seq);
    return renderPage(r, {
      verified,
      href: (l) => this.href(snap, e, l),
      sourceHref: (s) => this.href(snap, e, s),
      computed: computed ? this.computedValues(snap, e, r, verified) : undefined,
    });
  }

  private computedValues(snap: View, e: Entry, r: PageRecord, verified: Verification[]) {
    const out: [string, Json][] = [
      ["trust_tier", trustTier(r.generated, verified)],
      ["stale", isStale(field(r, "stale_after"), this.clock().getTime())],
    ];
    if (snap.seq === this.headSeq()) {
      out.push(["inbound_links", this.inboundCount(e.page_id)]);
      out.push(["usage_count", this.usageCount(e.page_id)]);
    }
    return out;
  }

  /**
   * One more read of a page's current version today (spec: usage-rollup maintainer), counted
   * in memory so a read does not write (TEMPRA-87). Flushed to `access_log` by the next write,
   * every READ_FLUSH reads, before the usage pass, and by the Durable Object's alarm. It carries
   * the call's reader (TEMPRA-220); the app's reads are not counted here but from the page it
   * shows (`viewed`), so its prefetches and background re-checks never count.
   */
  private countRead(id: string, shown = false) {
    const r = this.reader;
    if (r?.surface === "app" && !shown) return;
    const now = iso(this.clock());
    const day = now.slice(0, 10);
    let counts = this.reads.get(day);
    if (!counts) {
      counts = new Map();
      this.reads.set(day, counts);
    }
    const surface = r?.surface ?? "";
    const kind = r?.kind ?? "";
    const reader = r?.reader ?? "";
    const key = `${id}\u001f${surface}\u001f${kind}\u001f${reader}`;
    const pending = counts.get(key);
    if (pending) pending.n++;
    else counts.set(key, { id, surface, kind, reader, n: 1 });
    if (r) {
      const k = `${id}\u001f${r.surface}`;
      const kept = this.lastReads.get(k);
      if (!kept || kept.at < now) this.lastReads.set(k, { id, surface: r.surface, at: now });
    }
    if (++this.unflushed >= READ_FLUSH) this.flushReads();
  }

  /**
   * The app's read of a page it shows (TEMPRA-220, `POST …/read/{path}`): one per page a person
   * opens, at head. Answers the page's read history with it counted.
   */
  viewed(input: string): { path: string; reads: ReadHistory } {
    const snap = this.snapshot();
    const path = normalizePath(input) ?? "";
    const e = snap.lookup(path);
    if (!e || e.kind !== "page") throw notFound(input);
    this.countRead(e.page_id, true);
    return { path: e.path, reads: this.readHistoryOf(e.page_id) };
  }

  /** Reads counted in memory and not yet in `access_log`. */
  pendingReads(): number {
    return this.unflushed;
  }

  /** Writes the reads counted in memory to `access_log` and `last_read`, in one transaction. */
  flushReads(): number {
    const n = this.unflushed;
    if (n === 0) return 0;
    this.sql.transaction(() => {
      for (const [day, counts] of this.reads) {
        for (const p of counts.values()) {
          this.sql.run(
            `INSERT INTO access_log (day, page_id, surface, kind, actor, reads) VALUES (?, ?, ?, ?, ?, ?)
             ON CONFLICT(page_id, day, surface, kind, actor) DO UPDATE SET reads = reads + excluded.reads`,
            day,
            p.id,
            p.surface,
            p.kind,
            p.reader,
            p.n,
          );
        }
      }
      for (const l of this.lastReads.values()) {
        this.sql.run(
          `INSERT INTO last_read (page_id, surface, at) VALUES (?, ?, ?)
           ON CONFLICT(page_id, surface) DO UPDATE SET at = MAX(at, excluded.at)`,
          l.id,
          l.surface,
          l.at,
        );
      }
    });
    this.reads.clear();
    this.lastReads.clear();
    this.unflushed = 0;
    return n;
  }

  /** Reads of a page over the usage window, today included, flushed or not. */
  private usageCount(id: string): number {
    const start = this.windowStart();
    let pending = 0;
    for (const [day, counts] of this.reads) {
      if (day < start) continue;
      for (const p of counts.values()) if (p.id === id) pending += p.n;
    }
    return (
      (this.sql.all<{ n: number }>(
        "SELECT COALESCE(SUM(reads), 0) AS n FROM access_log WHERE page_id = ? AND day >= ?",
        id,
        start,
      )[0]?.n ?? 0) + pending
    );
  }

  /**
   * Every page's reads over the usage window, flushed or not, for `pages`' sort: as the
   * read history counts them, each reader once per page and day, and reads from before
   * TEMPRA-220 (no reader) as they were.
   */
  private usageCounts(): Map<string, number> {
    const start = this.windowStart();
    const out = new Map<string, number>();
    const seen = new Set<string>();
    const add = (id: string, day: string, kind: string, reader: string, n: number) => {
      if (!reader) {
        out.set(id, (out.get(id) ?? 0) + n);
        return;
      }
      const key = `${id}|${day}|${kind}|${reader}`;
      if (seen.has(key)) return;
      seen.add(key);
      out.set(id, (out.get(id) ?? 0) + 1);
    };
    for (const r of this.sql.all<{
      id: string;
      day: string;
      kind: string;
      reader: string;
      n: number;
    }>(
      `SELECT page_id AS id, day, kind, actor AS reader, SUM(reads) AS n FROM access_log
       WHERE day >= ? GROUP BY page_id, day, kind, actor`,
      start,
    )) {
      add(r.id, r.day, r.kind, r.reader, r.n);
    }
    for (const [day, counts] of this.reads) {
      if (day < start) continue;
      for (const p of counts.values()) add(p.id, day, p.kind, p.reader, p.n);
    }
    return out;
  }

  /**
   * A page's read history (TEMPRA-220): the last 7 and 30 days by surface and by agent or
   * person, distinct readers as a count, and the last read per surface. Flushed or not.
   */
  private readHistoryOf(id: string): ReadHistory {
    const month = this.windowStart();
    const week = iso(new Date(this.clock().getTime() - (READ_WEEK_DAYS - 1) * 86_400_000)).slice(
      0,
      10,
    );
    const rows = this.sql.all<ReadRow>(
      `SELECT day, surface, kind, actor AS reader, SUM(reads) AS reads FROM access_log
       WHERE page_id = ? AND day >= ? GROUP BY day, surface, kind, actor`,
      id,
      month,
    );
    for (const [day, counts] of this.reads) {
      for (const p of counts.values()) {
        if (p.id === id) {
          rows.push({ day, surface: p.surface, kind: p.kind, reader: p.reader, reads: p.n });
        }
      }
    }
    const last: Record<string, string> = {};
    for (const r of this.sql.all<{ surface: string; at: string }>(
      "SELECT surface, at FROM last_read WHERE page_id = ?",
      id,
    )) {
      last[r.surface] = r.at;
    }
    for (const l of this.lastReads.values()) {
      const kept = last[l.surface];
      if (l.id === id && (!kept || kept < l.at)) last[l.surface] = l.at;
    }
    return readHistory(rows, last, { week, month });
  }

  private windowStart(): string {
    const start = new Date(this.clock().getTime() - (USAGE_WINDOW_DAYS - 1) * 86_400_000);
    return iso(start).slice(0, 10);
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

  /** GET /files/{path}: a page, an attachment's metadata, or a synthesized index.md / log.md. */
  read(
    input: string,
    opts: {
      at?: number;
      computed?: boolean;
      figures?: boolean;
      images?: boolean;
      /** The page's read history (TEMPRA-220), for MCP `read`. */
      reads?: boolean;
    } = {},
  ): FileView {
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
    if (!e) throw this.gone(input, path, snap.seq);
    if (e.kind === "attachment") {
      const info = this.blobInfo(e.hash);
      // A video and its poster name each other on their pages (TEMPRA-182).
      const poster = info.media?.startsWith("video/") ? this.posterOf(snap, e.path) : null;
      const posterFor = info.media?.startsWith("image/") ? this.videoOfPoster(snap, e.path) : null;
      return {
        kind: "attachment",
        path: e.path,
        hash: e.hash,
        seq: e.seq,
        size: info.size,
        media: info.media,
        ...(info.dims ?? {}),
        ...(poster ? { poster: { path: poster.path, ...poster.ref } } : {}),
        ...(posterFor ? { poster_for: posterFor } : {}),
        ...this.provenance(e.page_id, e.hash, snap.seq),
      };
    }
    const markdown = this.renderEntry(snap, e, opts.computed ?? false);
    const parsed = parsePage(markdown);
    const r = this.record(e.hash);
    const verified = this.verifiedAt(e.page_id, snap.seq);
    if (snap.seq === this.headSeq()) this.countRead(e.page_id);
    const frontmatter: JsonObject = Object.fromEntries(parsed.entries);
    if (parsed.generated) frontmatter.generated = parsed.generated;
    if (parsed.verified)
      frontmatter.verified = parsed.verified.map((v) => ({ by: v.by, at: v.at }));
    const atHead = snap.seq === this.headSeq();
    const lintRow = atHead
      ? this.sql.all<{ lint: string | null }>(
          "SELECT lint FROM pages WHERE page_id = ?",
          e.page_id,
        )[0]
      : undefined;
    const lint: LintWarning[] = [
      ...(atHead
        ? (JSON.parse(lintRow?.lint ?? "[]") as LintWarning[])
        : this.lintAt(snap, e, r, verified)),
      ...this.anchorLint(snap, e),
    ];
    const doc = renderDoc(r, (l) => this.href(snap, e, l));
    return {
      kind: "page",
      path: e.path,
      hash: e.hash,
      seq: e.seq,
      markdown,
      frontmatter,
      doc,
      lint,
      trust_tier: trustTier(r.generated, verified),
      stale: isStale(field(r, "stale_after"), this.clock().getTime()),
      stale_soon: staleness(field(r, "stale_after"), this.clock().getTime()) === "stale_soon",
      inbound_links: atHead ? this.inboundCount(e.page_id) : 0,
      open_comments: atHead ? this.openThreadsOf(e.page_id) : 0,
      ...(opts.figures ? { figures: this.figuresOf(snap, e, doc) } : {}),
      ...(opts.images ? { images: this.imagesOf(snap, e, doc) } : {}),
      ...(opts.reads ? { reads: this.readHistoryOf(e.page_id) } : {}),
    };
  }

  /** The attachments a page's images show, as of the snapshot (no bytes; TEMPRA-162). */
  private imagesOf(snap: View, e: Entry, doc: Doc): Record<string, ImageRef> {
    const out: Record<string, ImageRef> = {};
    walkDoc(doc, (n) => {
      if (n.type !== "image") return undefined;
      const t = linkTarget(e.path, n.url);
      if (t?.kind !== "internal" || t.dir || t.path === "" || t.path in out) return undefined;
      const a = snap.lookup(t.path);
      if (a?.kind !== "attachment") return undefined;
      const ref = this.imageRef(a.hash);
      if (ref.media?.startsWith("video/")) {
        const poster = this.posterOf(snap, t.path);
        if (poster) ref.poster = poster.ref;
      }
      out[t.path] = ref;
      return undefined;
    });
    return out;
  }

  private imageRef(hash: string): ImageRef {
    const info = this.blobInfo(hash);
    return {
      hash,
      media: info.media,
      size: info.size,
      ...(info.dims ? { width: info.dims.width, height: info.dims.height } : {}),
    };
  }

  /**
   * A video's poster, the image attached beside it (`demo.mp4` -> `demo.poster.png`, or .jpg,
   * .jpeg, .webp, .avif; TEMPRA-164), as the reader and the video's own page show it (TEMPRA-182).
   */
  private posterOf(snap: View, videoPath: string): { path: string; ref: ImageRef } | null {
    const stem = videoPath.replace(/\.[^./]+$/, "");
    for (const ext of POSTER_EXTENSIONS) {
      const path = `${stem}.poster.${ext}`;
      const p = snap.lookup(path);
      if (p?.kind !== "attachment") continue;
      const ref = this.imageRef(p.hash);
      if (ref.media?.startsWith("image/")) return { path, ref };
    }
    return null;
  }

  /** The video an image is the poster of, by `posterOf`'s naming, for the poster's page (TEMPRA-182). */
  private videoOfPoster(snap: View, posterPath: string): string | null {
    const m = /^(.*)\.poster\.([a-z]+)$/.exec(posterPath);
    if (!m || !POSTER_EXTENSIONS.includes(m[2] as string)) return null;
    for (const ext of VIDEO_EXTENSIONS) {
      const path = `${m[1]}.${ext}`;
      const v = snap.lookup(path);
      if (v?.kind !== "attachment" || !this.blobInfo(v.hash).media?.startsWith("video/")) continue;
      if (this.posterOf(snap, path)?.path === posterPath) return path;
    }
    return null;
  }

  /** A page's figures, each attachment from its blob row (no bytes; TEMPRA-154). */
  private figuresOf(snap: View, e: Entry, doc: Doc): FigureFact[] {
    return figureFacts(doc, e.path, (path) => {
      const a = snap.lookup(path);
      if (a?.kind !== "attachment") return null;
      const info = this.blobInfo(a.hash);
      return {
        hash: a.hash,
        size: info.size,
        media: info.media,
        // Null when never worked out, 0 when worked out and unknown (blobInfo's dims).
        width: info.dims === null ? null : (info.dims.width ?? 0),
        height: info.dims === null ? null : (info.dims.height ?? 0),
      };
    });
  }

  /**
   * A 404 for a path with nothing there now that says what became of it: moved (and where), or
   * deleted (and how to bring it back). Saves a `log` or `grep` call.
   */
  private gone(input: string, path: string, at: number): StoreError {
    const variants = [path, path.endsWith(".md") ? path.slice(0, -3) : `${path}.md`];
    const last = this.sql.all<{ seq: number; op: string; path: string; page_id: string }>(
      `SELECT seq, op, path, page_id FROM events
       WHERE seq <= ? AND op != 'comment' AND (path IN (?, ?) OR json_extract(meta, '$.from_path') IN (?, ?))
       ORDER BY seq DESC LIMIT 1`,
      at,
      ...variants,
      ...variants,
    )[0];
    if (!last) return notFound(input);
    const now = this.snapshot(at).byId.get(last.page_id);
    if (now && now.path !== path) {
      return new StoreError(
        404,
        "moved",
        `No file at ${input}: it moved to ${now.path} (seq ${last.seq}). Read it there.`,
        { moved_to: now.path, seq: last.seq },
      );
    }
    if (last.op === "delete" || (last.op === "revert" && !now)) {
      return new StoreError(
        404,
        "deleted",
        `No file at ${input}: it was deleted at seq ${last.seq}. \`revert\` with to_seq ${last.seq - 1} brings it back.`,
        { seq: last.seq },
      );
    }
    return notFound(input);
  }

  /** The synthesized index.md for a directory (spec: Tier 2). */
  index(dirInput: string, snapOrAt?: Snapshot | number, opts: { okf?: boolean } = {}): string {
    const snap = snapOrAt instanceof Snapshot ? snapOrAt : this.snapshot(snapOrAt);
    const dir = normalizeDir(dirInput);
    const subdirs = new Map<string, number>();
    const pages: { path: string; title: string | null; description: string | null }[] = [];
    const attachments: { path: string }[] = [];
    let any = dir === "";
    for (const e of snap.sorted()) {
      if (!underPrefix(e.path, dir) || e.path === dir) continue;
      any = true;
      const rest = dir === "" ? e.path : e.path.slice(dir.length + 1);
      const slash = rest.indexOf("/");
      if (slash !== -1) {
        const name = rest.slice(0, slash);
        subdirs.set(name, (subdirs.get(name) ?? 0) + (e.kind === "page" ? 1 : 0));
      } else if (e.kind === "page") {
        const r = this.record(e.hash);
        pages.push({
          path: e.path,
          title: str(field(r, "title")),
          description: str(field(r, "description")),
        });
      } else attachments.push({ path: e.path });
    }
    if (!any) throw notFound(dir ? `${dir}/index.md` : "index.md");
    return renderIndex(
      {
        dir,
        subdirs: [...subdirs].map(([name, n]) => ({ name, pages: n })),
        pages,
        attachments,
      },
      opts,
    );
  }

  /**
   * The synthesized log.md: requests newest first, grouped by day (spec: Tier 2). It shows the
   * latest `limit` requests (LOG_REQUESTS by default) and then where the rest are; `limit: null`
   * lists them all, as exports do.
   */
  log(opts: { at?: number; prefix?: string; limit?: number | null } = {}): string {
    const at = opts.at ?? this.headSeq();
    const prefix = normalizeDir(opts.prefix);
    const limit = opts.limit === undefined ? LOG_REQUESTS : opts.limit;
    const snap = this.snapshot(at);
    // log.md tells what changed in the content; comments are not content. Filtered in SQL, and
    // meta parsed only where the log reads it (TEMPRA-86).
    type LogEvent = {
      seq: number;
      ts: string;
      actor: string;
      request_id: string;
      op: string;
      path: string;
      prev_hash: string | null;
      page_id: string;
      meta: string | null;
    };
    const page = (before: number, n: number) =>
      this.sql.all<LogEvent>(
        `SELECT seq, ts, actor, request_id, op, path, prev_hash, page_id, meta FROM events
         WHERE seq <= ? AND op != 'comment' AND (? = '' OR path = ? OR substr(path, 1, ?) = ?)
         ORDER BY seq DESC LIMIT ?`,
        before,
        prefix,
        prefix,
        prefix.length + 1,
        `${prefix}/`,
        n,
      );
    let events: LogEvent[];
    let older: number | null = null;
    if (limit === null) events = page(at, -1);
    else {
      // A request's events are consecutive seqs, so walking back from `at` in pages and stopping
      // at the first event of request limit + 1 reads what the log shows and no more (TEMPRA-86).
      events = [];
      const seen = new Set<string>();
      let cursor = at;
      walk: for (;;) {
        const rows = page(cursor, 1000);
        for (const e of rows) {
          if (!seen.has(e.request_id)) {
            if (seen.size === limit) {
              older = events.at(-1)?.seq ?? at + 1;
              break walk;
            }
            seen.add(e.request_id);
          }
          events.push(e);
        }
        if (rows.length < 1000) break;
        cursor = (rows.at(-1) as LogEvent).seq - 1;
      }
    }
    const byReq = new Map<string, (typeof events)[number][]>();
    for (const e of events) {
      const list = byReq.get(e.request_id);
      if (list) list.push(e);
      else byReq.set(e.request_id, [e]);
    }
    const meta = (m: string | null) => (m ? (JSON.parse(m) as JsonObject) : null);
    const out: LogRequest[] = [];
    for (const evs of byReq.values()) {
      evs.reverse();
      const first = evs[0];
      out.push({
        ts: first?.ts ?? "",
        actor: first?.actor ?? "",
        note: (meta(first?.meta ?? null)?.note as string | undefined) ?? null,
        events: evs.map((e) => {
          const from = e.op === "move" ? meta(e.meta)?.from_path : undefined;
          return {
            op: e.op,
            path: e.path,
            created: e.prev_hash === null,
            fromPath: typeof from === "string" ? from : null,
            // Entries link to where the file is now (as of `at`), or to nothing once it is gone.
            current: snap.byId.get(e.page_id)?.path ?? null,
          };
        }),
      });
    }
    return renderLog(out, prefix ? `Log: ${prefix}` : "Library log", {
      before: older,
      prefix,
    });
  }

  private toRequest(id: string, events: EventRow[]): RequestRow {
    const first = events[0];
    return {
      request_id: id,
      ts: first?.ts ?? "",
      actor: first?.actor ?? "",
      note: (first?.meta?.note as string | undefined) ?? null,
      by: (first?.meta?.by as RequestRow["by"] | undefined) ?? null,
      events,
    };
  }

  private row(snap: Snapshot, e: Entry): PageRow {
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
      title: str(field(r, "title")),
      description: str(field(r, "description")),
      status: effectiveStatus(field(r, "status")),
      status_set: typeof field(r, "status") === "string" && field(r, "status") !== "",
      tags: tagsOf(r),
      trust_tier: trustTier(r.generated, this.verifiedAt(e.page_id, snap.seq)),
      stale: isStale(field(r, "stale_after"), this.clock().getTime()),
    };
  }

  /** GET /tree: files under a prefix; with `depth`, deeper levels collapse into directory entries. */
  /**
   * GET /outline: every file's path, kind, title and sequence, for the app's file tree. Lean on
   * purpose: titles come from the record cache, and nothing else per file is looked up (no trust
   * tier, no attachment sizes), so it stays cheap to ask for after every burst of writes.
   */
  outline(opts: { at?: number } = {}) {
    const snap = this.snapshot(opts.at);
    // Open comment threads, at head only (comments are not versioned with content).
    const atHead = snap.seq === this.headSeq();
    const open = atHead ? this.openThreadCounts() : new Map<string, number>();
    const stale = atHead ? this.staleFlags() : new Map<string, Staleness>();
    const files = snap.sorted().map((e) => ({
      path: e.path,
      kind: e.kind,
      title: e.kind === "page" ? (str(field(this.record(e.hash), "title")) ?? null) : null,
      seq: e.seq,
      ...(open.has(e.page_id) ? { comments: open.get(e.page_id) } : {}),
      ...(stale.has(e.page_id) ? { stale: stale.get(e.page_id) } : {}),
    }));
    return { seq: snap.seq, files };
  }

  /** Pages the staleness process flagged, told apart by the time now (as in `work`). */
  private staleFlags(): Map<string, Staleness> {
    const now = this.clock().getTime();
    const rows = this.sql.all<{ page_id: string; stale_ms: number }>(
      `SELECT f.page_id, c.stale_ms FROM flags f JOIN pages c ON c.page_id = f.page_id
       WHERE f.kind IN ('stale', 'stale_soon') AND c.stale_ms IS NOT NULL`,
    );
    return new Map(rows.map((r) => [r.page_id, r.stale_ms <= now ? "stale" : "stale_soon"]));
  }

  tree(opts: { prefix?: string; depth?: number; at?: number } = {}) {
    const snap = this.snapshot(opts.at);
    const prefix = normalizeDir(opts.prefix);
    const entries: (PageRow | { path: string; kind: "dir"; files: number })[] = [];
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

  /** GET /pages: a frontmatter query; any combination of filters; paginated by offset. */
  pages(
    q: {
      tag?: string;
      status?: string;
      trust?: string;
      stale?: boolean;
      prefix?: string;
      at?: number;
      limit?: number;
      offset?: number;
      /** `reads`: most read first, over the usage window (TEMPRA-220); by path otherwise. */
      sort?: "path" | "reads";
      /** Reads over the usage window (30 days) at least or at most this many (TEMPRA-220). */
      min_reads?: number;
      max_reads?: number;
    } = {},
  ) {
    const snap = this.snapshot(q.at);
    const prefix = normalizeDir(q.prefix);
    const limit = Math.min(Math.max(q.limit ?? 100, 1), 1000);
    const offset = Math.max(q.offset ?? 0, 0);
    // Reads only when asked about: one grouped query over the window.
    const byReads = q.sort === "reads" || q.min_reads !== undefined || q.max_reads !== undefined;
    const usage = byReads ? this.usageCounts() : null;
    const rows = snap
      .sorted()
      .filter((e) => e.kind === "page" && underPrefix(e.path, prefix))
      .map((e) => {
        const row = this.row(snap, e);
        return usage ? { ...row, reads: usage.get(e.page_id) ?? 0 } : row;
      })
      .filter(
        (r) =>
          (q.tag === undefined || (r.tags ?? []).includes(q.tag)) &&
          (q.status === undefined || r.status === q.status) &&
          (q.trust === undefined || r.trust_tier === q.trust) &&
          (q.stale === undefined || r.stale === q.stale) &&
          (q.min_reads === undefined || ("reads" in r && r.reads >= q.min_reads)) &&
          (q.max_reads === undefined || ("reads" in r && r.reads <= q.max_reads)),
      );
    if (q.sort === "reads") {
      // Stable: equal counts keep their path order.
      rows.sort((a, b) => ("reads" in b ? b.reads : 0) - ("reads" in a ? a.reads : 0));
    }
    const items = rows.slice(offset, offset + limit);
    return {
      seq: snap.seq,
      total: rows.length,
      items,
      next_offset: offset + limit < rows.length ? offset + limit : null,
    };
  }

  /**
   * GET /search: FTS over title, body and tags at head, ranked by BM25, with snippets. Any of the
   * words matches (TEMPRA-17): a page with more of them, rarer ones, or in its title ranks first.
   */
  search(q: string, opts: { prefix?: string; limit?: number } = {}) {
    const match = searchMatch(q);
    if (!match) throw new StoreError(400, "empty_query", "Send a search query in `q`.");
    const prefix = normalizeDir(opts.prefix);
    const limit = Math.min(Math.max(opts.limit ?? 20, 1), 200);
    const rows = this.sql.all<{ path: string; title: string; snippet: string; score: number }>(
      `SELECT paths.path AS path, fts.title AS title,
              snippet(fts, 2, char(2), char(3), '…', 16) AS snippet,
              bm25(fts, ${SEARCH_WEIGHTS}) AS score
       FROM fts JOIN paths ON paths.page_id = fts.page_id
       WHERE fts MATCH ? AND (? = '' OR paths.path = ? OR paths.path LIKE ? ESCAPE '\\')
       ORDER BY score LIMIT ?`,
      match,
      prefix,
      prefix,
      `${escapeLike(prefix)}/%`,
      limit,
    );
    // FTS5 marks each matched token alone; adjacent ones become one highlight.
    const results = rows.map((r) => ({
      ...r,
      // The text's own backslashes and asterisks are escaped, so only highlights read as **.
      snippet: r.snippet
        .replace(/[\\*]/g, "\\$&")
        .replace(ADJACENT_MARKS, "$1")
        .replaceAll(MARK_OPEN, "**")
        .replaceAll(MARK_CLOSE, "**"),
    }));
    return { seq: this.headSeq(), results };
  }

  /** GET /grep: literal or regex match over rendered pages, frontmatter included, like grep -n. */
  grep(
    pattern: string,
    opts: { regex?: boolean; prefix?: string; limit?: number; at?: number } = {},
  ) {
    if (!pattern) throw new StoreError(400, "empty_pattern", "Send a pattern.");
    let test: (line: string) => boolean;
    if (opts.regex) {
      let re: RegExp;
      try {
        re = new RegExp(pattern);
      } catch (e) {
        throw new StoreError(
          400,
          "bad_regex",
          `Invalid regular expression: ${(e as Error).message}`,
        );
      }
      test = (line) => re.test(line);
    } else test = (line) => line.includes(pattern);
    const snap = this.snapshot(opts.at);
    const prefix = normalizeDir(opts.prefix);
    const limit = Math.min(Math.max(opts.limit ?? 100, 1), 1000);
    const matches: { path: string; line: number; text: string }[] = [];
    let truncated = false;
    outer: for (const e of snap.sorted()) {
      if (e.kind !== "page" || !underPrefix(e.path, prefix)) continue;
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

  /**
   * GET /links: outbound links with current targets, inbound links, and broken ones. With `at`,
   * outbound and broken are as of that sequence; inbound links are only known at head.
   */
  /**
   * Everything a file's page shows, in one call, so it is read at one sequence number
   * (TEMPRA-191): the file as the app draws it (with its images), the head, and for a page its
   * sources, links and versions, found by the page's own path however it was asked for. The
   * app made five requests for these; the separate routes stay for agents and the API.
   */
  page(
    input: string,
    opts: {
      at?: number;
      /**
       * Shown to the person an agent works for (MCP `show`, the page panel): their read, not the
       * agent's (TEMPRA-220).
       */
      shown?: boolean;
    } = {},
  ) {
    const r = this.reader;
    const asPerson: Reading | null =
      opts.shown && r?.person ? { surface: r.surface, kind: "person", reader: r.person } : r;
    const file = this.reading(asPerson, () => this.read(input, { at: opts.at, images: true }));
    const head = this.headSeq();
    if (file.kind !== "page") return { file, head };
    const id = this.snapshot().lookup(file.path)?.page_id;
    return {
      file,
      head,
      sources: this.sources(file.path, { at: opts.at }),
      links: this.links(file.path, { at: opts.at }),
      history: this.history(file.path),
      // How much the page is read and how recently (TEMPRA-220); null once it is gone at head.
      reads: id ? this.readHistoryOf(id) : null,
    };
  }

  links(input: string, opts: { at?: number } = {}) {
    const snap = this.snapshot(opts.at);
    const e = snap.lookup(normalizePath(input) ?? "");
    // A page's links both ways; an attachment's are only inbound (the pages that use it).
    if (e?.kind !== "page" && e?.kind !== "attachment") throw notFound(input);
    // `raw` is each link as `read` renders it: its target's current path, in its written form.
    const outbound: { raw: string; path: string; anchor: string | null; kind: LinkKind }[] = [];
    const broken: { raw: string; path: string; kind: LinkKind }[] = [];
    const graph = e.kind === "page" ? linkGraph(this.record(e.hash)) : [];
    for (const [l, kind] of graph) {
      const target = this.targetAt(snap, l);
      const raw = this.href(snap, e, l);
      if (target) outbound.push({ raw, path: target.path, anchor: l.anchor, kind });
      else broken.push({ raw, path: l.path, kind });
    }
    const inbound =
      snap.seq !== this.headSeq()
        ? []
        : this.sql
            .all<{
              from_id: string;
              to_path: string;
              raw: string;
              anchor: string | null;
              form: StoredLink["form"] | StoredSource["form"];
              kind: LinkKind;
            }>(
              "SELECT from_id, to_path, raw, anchor, form, kind FROM links WHERE to_id = ? AND from_id <> ?",
              e.page_id,
              e.page_id,
            )
            .flatMap((l) => {
              const from = snap.byId.get(l.from_id);
              if (!from) return [];
              const link = {
                raw: l.raw,
                path: l.to_path,
                anchor: l.anchor,
                form: l.form,
                target: e.page_id,
              } as StoredSource;
              const raw = this.href(snap, from, link);
              return [{ path: from.path, raw, anchor: l.anchor, kind: l.kind }];
            })
            .sort((a, b) => (a.path < b.path ? -1 : 1));
    if (e.kind === "attachment") {
      // What the attachment's page shows beside where it is used (TEMPRA-152).
      const info = this.blobInfo(e.hash);
      return {
        path: e.path,
        outbound,
        inbound,
        broken,
        size: info.size,
        media: info.media,
        width: info.width ?? null,
        height: info.height ?? null,
      };
    }
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
  /**
   * GET /requests: requests newest first. Filters: path prefix, exact actor, and UTC dates
   * `from` and `to` (YYYY-MM-DD, inclusive); a request matches when one of its events does.
   */
  requests(
    opts: {
      before?: number;
      since?: number;
      prefix?: string;
      actor?: string;
      from?: string;
      to?: string;
      limit?: number;
    } = {},
  ) {
    const prefix = normalizeDir(opts.prefix);
    const limit = Math.min(Math.max(opts.limit ?? 20, 1), 200);
    for (const [name, v] of [
      ["from", opts.from],
      ["to", opts.to],
    ] as const) {
      if (v && !/^\d{4}-\d{2}-\d{2}$/.test(v)) {
        throw new StoreError(400, "bad_param", `\`${name}\` must be a date like 2026-09-30.`);
      }
    }
    const ids = this.sql.all<{ request_id: string; last: number }>(
      `SELECT request_id, MIN(seq) AS first, MAX(seq) AS last FROM events
       WHERE (? = '' OR path = ? OR path LIKE ? ESCAPE '\\')
         AND (? = '' OR actor = ?)
         AND (? = '' OR substr(ts, 1, 10) >= ?) AND (? = '' OR substr(ts, 1, 10) <= ?)
       GROUP BY request_id HAVING last < ? AND first > ? ORDER BY last DESC LIMIT ?`,
      prefix,
      prefix,
      `${escapeLike(prefix)}/%`,
      opts.actor ?? "",
      opts.actor ?? "",
      opts.from ?? "",
      opts.from ?? "",
      opts.to ?? "",
      opts.to ?? "",
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
    if (rows.length === 0) throw new StoreError(404, "not_found", `No request ${id}.`);
    return this.toRequest(
      id,
      rows.map((e) => ({ ...e, meta: e.meta ? (JSON.parse(e.meta) as JsonObject) : null })),
    );
  }

  /** GET /history: every event for the path's page, across moves. */
  history(input: string) {
    const p = normalizePath(input) ?? "";
    let id = this.lookupRow(p)?.page_id;
    if (!id) {
      id = this.sql.all<{ page_id: string }>(
        "SELECT page_id FROM events WHERE path IN (?, ?) ORDER BY seq DESC LIMIT 1",
        p,
        `${p}.md`,
      )[0]?.page_id;
    }
    if (!id) throw notFound(input);
    const rows = this.sql.all<EventRow & { meta: string | null }>(
      "SELECT * FROM events WHERE page_id = ? ORDER BY seq",
      id,
    );
    // An attachment's versions carry their bytes' size, type and dimensions, for its page's
    // File history (TEMPRA-170).
    const files = new Map<string, JsonObject | null>();
    const fileOf = (hash: string | null): JsonObject | null => {
      if (hash === null) return null;
      if (!files.has(hash)) {
        const row = this.sql.all<{
          size: number;
          media: string | null;
          width: number | null;
          height: number | null;
        }>(
          "SELECT size, media, width, height FROM blobs WHERE hash = ? AND location = 'r2'",
          hash,
        )[0];
        files.set(
          hash,
          row
            ? {
                size: row.size,
                media: row.media,
                width: row.width && row.width > 0 ? row.width : null,
                height: row.height && row.height > 0 ? row.height : null,
              }
            : null,
        );
      }
      return files.get(hash) ?? null;
    };
    return {
      path: this.pathOf(id) ?? p,
      events: rows.map((e) => {
        const file =
          e.op === "put" || e.op === "import" || e.op === "revert" ? fileOf(e.hash) : null;
        return {
          ...e,
          meta: e.meta ? (JSON.parse(e.meta) as JsonObject) : null,
          ...(file ? { file } : {}),
        };
      }),
    };
  }

  private pathOf(id: string): string | undefined {
    return this.sql.all<{ path: string }>("SELECT path FROM paths WHERE page_id = ?", id)[0]?.path;
  }

  /** The library as a conformant bundle at `at`, with index.md and log.md synthesized. */
  /**
   * The library's files at `at`, for an export (tempra-dev: decisions/pages-not-okf, v2/exports).
   * `plain` (the default, and every nightly export) is the pages and attachments as they are.
   * `okf` is a bundle that conforms to Google's OKF: each directory's `index.md` (with
   * `okf_version` on the root's), the whole `log.md`, and `type: Page` on a page with none,
   * since OKF requires a type.
   */
  exportBundle(at?: number, format: ExportFormat = "plain"): { seq: number; files: ExportFile[] } {
    const snap = this.snapshot(at);
    const okf = format === "okf";
    const files: ExportFile[] = [];
    const dirs = new Set<string>([""]);
    for (const e of snap.sorted()) {
      for (let d = dirname(e.path); d !== ""; d = dirname(d)) dirs.add(d);
      if (e.kind === "page") {
        files.push({ path: e.path, text: this.renderEntry(snap, e, false, false, okf) });
      } else {
        const info = this.blobInfo(e.hash);
        const { location: _, dims: __, ...blob } = info;
        files.push({ path: e.path, blob });
      }
    }
    if (okf) {
      for (const d of [...dirs].sort()) {
        files.push({
          path: d ? `${d}/index.md` : "index.md",
          text: this.index(d, snap, { okf: true }),
        });
      }
      files.push({ path: "log.md", text: this.log({ at: snap.seq, limit: null }) });
    }
    return { seq: snap.seq, files };
  }

  // ---------------------------------------------------------------- tier 2: beyond files

  /** GET /sources: a page's sources with footnote counts and internal targets' signals. */
  sources(input: string, opts: { at?: number } = {}) {
    const snap = this.snapshot(opts.at);
    const e = snap.lookup(normalizePath(input) ?? "");
    if (e?.kind !== "page") throw notFound(input);
    const r = this.record(e.hash);
    const counts = scanDoc(r.doc, e.path).footnoteCounts;
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
      if (target?.kind === "page") {
        const tr = this.record(target.hash);
        internal = {
          path: target.path,
          trust_tier: trustTier(tr.generated, this.verifiedAt(target.page_id, snap.seq)),
          stale: isStale(field(tr, "stale_after"), this.clock().getTime()),
          status: effectiveStatus(field(tr, "status")),
          inbound_links: this.inboundCount(target.page_id),
          usage_count: this.usageCount(target.page_id),
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
   * GET /diff: unified diff of a page's rendering between two sequences. `to` defaults to head;
   * `from` defaults to just before the page's latest content change at or before `to`.
   */
  diff(input: string, opts: { from?: number; to?: number } = {}) {
    const p = normalizePath(input) ?? "";
    const to = opts.to ?? this.headSeq();
    const snapTo = this.snapshot(to);
    const id = snapTo.lookup(p)?.page_id ?? this.lastPageAt(p);
    if (!id) throw notFound(input);
    let from = opts.from;
    if (from === undefined) {
      const last = this.sql.all<{ seq: number }>(
        `SELECT seq FROM events WHERE page_id = ? AND seq <= ? AND ${CONTENT_EVENT} ORDER BY seq DESC LIMIT 1`,
        id,
        to,
      )[0];
      from = last ? last.seq - 1 : 0;
    }
    const snapFrom = this.snapshot(from);
    const a = snapFrom.byId.get(id);
    const b = snapTo.byId.get(id);
    // Without the `generated` stamp, which changes with every write and says nothing new.
    const text = (snap: Snapshot, e: Entry | undefined) => {
      if (!e) return "";
      if (e.kind === "page") return this.renderEntry(snap, e, false, true);
      return `(attachment ${e.hash})\n`;
    };
    // Each side is labelled by its own version's seq, not the library's.
    const label = (e: Entry | undefined, seq: number) =>
      e ? `${e.path}@${e.seq}` : `/dev/null@${seq}`;
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

  private lastPageAt(path: string): string | undefined {
    return this.sql.all<{ page_id: string }>(
      "SELECT page_id FROM events WHERE path IN (?, ?) ORDER BY seq DESC LIMIT 1",
      path,
      `${path}.md`,
    )[0]?.page_id;
  }

  /**
   * GET /work: the work queue (spec: Write path and maintainers). Staleness, broken links and
   * lint come from flags; stale soon only when asked for (`kind`) or for one page (`path`).
   * Ranked by inbound links, then age.
   */
  work(opts: { kind?: string; limit?: number; path?: string } = {}) {
    const snap = this.snapshot();
    const now = this.clock().getTime();
    const limit = Math.min(Math.max(opts.limit ?? 50, 1), 500);
    const items: WorkItem[] = [];
    const want = (k: string) => opts.kind === undefined || opts.kind === k;
    // One file's items (the app's page view), whatever the queue's length.
    const only = opts.path === undefined ? undefined : (normalizePath(opts.path) ?? "");
    const mine = (path: string) => only === undefined || path === only;
    // Stale soon is a look-ahead: listed when asked for, or on one page's page, not in the
    // queue of what needs doing now.
    const soon = opts.kind === "stale_soon" || (opts.kind === undefined && only !== undefined);
    if (want("stale") || soon) {
      // From the staleness process's flags (TEMPRA-63), told apart by the time now, so a page
      // flagged stale soon is stale the moment its date passes, between two runs.
      const rows = this.sql.all<{ page_id: string; stale_after: string; stale_ms: number }>(
        `SELECT f.page_id, c.stale_after, c.stale_ms FROM flags f
         JOIN pages c ON c.page_id = f.page_id
         WHERE f.kind IN ('stale', 'stale_soon') AND c.stale_ms IS NOT NULL`,
      );
      for (const row of rows) {
        const e = snap.byId.get(row.page_id);
        if (e?.kind !== "page" || !mine(e.path)) continue;
        const staleAfter = row.stale_after;
        if (row.stale_ms <= now) {
          if (!want("stale")) continue;
          items.push({
            kind: "stale",
            path: e.path,
            since: staleAfter,
            detail: `stale_after ${staleAfter} has passed`,
            suggested_action:
              "Re-check the page against its sources and resource. Update it (which restamps generated) and move stale_after forward, or set status: deprecated if it no longer holds.",
            inbound_links: this.inboundCount(e.page_id),
          });
        } else if (soon) {
          items.push({
            kind: "stale_soon",
            path: e.path,
            since: staleAfter,
            detail: `stale_after ${staleAfter} is within ${STALE_SOON_DAYS} days`,
            suggested_action:
              "Re-check the page against its sources before then. If it still holds, move stale_after forward; only a new stale_after resets the clock.",
            inbound_links: this.inboundCount(e.page_id),
          });
        }
      }
    }
    // Missing-heading lint is not stored: work it out for every page with an anchored link.
    const anchorLint = new Map<string, LintWarning[]>();
    if (want("lint")) {
      for (const [id, lint] of this.anchorLints(snap)) {
        const e = snap.byId.get(id);
        if (e && mine(e.path)) anchorLint.set(id, lint);
      }
    }
    const flags = this.sql.all<{
      page_id: string;
      kind: string;
      since_seq: number;
      detail: string;
    }>(
      `SELECT f.page_id, f.kind, f.since_seq, f.detail FROM flags f
       JOIN paths p ON p.page_id = f.page_id
       WHERE f.kind NOT IN ('stale', 'stale_soon', 'structure')`,
    );
    // A page with only missing-heading lint gets a lint item too, dated by its latest version.
    for (const id of anchorLint.keys()) {
      if (flags.some((f) => f.page_id === id && f.kind === "lint")) continue;
      const e = snap.byId.get(id);
      if (e) flags.push({ page_id: id, kind: "lint", since_seq: e.seq, detail: "[]" });
    }
    for (const f of flags) {
      if (!want(f.kind)) continue;
      const e = snap.byId.get(f.page_id);
      if (!e || !mine(e.path)) continue;
      const since =
        this.sql.all<{ ts: string }>("SELECT ts FROM events WHERE seq = ?", f.since_seq)[0]?.ts ??
        "";
      let detail = f.detail;
      let action = "Fix the frontmatter or body with edit; the lint messages say what is wrong.";
      if (f.kind === "broken_link") {
        const targets = JSON.parse(f.detail) as string[];
        detail = `links to missing ${targets.map((t) => `/${t}`).join(", ")}`;
        action = "Write the missing page, point the link at an existing one, or remove the link.";
      } else if (f.kind === "external_image") {
        const urls = [
          ...new Set((JSON.parse(f.detail) as LintWarning[]).map((l) => l.target ?? "")),
        ].filter((u) => u !== "");
        const n = urls.length;
        detail = `${n} image${n === 1 ? "" : "s"} hotlinked from another site: ${urls.join(", ")}`;
        action =
          "Bring each into the library: `attach` it with `source_url` set to its URL (the server fetches it and records where from; put it beside this page), `edit` the image to point at the attached path, and cite the original in `sources`.";
      } else if (f.kind === "lint") {
        detail = [...(JSON.parse(f.detail) as LintWarning[]), ...(anchorLint.get(f.page_id) ?? [])]
          .map((l) => l.message)
          .join(" ");
      }
      items.push({
        kind: f.kind,
        path: e.path,
        since,
        detail,
        suggested_action: action,
        inbound_links: this.inboundCount(e.page_id),
      });
    }
    if (want("structure")) {
      // The structure process's flags (TEMPRA-64): a page's own, or a directory's, reported on
      // its index.md. Directory flags are kept current by writes, so a directory gone has none.
      for (const f of this.sql.all<{ page_id: string; since_seq: number; detail: string }>(
        "SELECT page_id, since_seq, detail FROM flags WHERE kind = 'structure'",
      )) {
        const dir = isDirKey(f.page_id) ? f.page_id.slice(4) : null;
        const e = dir === null ? snap.byId.get(f.page_id) : undefined;
        if (dir === null && e?.kind !== "page") continue;
        const path = e ? e.path : dirIndex(dir ?? "");
        if (!mine(path)) continue;
        const issues = JSON.parse(f.detail) as StructureIssue[];
        items.push({
          kind: "structure",
          path,
          since:
            this.sql.all<{ ts: string }>("SELECT ts FROM events WHERE seq = ?", f.since_seq)[0]
              ?.ts ?? "",
          detail: issues.map((i) => i.message).join(" "),
          suggested_action: structureAction(issues),
          inbound_links: e ? this.inboundCount(e.page_id) : 0,
        });
      }
    }
    if (want("comment") || want("request")) {
      // One page's page asks for its own threads only (the partial index, by page).
      const onlyId = only === undefined ? null : (snap.lookup(only)?.page_id ?? "(no such page)");
      // Open threads on pages that exist and the library's own (TEMPRA-222), from the
      // partial index on open threads; a request is its own kind of item.
      const threads = this.sql.all<{
        id: string;
        page_id: string;
        kind: string;
        actor: string;
        anchor: string | null;
        replies: number;
        last_actor: string;
        ts: string;
        body: string;
      }>(
        `SELECT t.id, t.page_id, t.kind, t.actor, t.anchor, t.replies, t.last_actor, e.ts,
                (SELECT body FROM comments c WHERE c.thread_id = t.id ORDER BY c.seq LIMIT 1) AS body
         FROM threads t LEFT JOIN paths p ON p.page_id = t.page_id
         JOIN events e ON e.seq = t.last_seq
         WHERE t.status = 'open' AND (p.page_id IS NOT NULL OR t.page_id = '')
           AND (? IS NULL OR t.page_id = ?)`,
        onlyId,
        onlyId,
      );
      for (const t of threads) {
        const request = t.kind === "request";
        if (!want(request ? "request" : "comment")) continue;
        const onLibrary = t.page_id === LIBRARY_THREAD;
        const e = onLibrary ? null : snap.byId.get(t.page_id);
        if (!onLibrary && !e) continue;
        const path = e?.path ?? "";
        if (!mine(path)) continue;
        const quote = t.anchor ? (JSON.parse(t.anchor) as StoredAnchor).quote : null;
        const said = clip(t.body ?? "", 160);
        const on = quote ? ` on “${clip(quote, 80)}”` : onLibrary ? " on the library" : "";
        const replies =
          t.replies > 0
            ? ` (${t.replies} ${t.replies === 1 ? "reply" : "replies"}, last by ${t.last_actor})`
            : "";
        items.push({
          kind: request ? "request" : "comment",
          path,
          since: t.ts,
          detail: `${t.actor} ${request ? "asked" : "commented"}${on}: ${said}${replies}`,
          suggested_action: request
            ? "A request: someone asked for more than a quick answer or a small edit. Read the thread with `comments`, do the work it asks for with the write tools, then reply with `comment` saying what you did, and resolve it. Ask with a reply if it is unclear."
            : "Read the thread with `comments`, make the change it asks for, then reply with `comment` and resolve it. If you only have a question, reply without resolving; if the last reply is yours, wait for an answer.",
          inbound_links: e ? this.inboundCount(e.page_id) : 0,
          thread: t.id,
        });
      }
    }
    items.sort((a, b) => b.inbound_links - a.inbound_links || (a.since < b.since ? -1 : 1));
    const counts: Record<string, number> = {};
    for (const i of items) counts[i.kind] = (counts[i.kind] ?? 0) + 1;
    return { seq: snap.seq, total: items.length, counts, items: items.slice(0, limit) };
  }

  /**
   * Every page at head with a link to a heading its target does not have, and that lint;
   * worked out from the snapshot like `anchorLint`, kept for the seq it was worked out at.
   */
  private anchorLints(snap = this.snapshot()): Map<string, LintWarning[]> {
    if (this.anchorCache?.seq === snap.seq) return this.anchorCache.lint;
    if (this.catchUpAnchors(snap) && this.anchorCache) return this.anchorCache.lint;
    const lint = new Map<string, LintWarning[]>();
    const headings = new Map<string, Set<string>>();
    for (const { from_id } of this.sql.all<{ from_id: string }>(
      "SELECT DISTINCT from_id FROM links WHERE kind = 'body' AND anchor IS NOT NULL AND anchor <> '#'",
    )) {
      const e = snap.byId.get(from_id);
      if (e?.kind !== "page") continue;
      const found = this.anchorLint(snap, e, headings);
      if (found.length > 0) lint.set(from_id, found);
    }
    this.anchorCache = { seq: snap.seq, lint };
    this.anchorTouched = [];
    return lint;
  }

  /**
   * What `work()` counts, by kind, its total and the stale-soon total, from aggregate queries over
   * the flags and threads rather than item by item (TEMPRA-86): for `summary` and `health`.
   */
  private workCounts(): { counts: Record<string, number>; total: number; stale_soon: number } {
    const now = this.clock().getTime();
    const counts: Record<string, number> = {};
    const add = (kind: string, n: number) => {
      if (n > 0) counts[kind] = (counts[kind] ?? 0) + n;
    };
    const stale = this.sql.all<{ stale: number | null; soon: number | null }>(
      `SELECT SUM(c.stale_ms <= ?) AS stale, SUM(c.stale_ms > ?) AS soon FROM flags f
       JOIN pages c ON c.page_id = f.page_id
       JOIN paths p ON p.page_id = f.page_id AND p.kind = 'page'
       WHERE f.kind IN ('stale', 'stale_soon') AND c.stale_ms IS NOT NULL`,
      now,
      now,
    )[0];
    add("stale", stale?.stale ?? 0);
    for (const r of this.sql.all<{ kind: string; n: number }>(
      `SELECT f.kind, COUNT(*) AS n FROM flags f JOIN paths p ON p.page_id = f.page_id
       WHERE f.kind NOT IN ('stale', 'stale_soon', 'structure') GROUP BY f.kind`,
    )) {
      add(r.kind, r.n);
    }
    // A page with only missing-heading lint has a lint item too.
    const linted = new Set(
      this.sql
        .all<{ page_id: string }>("SELECT page_id FROM flags WHERE kind = 'lint'")
        .map((r) => r.page_id),
    );
    add("lint", [...this.anchorLints().keys()].filter((id) => !linted.has(id)).length);
    add(
      "structure",
      this.sql.all<{ n: number }>(
        `SELECT COUNT(*) AS n FROM flags f LEFT JOIN paths p ON p.page_id = f.page_id
         WHERE f.kind = 'structure' AND (f.page_id LIKE 'dir:%' OR p.kind = 'page')`,
      )[0]?.n ?? 0,
    );
    for (const r of this.sql.all<{ kind: string; n: number }>(
      `SELECT t.kind, COUNT(*) AS n FROM threads t LEFT JOIN paths p ON p.page_id = t.page_id
       JOIN events e ON e.seq = t.last_seq
       WHERE t.status = 'open' AND (p.page_id IS NOT NULL OR t.page_id = '') GROUP BY t.kind`,
    )) {
      add(r.kind === "request" ? "request" : "comment", r.n);
    }
    const total = Object.values(counts).reduce((a, b) => a + b, 0);
    return { counts, total, stale_soon: stale?.soon ?? 0 };
  }

  /**
   * POST /verify: adds `{ by, at }` to `verified` as one verify event; the content version is
   * unchanged (spec: the page format). Only `human:` and `process:` actors may verify.
   */
  verify(ctx: RequestContext, input: string): WriteResult {
    if (!ctx.actor.startsWith("human:") && !ctx.actor.startsWith("process:")) {
      throw new StoreError(
        403,
        "cannot_verify",
        "Only human: and process: actors may verify; agents do not claim verification.",
      );
    }
    const before = this.headSeq();
    const res: WriteResult = this.guard(() =>
      this.sql.transaction(() => {
        const w = this.begin(ctx);
        const p = normalizePath(input);
        const row = p ? this.lookupRow(p) : undefined;
        if (row?.kind !== "page") throw notFound(input);
        const seq = this.recordVerification(w, row.page_id, row.path, row.hash, {
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
    return { ...res, notify: this.writeNotice(before) };
  }

  // ---------------------------------------------------------------- comments

  /**
   * One comment action as one request (tempra-dev: app/comments): open a thread on a page
   * (optionally on a quote), reply, resolve or reopen. Recorded as a `comment` event whose meta
   * carries the action in full, so the ledger stays the source of truth; the `threads` and
   * `comments` tables follow in the same transaction. The page's version does not change.
   */
  comment(ctx: RequestContext, action: CommentAction): CommentResult {
    return this.guard(() =>
      this.sql.transaction(() => {
        const w = this.begin(ctx);
        const id = action.kind === "open" ? this.openThread(w, action) : this.actOn(w, action);
        const view = this.threadViews(this.threadRows("t.id = ?", [id]), true)[0];
        if (!view) throw new Error("thread vanished");
        return {
          request_id: ctx.request_id,
          seq: this.headSeq(),
          thread: view,
          people: this.peopleOf(id),
        };
      }),
    );
  }

  private openThread(w: WriteState, a: Extract<CommentAction, { kind: "open" }>): string {
    const kind = threadKind(a.thread_kind) ?? "comment";
    const onLibrary = (a.path ?? "").trim() === "" || a.path?.trim() === "/";
    const p = onLibrary ? null : normalizePath(a.path ?? "");
    const row = p ? this.lookupRow(p) : undefined;
    if (!onLibrary && row?.kind !== "page") throw notFound(a.path ?? "");
    const body = commentBody(a.body, true) as string;
    let anchor: StoredAnchor | null = null;
    if (a.anchor && onLibrary) {
      throw new StoreError(400, "bad_anchor", "A thread on the library quotes nothing.");
    }
    if (a.anchor && row) {
      const raw = a.anchor.from;
      // The app sends the document's text and where it saw it; an agent, markdown as read.
      const quote = checkQuote(
        typeof raw === "number" ? a.anchor.quote : quoteText(String(a.anchor.quote ?? "")),
      );
      const doc = this.textOf(row);
      const text = doc.text;
      const starts = occurrences(text, quote);
      const hint =
        typeof raw === "number" && Number.isInteger(raw) && raw >= 0 && raw <= text.length
          ? raw
          : undefined;
      let at: number | undefined;
      if (hint !== undefined && text.startsWith(quote, hint)) at = hint;
      else if (starts.length === 1 || (starts.length > 1 && hint !== undefined)) {
        at = starts.reduce((best, s) =>
          Math.abs(s - (hint ?? 0)) < Math.abs(best - (hint ?? 0)) ? s : best,
        );
      } else if (starts.length > 1) {
        throw new StoreError(
          409,
          "quote_ambiguous",
          `The quote occurs ${starts.length} times in ${row.path}; quote more of the sentence so it occurs once.`,
        );
      }
      if (at === undefined) {
        throw new StoreError(
          409,
          "quote_not_found",
          `The quote is not in the current body of ${row.path}; read it again and quote it exactly, or comment on the whole page.`,
        );
      }
      anchor = { ...selectorAt(doc, at, at + quote.length), seq: this.headSeq() };
    }
    const id = crypto.randomUUID();
    const commentId = crypto.randomUUID();
    // A library thread's events are on no file: path and page_id '' (TEMPRA-222).
    const seq = this.appendEvent(w.ctx, w.now, {
      op: "comment",
      path: row?.path ?? "",
      prev_hash: row?.hash ?? null,
      hash: row?.hash ?? null,
      page_id: row?.page_id ?? LIBRARY_THREAD,
      meta: {
        comment: {
          kind: "open",
          thread: id,
          id: commentId,
          body,
          anchor: anchor as unknown as JsonObject | null,
          ...(kind !== "comment" ? { thread_kind: kind } : {}),
          ...mentionsMeta(a.mentions),
        },
      },
    });
    this.sql.run(
      `INSERT INTO threads (id, page_id, kind, actor, anchor, status, created_seq, last_seq, last_actor)
       VALUES (?, ?, ?, ?, ?, 'open', ?, ?, ?)`,
      id,
      row?.page_id ?? LIBRARY_THREAD,
      kind,
      w.ctx.actor,
      anchor ? JSON.stringify(anchor) : null,
      seq,
      seq,
      w.ctx.actor,
    );
    this.addComment(commentId, id, w, body, seq);
    return id;
  }

  private actOn(w: WriteState, a: Exclude<CommentAction, { kind: "open" }>): string {
    const t = this.sql.all<{ id: string; page_id: string; status: ThreadStatus }>(
      "SELECT id, page_id, status FROM threads WHERE id = ?",
      a.thread,
    )[0];
    // A library thread is on no file (TEMPRA-222).
    const row: { path: string; hash: string | null; page_id: string } | undefined = !t
      ? undefined
      : t.page_id === LIBRARY_THREAD
        ? { path: "", hash: null, page_id: LIBRARY_THREAD }
        : this.sql.all<PathRow>(
            "SELECT path, page_id, hash, kind, last_seq AS seq, created_seq FROM paths WHERE page_id = ?",
            t.page_id,
          )[0];
    // A thread on a deleted page is kept (a revert brings both back) but takes no actions.
    if (!t || !row) throw new StoreError(404, "not_found", `No comment thread ${a.thread}.`);
    const body = commentBody(a.body, a.kind === "reply");
    const kind = a.kind === "reply" ? threadKind(a.thread_kind) : undefined;
    if (a.kind === "resolve" && t.status === "resolved") {
      throw new StoreError(409, "already_resolved", "The thread is already resolved.");
    }
    if (a.kind === "reopen" && t.status === "open") {
      throw new StoreError(409, "already_open", "The thread is already open.");
    }
    const commentId = body ? crypto.randomUUID() : null;
    const seq = this.appendEvent(w.ctx, w.now, {
      op: "comment",
      path: row.path,
      prev_hash: row.hash,
      hash: row.hash,
      page_id: row.page_id,
      meta: {
        comment: {
          kind: a.kind,
          thread: t.id,
          ...(commentId ? { id: commentId, body, ...mentionsMeta(a.mentions) } : {}),
          ...(kind ? { thread_kind: kind } : {}),
        },
      },
    });
    if (commentId && body) this.addComment(commentId, t.id, w, body, seq);
    if (kind) this.sql.run("UPDATE threads SET kind = ? WHERE id = ?", kind, t.id);
    if (a.kind === "resolve") {
      this.sql.run(
        "UPDATE threads SET status = 'resolved', resolved_by = ?, resolved_seq = ? WHERE id = ?",
        w.ctx.actor,
        seq,
        t.id,
      );
    } else if (a.kind === "reopen") {
      this.sql.run(
        "UPDATE threads SET status = 'open', resolved_by = NULL, resolved_seq = NULL WHERE id = ?",
        t.id,
      );
    }
    this.sql.run(
      `UPDATE threads SET last_seq = ?, last_actor = ?, replies = replies + ? WHERE id = ?`,
      seq,
      w.ctx.actor,
      commentId ? 1 : 0,
      t.id,
    );
    return t.id;
  }

  private addComment(id: string, thread: string, w: WriteState, body: string, seq: number) {
    this.sql.run(
      "INSERT INTO comments (id, thread_id, actor, body, ts, seq) VALUES (?, ?, ?, ?, ?, ?)",
      id,
      thread,
      w.ctx.actor,
      body,
      w.now,
      seq,
    );
  }

  /**
   * The people a thread's action may concern, by users id from each event's `by`: who opened or
   * wrote in the thread, and who wrote or verified its page (TEMPRA-72).
   */
  private peopleOf(thread: string): CommentResult["people"] {
    const persons = (where: string, ...params: SqlValue[]) =>
      this.sql
        .all<{ person: string | null }>(
          `SELECT DISTINCT json_extract(meta, '$.by.person') AS person FROM events
           WHERE ${where} AND meta IS NOT NULL LIMIT 100`,
          ...params,
        )
        .flatMap((r) => (r.person ? [r.person] : []));
    const t = this.sql.all<{ page_id: string }>(
      "SELECT page_id FROM threads WHERE id = ?",
      thread,
    )[0];
    return {
      participants: persons(
        "op = 'comment' AND json_extract(meta, '$.comment.thread') = ? AND json_extract(meta, '$.comment.body') IS NOT NULL",
        thread,
      ),
      writers:
        t && t.page_id !== LIBRARY_THREAD
          ? persons("op NOT IN ('comment', 'move') AND page_id = ?", t.page_id)
          : [],
    };
  }

  /** A page's text at head, which anchors quote. */
  private textOf(e: { hash: string }) {
    return docText(this.record(e.hash).doc);
  }

  /** Threads on pages that exist, and the library's own (TEMPRA-222), with their paths. */
  private threadRows(where: string, params: SqlValue[], tail = "") {
    return this.sql.all<ThreadRow>(
      `SELECT t.*, COALESCE(p.path, '') AS path, p.hash FROM threads t
       LEFT JOIN paths p ON p.page_id = t.page_id
       WHERE (p.page_id IS NOT NULL OR t.page_id = '') AND ${where} ${tail}`,
      ...params,
    );
  }

  /** Threads as returned: their comments, and anchors located in each page's current body. */
  private threadViews(rows: ThreadRow[], withComments: boolean): ThreadView[] {
    const byThread = new Map<string, CommentView[]>();
    const actions = new Map<string, ThreadAction[]>();
    const mentioned = new Map<string, string[]>();
    // Who did each action, by seq: a comment and the action that added it share one.
    const bySeq = new Map<number, ActionBy>();
    if (rows.length > 0 && withComments) {
      // Every action from the ledger, where resolve and reopen are recorded too.
      const ids = [...new Set(rows.map((r) => r.page_id))];
      const events = this.sql.all<{ seq: number; actor: string; ts: string; meta: string | null }>(
        `SELECT seq, actor, ts, meta FROM events
         WHERE op = 'comment' AND page_id IN (${ids.map(() => "?").join(", ")}) ORDER BY seq`,
        ...ids,
      );
      for (const e of events) {
        const meta = e.meta ? (JSON.parse(e.meta) as JsonObject) : {};
        const c = meta.comment as
          | { kind?: string; thread?: string; id?: string; mentions?: Mention[] }
          | undefined;
        if (!c?.thread || !c.kind) continue;
        const by = meta.by as { person?: unknown; agent?: unknown } | undefined;
        if (by && typeof by.person === "string") {
          bySeq.set(
            e.seq,
            typeof by.agent === "string"
              ? { person: by.person, agent: by.agent }
              : { person: by.person },
          );
        }
        if (c.id && Array.isArray(c.mentions) && c.mentions.length > 0) {
          mentioned.set(
            c.id,
            c.mentions.map((m) => ("handle" in m ? `@${m.handle}` : `@${m.name}`)),
          );
        }
        const list = actions.get(c.thread) ?? [];
        list.push({
          kind: c.kind as ThreadAction["kind"],
          actor: e.actor,
          ...(bySeq.has(e.seq) ? { by: bySeq.get(e.seq) } : {}),
          ts: e.ts,
          seq: e.seq,
          comment: c.id ?? null,
        });
        actions.set(c.thread, list);
      }
      const comments = this.sql.all<CommentView & { thread_id: string }>(
        `SELECT id, thread_id, actor, body, ts, seq FROM comments
         WHERE thread_id IN (${rows.map(() => "?").join(", ")}) ORDER BY seq`,
        ...rows.map((r) => r.id),
      );
      for (const c of comments) {
        const list = byThread.get(c.thread_id) ?? [];
        const mentions = mentioned.get(c.id);
        list.push({
          id: c.id,
          actor: c.actor,
          ...(bySeq.has(c.seq) ? { by: bySeq.get(c.seq) } : {}),
          body: c.body,
          ts: c.ts,
          seq: c.seq,
          ...(mentions ? { mentions } : {}),
        });
        byThread.set(c.thread_id, list);
      }
    }
    // One text per page, however many of its threads are on the page.
    const texts = new Map<string, ReturnType<typeof docText>>();
    return rows.map((r) => {
      const anchor = r.anchor ? (JSON.parse(r.anchor) as StoredAnchor) : null;
      let located: { from: number; to: number } | null = null;
      if (anchor && r.hash) {
        let text = texts.get(r.page_id);
        if (text === undefined) {
          text = this.textOf({ hash: r.hash });
          texts.set(r.page_id, text);
        }
        located = locate(text, anchor);
      }
      return {
        id: r.id,
        path: r.path,
        kind: r.kind === "request" ? "request" : "comment",
        status: r.status,
        actor: r.actor,
        created_seq: r.created_seq,
        last_seq: r.last_seq,
        last_actor: r.last_actor,
        resolved_by: r.resolved_by,
        resolved_seq: r.resolved_seq,
        replies: r.replies,
        anchor,
        located,
        outdated: anchor !== null && located === null,
        comments: byThread.get(r.id) ?? [],
        actions: actions.get(r.id) ?? [],
      };
    });
  }

  /**
   * GET /comments: threads on pages that exist, most recent activity first, each with its
   * comments. `path` narrows to one page; `status` is open (default), resolved or all;
   * `before` is a last_seq cursor for the next page.
   */
  comments(opts: { path?: string; status?: string; limit?: number; before?: number } = {}) {
    const status = opts.status ?? "open";
    if (!["open", "resolved", "all"].includes(status)) {
      throw new StoreError(400, "bad_param", "`status` is open, resolved or all.");
    }
    const limit = Math.min(Math.max(opts.limit ?? 50, 1), 200);
    const where: string[] = ["t.last_seq < ?"];
    const params: SqlValue[] = [opts.before ?? Number.MAX_SAFE_INTEGER];
    let path: string | null = null;
    if (opts.path === "" || opts.path === "/") {
      // The library's own threads, on no page (TEMPRA-222).
      path = "";
      where.push("t.page_id = ''");
    } else if (opts.path !== undefined) {
      const p = normalizePath(opts.path);
      const row = p ? this.lookupRow(p) : undefined;
      if (!row) throw notFound(opts.path);
      path = row.path;
      where.push("t.page_id = ?");
      params.push(row.page_id);
    }
    if (status !== "all") {
      where.push("t.status = ?");
      params.push(status);
    }
    const rows = this.threadRows(
      where.join(" AND "),
      [...params, limit],
      "ORDER BY t.last_seq DESC LIMIT ?",
    );
    const last = rows.at(-1)?.last_seq;
    return {
      head: this.headSeq(),
      path,
      threads: this.threadViews(rows, true),
      next: rows.length === limit && last ? last : null,
    };
  }

  /** GET /comments/{thread}: one thread with its comments. */
  thread(id: string): ThreadView {
    const view = this.threadViews(this.threadRows("t.id = ?", [id]), true)[0];
    if (!view) throw new StoreError(404, "not_found", `No comment thread ${id}.`);
    return view;
  }

  /** Open threads per page path, for the tree. */
  private openThreadCounts(): Map<string, number> {
    const rows = this.sql.all<{ page_id: string; n: number }>(
      "SELECT page_id, COUNT(*) AS n FROM threads WHERE status = 'open' GROUP BY page_id",
    );
    return new Map(rows.map((r) => [r.page_id, r.n]));
  }

  /** How many open threads a page has (for `read`), from the partial index. */
  private openThreadsOf(pageId: string): number {
    return (
      this.sql.all<{ n: number }>(
        "SELECT COUNT(*) AS n FROM threads WHERE page_id = ? AND status = 'open'",
        pageId,
      )[0]?.n ?? 0
    );
  }

  // ---------------------------------------------------------------- maintainers and stats

  /**
   * The ledger as JSON lines (spec: Backups and recovery): every blob row, then every event, in
   * sequence order. Page records are inline; attachment bytes stay in R2 under blobs/<hash>.
   */
  dump(): string {
    const lines: string[] = [];
    const blobs = this.sql.all<{
      hash: string;
      size: number;
      location: string;
      content: string | ArrayBuffer | null;
      media: string | null;
    }>("SELECT hash, size, location, content, media FROM blobs ORDER BY rowid");
    for (const b of blobs) {
      const content =
        b.content === null || typeof b.content === "string"
          ? b.content
          : new TextDecoder().decode(b.content);
      lines.push(JSON.stringify({ t: "blob", ...b, content }));
    }
    const events = this.sql.all<EventRow & { meta: string | null }>(
      "SELECT * FROM events ORDER BY seq",
    );
    for (const e of events) {
      lines.push(JSON.stringify({ t: "event", ...e, meta: e.meta ? JSON.parse(e.meta) : null }));
    }
    return lines.length ? `${lines.join("\n")}\n` : "";
  }

  /**
   * The staleness process (TEMPRA-63): one range query over the indexed `stale_ms` finds every
   * page that is stale or stale soon, and the flags are brought in line with it. A write keeps
   * its page's flags current when `stale_after` moves, so a run only catches what time alone
   * changed. Returns what newly became stale soon or stale, for alerts and the digest.
   */
  maintainStaleness(): StalenessRun {
    const now = this.clock();
    const t = now.getTime();
    return this.sql.transaction(() => {
      const seq = this.headSeq();
      const due = this.sql.all<{
        page_id: string;
        stale_after: string;
        stale_ms: number;
        path: string;
      }>(
        `SELECT c.page_id, c.stale_after, c.stale_ms, p.path FROM pages c
         JOIN paths p ON p.page_id = c.page_id WHERE c.stale_ms <= ?`,
        t + STALE_SOON_DAYS * 86_400_000,
      );
      const flagged = new Map(
        this.sql
          .all<{ page_id: string; kind: string }>(
            "SELECT page_id, kind FROM flags WHERE kind IN ('stale', 'stale_soon')",
          )
          .map((f) => [f.page_id, f.kind]),
      );
      const run: StalenessRun = { stale: 0, stale_soon: 0, became: { stale: [], stale_soon: [] } };
      for (const r of due) {
        const state: Staleness = r.stale_ms <= t ? "stale" : "stale_soon";
        run[state]++;
        const was = flagged.get(r.page_id);
        flagged.delete(r.page_id);
        if (was === state) continue;
        this.setStaleFlag(r.page_id, r.stale_after, seq);
        run.became[state].push(r.path);
      }
      // Left over: flags whose page is no longer due (a clock set back, a restored row).
      for (const id of flagged.keys()) this.setStaleFlag(id, null, seq);
      for (const k of ["stale", "stale_soon"] as const) run.became[k].sort();
      this.sql.run(
        `INSERT INTO cursors (maintainer, seq) VALUES ('staleness', ?)
         ON CONFLICT(maintainer) DO UPDATE SET seq = excluded.seq`,
        seq,
      );
      this.setMaintenance({
        staleness_at: iso(now),
        staleness_counts: JSON.stringify({ stale: run.stale, stale_soon: run.stale_soon }),
      });
      return run;
    });
  }

  /**
   * The structure process (TEMPRA-64): directory and index health. Writes keep the flags of the
   * directories they touch current; this daily run checks the whole library again, which catches
   * what a write changed elsewhere (a page left with no links in). It runs only when the ledger
   * moved since its cursor. Returns the counts now, and what was newly flagged.
   */
  maintainStructure(): StructureRun {
    const now = this.clock();
    return this.sql.transaction(() => {
      const seq = this.headSeq();
      const cursor =
        this.sql.all<{ seq: number }>("SELECT seq FROM cursors WHERE maintainer = 'structure'")[0]
          ?.seq ?? -1;
      const became = cursor === seq ? [] : this.syncStructure(null, seq).became;
      const flags = this.sql.all<{ page_id: string; detail: string }>(
        "SELECT page_id, detail FROM flags WHERE kind = 'structure'",
      );
      const run: StructureRun = {
        skipped: cursor === seq,
        pages: 0,
        directories: 0,
        codes: {},
        became: [],
      };
      for (const f of flags) {
        if (isDirKey(f.page_id)) run.directories++;
        else run.pages++;
        for (const i of JSON.parse(f.detail) as StructureIssue[]) {
          run.codes[i.code] = (run.codes[i.code] ?? 0) + 1;
        }
      }
      const paths = new Map(
        this.sql
          .all<{ page_id: string; path: string }>(
            "SELECT page_id, path FROM paths WHERE page_id IN (SELECT value FROM json_each(?))",
            JSON.stringify(became.filter((k) => !isDirKey(k))),
          )
          .map((r) => [r.page_id, r.path]),
      );
      run.became = became
        .map((k) => (isDirKey(k) ? dirIndex(k.slice(4)) : (paths.get(k) ?? "")))
        .filter((p) => p !== "")
        .sort();
      this.sql.run(
        `INSERT INTO cursors (maintainer, seq) VALUES ('structure', ?)
         ON CONFLICT(maintainer) DO UPDATE SET seq = excluded.seq`,
        seq,
      );
      this.setMaintenance({
        structure_at: iso(now),
        structure_counts: JSON.stringify({
          pages: run.pages,
          directories: run.directories,
          codes: run.codes,
        }),
      });
      return run;
    });
  }

  /** A maintainer's cursor: the ledger seq its last complete run reached, or -1 before any. */
  private cursorOf(maintainer: string): number {
    return (
      this.sql.all<{ seq: number }>("SELECT seq FROM cursors WHERE maintainer = ?", maintainer)[0]
        ?.seq ?? -1
    );
  }

  private setCursor(maintainer: string, seq: number) {
    this.sql.run(
      `INSERT INTO cursors (maintainer, seq) VALUES (?, ?)
       ON CONFLICT(maintainer) DO UPDATE SET seq = excluded.seq`,
      maintainer,
      seq,
    );
  }

  /**
   * The link-health process (TEMPRA-65; tempra-dev: v2/maintainers): checks pages' links,
   * source resources and footnotes again from their stored trees, as a reader sees them now, and
   * brings the `broken_link` flags and the footnote lint in line where they drifted from that.
   * The write path keeps both current for what a request touches; this catches what it cannot
   * see. Each run checks the pages changed since its cursor and the pages that link to
   * them, then continues a full walk if one is under way (the first run, a new version of the
   * checks, or more changes than one pass checks), at most LINK_BUDGET pages a pass, in path
   * order, resuming where the last pass stopped. Writes only derived state: flags, the links
   * index, stored lint, its cursor and meta; never content or the ledger.
   */
  maintainLinks(budget = LINK_BUDGET): LinksRun {
    const now = this.clock();
    return this.sql.transaction(() => {
      const seq = this.headSeq();
      const m = this.maintenance();
      const cursor = this.cursorOf("links");
      // Where a full walk resumes (after this path), or null when none is under way.
      let walk: string | null = m.links_walk ? (JSON.parse(m.links_walk) as string | null) : null;
      if (cursor < 0 || m.links_version !== String(LINK_CHECKS_VERSION)) walk = "";
      const snap = this.snapshot();
      const queue: { id: string; path: string }[] = [];
      const seen = new Set<string>();
      const add = (id: string) => {
        const e = snap.byId.get(id);
        if (e?.kind !== "page" || seen.has(id)) return;
        seen.add(id);
        queue.push({ id, path: e.path });
      };
      if (cursor >= 0 && cursor < seq) {
        const changed = this.linksChangedSince(cursor);
        // More than a pass checks: walk the whole library from the start instead.
        if (changed.length > budget) walk = "";
        else for (const id of changed) add(id);
      }
      queue.sort((a, b) => (a.path < b.path ? -1 : 1));
      const skipped = queue.length === 0 && walk === null;
      if (walk !== null) {
        const room = Math.max(budget - queue.length, 0);
        const next = this.sql.all<{ page_id: string; path: string }>(
          "SELECT page_id, path FROM paths WHERE kind = 'page' AND path > ? ORDER BY path LIMIT ?",
          walk,
          room + 1,
        );
        for (const r of next.slice(0, room)) add(r.page_id);
        if (next.length <= room) walk = null;
        else if (room > 0) walk = next[room - 1]?.path ?? walk;
      }
      const repaired: string[] = [];
      for (const q of queue) if (this.recheckLinks(snap, q.id)) repaired.push(q.path);
      // A page gone keeps no broken-link flag (unindex drops them; this is a safety net).
      this.sql.run(
        "DELETE FROM flags WHERE kind = 'broken_link' AND page_id NOT IN (SELECT page_id FROM paths)",
      );
      this.setCursor("links", seq);
      const count = (q: string) => this.sql.all<{ n: number }>(q)[0]?.n ?? 0;
      const run: LinksRun = {
        skipped,
        checked: queue.length,
        repaired: repaired.sort(),
        broken_link: count(
          `SELECT COUNT(*) AS n FROM flags f JOIN paths p ON p.page_id = f.page_id
           WHERE f.kind = 'broken_link'`,
        ),
        footnote: count(
          `SELECT COUNT(*) AS n FROM flags f JOIN paths p ON p.page_id = f.page_id
           WHERE f.kind = 'lint' AND (f.detail LIKE '%"footnote_unmatched"%'
             OR f.detail LIKE '%"footnote_undefined"%')`,
        ),
        pending: walk !== null,
      };
      this.setMaintenance({
        links_at: iso(now),
        links_walk: JSON.stringify(walk),
        links_version: String(LINK_CHECKS_VERSION),
        links_counts: JSON.stringify({
          checked: run.checked,
          repaired: run.repaired.length,
          broken_link: run.broken_link,
          footnote: run.footnote,
        }),
      });
      return run;
    });
  }

  /**
   * The pages whose links may read differently since `cursor`: every page a content event
   * since then wrote, moved, reverted or deleted, and every page linking to one of them by ID,
   * by one of their paths, or through a redirect from one.
   */
  private linksChangedSince(cursor: number): string[] {
    const rows = this.sql.all<{ page_id: string; path: string }>(
      "SELECT DISTINCT page_id, path FROM events WHERE seq > ? AND op <> 'comment' AND page_id <> ''",
      cursor,
    );
    const ids = JSON.stringify([...new Set(rows.map((r) => r.page_id))]);
    const paths = JSON.stringify(
      [...new Set(rows.map((r) => r.path))].flatMap((p) => [
        p,
        p.endsWith(".md") ? p.slice(0, -3) : `${p}.md`,
      ]),
    );
    const linking = this.sql.all<{ from_id: string }>(
      `SELECT DISTINCT from_id FROM links
       WHERE to_id IN (SELECT value FROM json_each(?)) OR to_path IN (SELECT value FROM json_each(?))`,
      ids,
      paths,
    );
    return [...new Set([...rows.map((r) => r.page_id), ...linking.map((r) => r.from_id)])];
  }

  /**
   * One page's links and footnotes checked again from its stored tree. Broken links are what
   * `links()` shows a reader (no target by ID, by path or through a redirect); when the stored
   * flag or lint says otherwise, the page's rows in the links index are rebuilt from its
   * record and its flag and lint refreshed as a write would. Dangling footnotes replace the
   * stored ones when they differ. Returns whether anything was repaired.
   */
  private recheckLinks(snap: View, id: string): boolean {
    const e = snap.byId.get(id);
    if (e?.kind !== "page") return false;
    const r = this.record(e.hash);
    const lintOf = () =>
      JSON.parse(
        this.sql.all<{ lint: string | null }>("SELECT lint FROM pages WHERE page_id = ?", id)[0]
          ?.lint ?? "[]",
      ) as LintWarning[];
    let repaired = false;
    const graph = linkGraph(r);
    const targets = graph.map(([l]) => this.targetAt(snap, l));
    const broken = graph.flatMap(([l], i) => (targets[i] ? [] : [l.path]));
    const flag = this.sql.all<{ detail: string }>(
      "SELECT detail FROM flags WHERE page_id = ? AND kind = 'broken_link'",
      id,
    )[0];
    const flagged = flag ? (JSON.parse(flag.detail) as string[]) : [];
    const linted = lintOf()
      .filter((l) => l.code === "broken_link")
      .map((l) => l.target ?? "");
    if (!sameTargets(broken, flagged) || !sameTargets(broken, linted)) {
      this.sql.run("DELETE FROM links WHERE from_id = ?", id);
      graph.forEach(([l, kind], i) => {
        this.sql.run(
          "INSERT INTO links (from_id, to_id, to_path, anchor, form, raw, kind) VALUES (?, ?, ?, ?, ?, ?, ?)",
          id,
          targets[i]?.page_id ?? null,
          l.path,
          l.anchor,
          l.form,
          l.raw,
          kind,
        );
      });
      this.refreshBroken(id);
      repaired = true;
    }
    if (r.raw_fm === null) {
      const current = lintOf();
      const want = danglingFootnotes(r.fm, r.generated, r.doc, e.path);
      const have = current.filter((l) => FOOTNOTE_CODES.has(l.code));
      if (!sameLint(want, have)) {
        const all = [...current.filter((l) => !FOOTNOTE_CODES.has(l.code)), ...want];
        this.sql.run("UPDATE pages SET lint = ? WHERE page_id = ?", JSON.stringify(all), id);
        this.setLintFlag(id, all, e.seq);
        repaired = true;
      }
    }
    return repaired;
  }

  /**
   * The library's health summary (TEMPRA-66), worked out now: open work by kind, the pages
   * changed since anyone last verified them (the newest first), and when. No model involved.
   */
  private computeHealth(): LibraryHealth {
    const work = this.workCounts();
    const n = (k: string) => work.counts[k] ?? 0;
    const rows = this.sql.all<{ path: string; seq: number; ts: string; actor: string }>(
      `SELECT p.path, e.seq, e.ts, e.actor ${UNVERIFIED} ORDER BY e.seq DESC LIMIT ?`,
      HEALTH_NEWEST,
    );
    return {
      at: iso(this.clock()),
      seq: this.headSeq(),
      counts: {
        stale: n("stale"),
        stale_soon: work.stale_soon,
        broken_link: n("broken_link"),
        lint: n("lint"),
        structure: n("structure"),
        comment: n("comment"),
        // Only once there are requests (TEMPRA-222), as summaries kept before them had none.
        ...(n("request") > 0 ? { request: n("request") } : {}),
        external_image: n("external_image"),
      },
      unverified: {
        total: this.sql.all<{ n: number }>(`SELECT COUNT(*) AS n ${UNVERIFIED}`)[0]?.n ?? 0,
        newest: rows,
      },
    };
  }

  /** The health process: the summary, kept in meta for start, the app and the digests. */
  maintainHealth(): LibraryHealth {
    const health = this.computeHealth();
    this.setMaintenance({ health: JSON.stringify(health) });
    return health;
  }

  /** The summary the daily pass kept, or one worked out now before the first pass has run. */
  health(): LibraryHealth {
    const kept = this.maintenance().health;
    return kept ? (JSON.parse(kept) as LibraryHealth) : this.computeHealth();
  }

  /** The usage-rollup maintainer: drops read counts older than the usage window. */
  pruneUsage(): number {
    this.flushReads();
    const before = this.sql.all<{ n: number }>("SELECT COUNT(*) AS n FROM access_log")[0]?.n ?? 0;
    this.sql.run("DELETE FROM access_log WHERE day < ?", this.windowStart());
    // A last read is kept past the window (a cold page says when), while its page exists.
    this.sql.run("DELETE FROM last_read WHERE page_id NOT IN (SELECT page_id FROM paths)");
    const after = this.sql.all<{ n: number }>("SELECT COUNT(*) AS n FROM access_log")[0]?.n ?? 0;
    return before - after;
  }

  /**
   * What the next maintenance pass would find to do (TEMPRA-82), for scheduling the library's
   * alarm: whether the ledger moved since the last export, and when the next export, stale or
   * stale-soon page and read count falls due. Indexed lookups only.
   */
  maintenanceDue(now: Date): MaintenanceDue {
    const t = now.getTime();
    const m = this.maintenance();
    const seq = this.headSeq();
    const min = (q: string, ...p: SqlValue[]) =>
      this.sql.all<{ t: number | null }>(q, ...p)[0]?.t ?? null;
    const soonMs = STALE_SOON_DAYS * 86_400_000;
    // The next page to come within the stale-soon window, and the next to pass its date.
    const staleAt = [
      min("SELECT MIN(stale_ms) AS t FROM pages WHERE stale_ms > ?", t + soonMs),
      min("SELECT MIN(stale_ms) AS t FROM pages WHERE stale_ms > ?", t),
    ]
      .map((x, i) => (x === null ? null : i === 0 ? x - soonMs : x))
      .filter((x): x is number => x !== null);
    const oldestRead = [
      this.sql.all<{ day: string | null }>("SELECT MIN(day) AS day FROM access_log")[0]?.day,
      ...this.reads.keys(),
    ]
      .filter((d): d is string => !!d)
      .sort()[0];
    const expiry = m.export_expiry;
    return {
      exportPending: seq > 0 && seq !== Number(m.export_seq ?? -1),
      // Unknown until a pass has recorded it: due, so the next pass finds out.
      exportExpiry: expiry === undefined ? t : expiry === "none" ? null : Date.parse(expiry),
      staleAt: staleAt.length > 0 ? Math.min(...staleAt) : null,
      usageExpiry: oldestRead
        ? Date.parse(`${oldestRead}T00:00:00Z`) + USAGE_WINDOW_DAYS * 86_400_000
        : null,
      // A link-health walk under way (TEMPRA-65): the next slot continues it.
      processPending: linksWalking(m),
    };
  }

  /** Maintainer bookkeeping (last run, cursors) kept in the meta table under `maint:`. */
  maintenance(): Record<string, string> {
    const rows = this.sql.all<{ key: string; value: string }>(
      // A range on the key, which its index serves; LIKE would read every meta row (TEMPRA-293).
      "SELECT key, value FROM meta WHERE key >= 'maint:' AND key < 'maint;'",
    );
    return Object.fromEntries(rows.map((r) => [r.key.slice(6), r.value]));
  }

  setMaintenance(values: Record<string, string>) {
    for (const [k, v] of Object.entries(values)) {
      this.sql.run(
        "INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        `maint:${k}`,
        v,
      );
    }
  }

  /** GET /stats (spec: Observability): sizes, counts and each maintainer's cursor lag. */
  /**
   * Bytes the library uses against its storage limit (v2 spec: Limits): its SQLite (pages,
   * ledger, indexes) plus every attachment it has stored in R2.
   */
  storageBytes(): number {
    const r2 =
      this.sql.all<{ n: number | null }>(
        "SELECT SUM(size) AS n FROM blobs WHERE location = 'r2'",
      )[0]?.n ?? 0;
    return (this.size ? this.size() : 0) + r2;
  }

  /** Which of these attachment hashes this library already holds (TEMPRA-91: only new ones are recorded in D1). */
  hasBlobs(hashes: string[]): Set<string> {
    const have = new Set<string>();
    for (const h of new Set(hashes)) {
      if (this.sql.all("SELECT 1 FROM blobs WHERE hash = ? AND location = 'r2'", h).length > 0) {
        have.add(h);
      }
    }
    return have;
  }

  /** The attachment hashes this library references in R2, for the daily blob sweep. */
  blobHashes(): string[] {
    return this.sql
      .all<{ hash: string }>("SELECT hash FROM blobs WHERE location = 'r2'")
      .map((r) => r.hash);
  }

  /**
   * GET /agents: who has acted in the library, each person and each of their agents, from the
   * `by` the ledger records (TEMPRA-75), most recent first. An agent becomes one of the
   * library's members the first time it acts here. Requests recorded before then have none.
   */
  contributors() {
    // Kept by the ledger's triggers (TEMPRA-86): the groups of `by` with their counts.
    const rows = this.sql.all<{
      person: string;
      agent: string | null;
      requests: number;
      first_seq: number;
      last_seq: number;
    }>(
      `SELECT person, agent, requests, first_seq, last_seq FROM contributors
       ORDER BY last_seq DESC LIMIT 500`,
    );
    return rows.map((r) => {
      const last = this.sql.all<{ actor: string; ts: string }>(
        "SELECT actor, ts FROM events WHERE seq = ?",
        r.last_seq,
      )[0];
      return { ...r, actor: last?.actor ?? "", last_ts: last?.ts ?? "" };
    });
  }

  stats() {
    const one = (q: string) => this.sql.all<{ n: number }>(q)[0]?.n ?? 0;
    const seq = this.headSeq();
    // Kept by the ledger's triggers (TEMPRA-86), not counted over it.
    const ledger = this.sql.all<{ events: number; requests: number }>(
      "SELECT events, requests FROM ledger_counts WHERE id = 1",
    )[0];
    const m = this.maintenance();
    const exportSeq = m.export_seq ? Number(m.export_seq) : 0;
    const stalenessSeq =
      this.sql.all<{ seq: number }>("SELECT seq FROM cursors WHERE maintainer = 'staleness'")[0]
        ?.seq ?? 0;
    const structureSeq =
      this.sql.all<{ seq: number }>("SELECT seq FROM cursors WHERE maintainer = 'structure'")[0]
        ?.seq ?? 0;
    return {
      seq,
      paths: one("SELECT COUNT(*) AS n FROM paths"),
      pages: one("SELECT COUNT(*) AS n FROM paths WHERE kind = 'page'"),
      attachments: one("SELECT COUNT(*) AS n FROM paths WHERE kind = 'attachment'"),
      events: ledger?.events ?? 0,
      requests: ledger?.requests ?? 0,
      bytes: this.size ? this.size() : null,
      // Every maintainer here is a process: deterministic, run by Tempra from the daily alarm.
      // Managed agents will be listed beside them as kind "agent".
      maintainers: {
        export: {
          kind: "process",
          cursor: exportSeq,
          lag: seq - exportSeq,
          last_run: m.export_at ?? null,
          last_key: m.export_key ?? null,
        },
        usage: { kind: "process", last_run: m.usage_at ?? null, window_days: USAGE_WINDOW_DAYS },
        staleness: {
          kind: "process",
          cursor: stalenessSeq,
          lag: seq - stalenessSeq,
          last_run: m.staleness_at ?? null,
          ...(JSON.parse(m.staleness_counts ?? '{"stale":0,"stale_soon":0}') as {
            stale: number;
            stale_soon: number;
          }),
          soon_days: STALE_SOON_DAYS,
        },
        structure: {
          kind: "process",
          cursor: structureSeq,
          lag: seq - structureSeq,
          last_run: m.structure_at ?? null,
          ...(JSON.parse(m.structure_counts ?? '{"pages":0,"directories":0,"codes":{}}') as {
            pages: number;
            directories: number;
            codes: Record<string, number>;
          }),
        },
        links: {
          kind: "process",
          cursor: Math.max(this.cursorOf("links"), 0),
          lag: seq - Math.max(this.cursorOf("links"), 0),
          last_run: m.links_at ?? null,
          pending: linksWalking(m),
          ...(JSON.parse(
            m.links_counts ?? '{"checked":0,"repaired":0,"broken_link":0,"footnote":0}',
          ) as { checked: number; repaired: number; broken_link: number; footnote: number }),
        },
        health: {
          kind: "process",
          last_run: m.health ? (JSON.parse(m.health) as LibraryHealth).at : null,
        },
      },
      next_run: m.next_run ?? null,
    };
  }

  /** Counts for the MCP `start` entry point and the library list. */
  summary() {
    // Counted in SQL, never a record per page (TEMPRA-86).
    const rows = this.sql.all<{ kind: Kind; n: number }>(
      "SELECT kind, COUNT(*) AS n FROM paths GROUP BY kind",
    );
    let pages = 0;
    let attachments = 0;
    for (const r of rows) {
      if (r.kind === "attachment") attachments += r.n;
      else pages += r.n;
    }
    const work = this.workCounts();
    return {
      seq: this.headSeq(),
      // The newest event's time, the library list's last activity (TEMPRA-202).
      last_activity:
        this.sql.all<{ ts: string }>(
          "SELECT ts FROM events WHERE seq = (SELECT MAX(seq) FROM events)",
        )[0]?.ts ?? null,
      pages,
      attachments,
      open_work: work.total,
      stale_soon: work.stale_soon,
      health: this.health(),
      open_comments:
        this.sql.all<{ n: number }>(
          `SELECT COUNT(*) AS n FROM threads t LEFT JOIN paths p ON p.page_id = t.page_id
           WHERE t.status = 'open' AND (p.page_id IS NOT NULL OR t.page_id = '')`,
        )[0]?.n ?? 0,
    };
  }

  // ---------------------------------------------------------------- the app's person views

  /**
   * GET /needs (Needs you, layout take 3): what only a person can do in this library, for `me`,
   * the person asking (their users id and human: actor), at head. Threads waiting on their reply:
   * open, the last comment not theirs in person (their agents' replies are news to them, as in
   * notify.ts), and they took part (wrote in it, themselves or through an agent) or were
   * mentioned in it. Pages to verify, as the health summary counts them, paged by offset.
   * The agents' housekeeping (stale pages among it, TEMPRA-142), counted only.
   */
  needs(
    me: { person: string | null; actor: string | null },
    opts: { offset?: number; limit?: number } = {},
  ): Needs {
    // Who wrote an event: its `by` (TEMPRA-75), or its actor for events from before `by` was
    // kept. In person: no agent. Nobody to compare with (a NULL) is never a match.
    const inPerson = (e: string) =>
      `IFNULL(CASE WHEN json_extract(${e}.meta, '$.by.person') IS NULL THEN ${e}.actor = ?
         ELSE json_extract(${e}.meta, '$.by.person') = ? AND json_extract(${e}.meta, '$.by.agent') IS NULL
       END, 0)`;
    const byThem = (e: string) =>
      `IFNULL(CASE WHEN json_extract(${e}.meta, '$.by.person') IS NULL THEN ${e}.actor = ?
         ELSE json_extract(${e}.meta, '$.by.person') = ? END, 0)`;
    const threads = this.sql.all<{
      id: string;
      anchor: string | null;
      path: string;
      title: string | null;
      actor: string;
      body: string;
      ts: string;
      seq: number;
      by_person: string | null;
      by_agent: string | null;
    }>(
      `SELECT t.id, t.anchor, p.path, c.title, m.actor, m.body, m.ts, m.seq,
              json_extract(e.meta, '$.by.person') AS by_person,
              json_extract(e.meta, '$.by.agent') AS by_agent
       FROM threads t JOIN paths p ON p.page_id = t.page_id
       LEFT JOIN pages c ON c.page_id = t.page_id
       JOIN comments m ON m.id = (
         SELECT id FROM comments WHERE thread_id = t.id ORDER BY seq DESC LIMIT 1)
       JOIN events e ON e.seq = m.seq
       WHERE t.status = 'open' AND NOT ${inPerson("e")}
         AND EXISTS (
           SELECT 1 FROM events x
           WHERE x.page_id = t.page_id AND x.op = 'comment'
             AND json_extract(x.meta, '$.comment.thread') = t.id
             AND ((json_extract(x.meta, '$.comment.body') IS NOT NULL AND ${byThem("x")})
               OR EXISTS (SELECT 1 FROM json_each(x.meta, '$.comment.mentions') n
                          WHERE json_extract(n.value, '$.user') = ?)))
       ORDER BY t.last_seq DESC LIMIT ?`,
      me.actor,
      me.person,
      me.actor,
      me.person,
      me.person,
      NEEDS_REPLIES,
    );
    const replies = threads.map((t) => ({
      thread: t.id,
      path: t.path,
      title: t.title,
      quote: t.anchor ? (JSON.parse(t.anchor) as StoredAnchor).quote : null,
      last: {
        actor: t.actor,
        by: byOf(t.by_person, t.by_agent),
        body: t.body,
        ts: t.ts,
        seq: t.seq,
      },
    }));

    const limit = Math.min(Math.max(opts.limit ?? 20, 1), 200);
    const offset = Math.max(opts.offset ?? 0, 0);
    const total =
      this.sql.all<{ n: number }>(`SELECT COUNT(*) AS n ${CHANGED_SINCE_A_PERSON}`)[0]?.n ?? 0;
    const never =
      this.sql.all<{ n: number }>(`SELECT COUNT(*) AS n ${NEVER_BY_A_PERSON}`)[0]?.n ?? 0;
    const toVerify = this.sql.all<{
      path: string;
      page_id: string;
      title: string | null;
      seq: number;
      ts: string;
      actor: string;
      by_person: string | null;
      by_agent: string | null;
    }>(
      `SELECT p.path, p.page_id, e.seq, e.ts, e.actor,
              (SELECT title FROM pages c WHERE c.page_id = p.page_id) AS title,
              json_extract(e.meta, '$.by.person') AS by_person,
              json_extract(e.meta, '$.by.agent') AS by_agent
       ${CHANGED_SINCE_A_PERSON} ORDER BY e.seq DESC LIMIT ? OFFSET ?`,
      limit,
      offset,
    );
    const items = toVerify.flatMap((r) => {
      // The person's latest verification, which the changes are counted from (the query found one).
      const v = this.sql.all<{ by: string; at: string; seq: number }>(
        `SELECT by, at, seq FROM verifications WHERE page_id = ? AND by LIKE 'human:%'
         ORDER BY seq DESC LIMIT 1`,
        r.page_id,
      )[0];
      if (!v) return [];
      const changes =
        this.sql.all<{ n: number }>(
          `SELECT COUNT(*) AS n FROM events WHERE page_id = ? AND seq > ? AND ${CONTENT_EVENT}`,
          r.page_id,
          v.seq,
        )[0]?.n ?? 0;
      return [
        {
          path: r.path,
          title: r.title,
          seq: r.seq,
          ts: r.ts,
          actor: r.actor,
          by: byOf(r.by_person, r.by_agent),
          verified: { actor: v.by, seq: v.seq, ts: v.at },
          changes,
        },
      ];
    });

    const work = this.workCounts().counts;
    const housekeeping = {
      stale: work.stale ?? 0,
      lint: work.lint ?? 0,
      structure: work.structure ?? 0,
      broken_link: work.broken_link ?? 0,
      total: 0,
    };
    housekeeping.total =
      housekeeping.stale + housekeeping.lint + housekeeping.structure + housekeeping.broken_link;
    return {
      seq: this.headSeq(),
      replies,
      verify: {
        total,
        items,
        next_offset: offset + limit < total ? offset + limit : null,
      },
      unverified: { total: never },
      housekeeping,
      count: replies.length + total,
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
    return this.sign("", payload, ttlSeconds);
  }

  /** Checks a download token's signature and expiry. */
  openDownload(token: string): DownloadPayload {
    const bad = new StoreError(
      403,
      "bad_download",
      "This download link is invalid or has expired.",
    );
    const payload = this.unsign<DownloadPayload>("", token, bad);
    if (payload.k !== "file" && payload.k !== "export") throw bad;
    return payload;
  }

  /**
   * A short-lived token for an upload URL (TEMPRA-158): what the Worker writes when the bytes
   * arrive, and as whom. Opaque (TEMPRA-210): 18 random bytes; the prepared write is kept here,
   * not in the link, so a link pasted elsewhere tells no one its path, note, people or grant.
   * Kept until it would have expired; each can be spent once.
   */
  signUpload(payload: Record<string, unknown>, ttlSeconds = 900): string {
    const now = Math.floor(this.clock().getTime() / 1000);
    const exp = now + ttlSeconds;
    const token = b64url(randomBytes(18));
    this.sql.run(
      "DELETE FROM meta WHERE key LIKE 'ulgrant:%' AND CAST(json_extract(value, '$.exp') AS INTEGER) < ?",
      now,
    );
    this.sql.run(
      "INSERT INTO meta (key, value) VALUES (?, ?)",
      `ulgrant:${token}`,
      JSON.stringify({ payload: { ...payload, exp }, exp, spent: false }),
    );
    return token;
  }

  /**
   * An upload token's prepared write, when it is known, unexpired and unspent. With `claim` it is
   * spent in this one synchronous call, so two uploads on one link cannot both pass.
   */
  openUpload(token: string, opts: { claim?: boolean } = {}): Record<string, unknown> {
    const bad = new StoreError(
      403,
      "bad_upload",
      "This upload link is invalid or has expired. Ask for a new one with prepare_upload.",
    );
    if (!/^[A-Za-z0-9_-]{24}$/.test(token)) throw bad;
    const key = `ulgrant:${token}`;
    const row = this.sql.all<{ value: string }>("SELECT value FROM meta WHERE key = ?", key)[0];
    if (!row) throw bad;
    const held = JSON.parse(row.value) as {
      payload: Record<string, unknown>;
      exp: number;
      spent: boolean;
    };
    if (held.exp * 1000 < this.clock().getTime()) throw bad;
    if (held.spent) {
      throw new StoreError(
        403,
        "upload_used",
        "This upload link was already used. Ask for a new one with prepare_upload.",
      );
    }
    if (opts.claim) {
      this.sql.run(
        "UPDATE meta SET value = ? WHERE key = ?",
        JSON.stringify({ ...held, spent: true }),
        key,
      );
    }
    return held.payload;
  }

  private sign(domain: string, payload: object, ttlSeconds: number): string {
    const exp = Math.floor(this.clock().getTime() / 1000) + ttlSeconds;
    const body = b64url(new TextEncoder().encode(JSON.stringify({ ...payload, exp })));
    const mac = hmac(sha256, this.signingKey(), new TextEncoder().encode(domain + body));
    return `${body}.${b64url(mac)}`;
  }

  private unsign<T>(domain: string, token: string, bad: StoreError): T & { exp: number } {
    const [body, sig] = token.split(".");
    if (!body || !sig) throw bad;
    const mac = hmac(sha256, this.signingKey(), new TextEncoder().encode(domain + body));
    const expected = b64url(mac);
    if (expected.length !== sig.length || !equalBytes(expected, sig)) throw bad;
    let payload: T & { exp: number };
    try {
      payload = JSON.parse(new TextDecoder().decode(fromB64url(body)));
    } catch {
      throw bad;
    }
    if (typeof payload?.exp !== "number" || payload.exp * 1000 < this.clock().getTime()) throw bad;
    return payload;
  }
}

export type DownloadPayload =
  | { k: "file"; path: string; hash: string; media: string | null }
  | { k: "export"; at: number; name?: string; format?: ExportFormat };

/** An export's shape: the files as they are, or a bundle that conforms to Google's OKF. */
export const EXPORT_FORMATS = ["plain", "okf"] as const;
export type ExportFormat = (typeof EXPORT_FORMATS)[number];

/** The type OKF requires, on a page that has none. */
export const OKF_DEFAULT_TYPE = "Page";

/**
 * A record as an OKF export writes it: a page whose `type` is missing, empty or not a string
 * (writes no longer check it) gets `type: Page` in its place, so the bundle has exactly one,
 * non-empty `type` on every page. Unchanged when `okf` is false or the type is usable.
 */
export function okfTyped(r: PageRecord, okf: boolean): PageRecord {
  if (!okf) return r;
  const t = field(r, "type");
  if (typeof t === "string" && t.trim() !== "") return r;
  return {
    ...r,
    fm: [["type", OKF_DEFAULT_TYPE], ...r.fm.filter(([k]) => k !== "type")],
  };
}

/** What one run of the structure process found: flags now set, and what was newly flagged. */
export interface StructureRun {
  /** Nothing was written since the last run, so nothing was checked again. */
  skipped: boolean;
  /** Pages and directories flagged, and how many flags carry each check. */
  pages: number;
  directories: number;
  codes: Record<string, number>;
  /** Pages, or directories' index.md, flagged by this run that were not before. */
  became: string[];
}

/**
 * What one run of the link-health process (TEMPRA-65) did, and the counts after it: pages
 * with broken links (body links and internal source resources) and with dangling footnotes.
 */
export interface LinksRun {
  /** Nothing was written since the last run and no walk was under way: nothing was checked. */
  skipped: boolean;
  /** Pages checked in this pass (at most the pass's budget). */
  checked: number;
  /** Pages whose flags or lint the pass corrected, by path. */
  repaired: string[];
  broken_link: number;
  footnote: number;
  /** A full walk is under way and the next pass continues it. */
  pending: boolean;
}

/**
 * How many pages one link-health pass checks again at most (TEMPRA-65), so a pass stays a
 * small, bounded share of the object's time on a large library: about 85 ms for 1,000 on the
 * 5,000-page bench (`scripts/links-bench.ts`), so a full walk there takes five daily passes.
 */
export const LINK_BUDGET = 1000;

/**
 * The link-health checks' version: a pass that finds another version stored walks the whole
 * library again, so a change to the checks reaches every page, a budget at a time.
 */
export const LINK_CHECKS_VERSION = 1;

/** Whether a link-health walk is under way, from the maintenance meta. */
const linksWalking = (m: Record<string, string>) =>
  m.links_walk !== undefined && m.links_walk !== "null";

/** How many of the newest unverified changes the health summary names. */
/** What a library's next maintenance pass would have to do, and when (TEMPRA-82); times in ms. */
export interface MaintenanceDue {
  /** The ledger moved since the last export. */
  exportPending: boolean;
  /** When the oldest export but the newest passes retention; null with nothing to prune. */
  exportExpiry: number | null;
  /** The next moment a page comes within the stale-soon window or passes `stale_after`. */
  staleAt: number | null;
  /** When the oldest read count leaves the usage window. */
  usageExpiry: number | null;
  /** A process has budgeted work left over (a link-health walk): the next slot runs it. */
  processPending?: boolean;
}

export const HEALTH_NEWEST = 5;

/** A library's health summary (TEMPRA-66), as the daily pass leaves it in meta. */
export interface LibraryHealth {
  /** When it was worked out, and the ledger's head then. */
  at: string;
  seq: number;
  /** Open work by kind; stale_soon looks ahead and is not part of the queue. */
  counts: {
    stale: number;
    stale_soon: number;
    broken_link: number;
    lint: number;
    structure: number;
    comment: number;
    /** Open requests (TEMPRA-222); absent from summaries kept before them. */
    request?: number;
    /** Pages with hotlinked images (TEMPRA-163); absent from summaries kept before it. */
    external_image?: number;
  };
  /** Pages whose latest change came after their latest verification (or that have none). */
  unverified: {
    total: number;
    newest: { path: string; seq: number; ts: string; actor: string }[];
  };
}

/** How many threads waiting on the person's reply Needs you lists. */
export const NEEDS_REPLIES = 50;

/** Needs you (layout take 3): what only a person can do in a library, for one person. */
export interface Needs {
  seq: number;
  /** Open threads waiting on their reply, the latest activity first. */
  replies: {
    thread: string;
    path: string;
    title: string | null;
    quote: string | null;
    /** The thread's latest comment. */
    last: { actor: string; by: ActionBy | null; body: string; ts: string; seq: number };
  }[];
  /** Pages a person verified that changed since; newest first. */
  verify: {
    total: number;
    items: {
      path: string;
      title: string | null;
      /** The page's latest event (as in the health summary), and who made it. */
      seq: number;
      ts: string;
      actor: string;
      by: ActionBy | null;
      /** Its latest verification by a person. */
      verified: { actor: string; seq: number; ts: string };
      /** Content events since that verification. */
      changes: number;
    }[];
    next_offset: number | null;
  };
  /** Pages no person has verified (TEMPRA-111): their standing, not a request, so counted only. */
  unverified: { total: number };
  /** The agents' share of the work queue, counted only: staleness is theirs (TEMPRA-142). */
  housekeeping: {
    stale: number;
    lint: number;
    structure: number;
    broken_link: number;
    total: number;
  };
  /** replies + verify.total. */
  count: number;
}

/** What one run of the staleness process found: counts now, and paths that changed state. */
export interface StalenessRun {
  stale: number;
  stale_soon: number;
  became: { stale: string[]; stale_soon: string[] };
}

export interface WorkItem {
  kind: string;
  path: string;
  since: string;
  detail: string;
  suggested_action: string;
  inbound_links: number;
  /** For a `comment` item: the thread to answer. */
  thread?: string;
}

/** The person and agent behind an event, from its meta's `by` (TEMPRA-75); null before it. */
function byOf(person: string | null, agent: string | null): ActionBy | null {
  if (typeof person !== "string") return null;
  return typeof agent === "string" ? { person, agent } : { person };
}

/** A comment's mentions for its event's meta: only when there are some. */
function mentionsMeta(mentions: Mention[] | undefined): JsonObject {
  if (!mentions || mentions.length === 0) return {};
  return { mentions: mentions.slice(0, 20) as unknown as JsonObject[] } as JsonObject;
}

/** `s` on one line, cut to `n` characters. */
function clip(s: string, n: number): string {
  const line = s.replace(/\s+/g, " ").trim();
  return line.length > n ? `${line.slice(0, n - 1)}…` : line;
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

/** A thread's page_id on the library itself (TEMPRA-222): no page, its events on no file. */
const LIBRARY_THREAD = "";

/** A threads row joined with its page's current path ("" and no hash for a library thread). */
interface ThreadRow {
  path: string;
  page_id: string;
  hash: string | null;
  kind: string;
  id: string;
  actor: string;
  anchor: string | null;
  status: ThreadStatus;
  created_seq: number;
  last_seq: number;
  last_actor: string;
  resolved_by: string | null;
  resolved_seq: number | null;
  replies: number;
}

/** A request's render jobs for its result, when it has any. */
const rendersOf = (w: WriteState): { render?: RenderJob[] } =>
  w.renders.length > 0 ? { render: w.renders } : {};

interface WriteState {
  ctx: RequestContext;
  now: string;
  mode: WriteMode;
  source: string | null;
  /** Paths created by this request, with pre-assigned page IDs. */
  pending: Map<string, string>;
  /** Paths written by this request and their page IDs. */
  written: Map<string, string>;
  /** Pages whose outbound links changed state, for flag refresh. */
  affected: Set<string>;
  /** Diagrams for the render service after the commit, at most RENDERS_PER_WRITE in all. */
  renders: RenderJob[];
}
