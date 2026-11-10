import type { ActedBy } from "./agents";
import { api } from "./api";
import { isAgentChange } from "./changes";
import type { FeedEvent } from "./live";
import { registerPage } from "./prefetch";
import type { OutlineFile } from "./tree";
import { day, plural } from "./ui";
import { type ActivityFilters, dirOf, folderName, type Urls, type Who } from "./urls";

/*
 * Activity (take 4, TEMPRA-115; by page since Option B, TEMPRA-308; tempra-dev: app/activity):
 * what happened, for people. By page: the agents working now, then each day's changes grouped by
 * page ("Edited twice by Claude Code for @dev, +252 −42 words"), a request that changed many
 * pages as one row (`byPage`); Every event: the ledger as a table (`eventRows`). The pages are
 * pages/ByPage.svelte and pages/EveryEvent.svelte; the hooks are in activity.svelte.ts.
 */

/** One ledger event as `GET …/requests` returns it (worker/src/store/store.ts `EventRow`). */
export interface LedgerEvent {
  seq: number;
  ts: string;
  actor: string;
  op: string;
  path: string;
  prev_hash: string | null;
  hash: string | null;
  page_id: string;
  meta: Record<string, unknown> | null;
}

/** One request with its events, oldest first (`RequestRow`). */
export interface LedgerRequest {
  request_id: string;
  ts: string;
  actor: string;
  note: string | null;
  by?: ActedBy | null;
  events: LedgerEvent[];
}

/** What a request did to one page or file. */
type What = "added" | "edited" | "rewrote" | "moved" | "deleted" | "reverted";

/**
 * Words an edit added and removed (the ledger's `meta.words`, on new versions), and how many the
 * text had before, when the ledger kept it.
 */
interface Words {
  added: number;
  removed: number;
  before?: number;
}

/** An edit that removed more than half of what the text said is a rewrite. */
const rewrote = (w: Words | null) =>
  w !== null && w.before !== undefined && w.before > 0 && w.removed * 2 > w.before;

/** A page or file a request touched, and what happened to it. */
export interface Touched {
  /** The page's id (the same across a move). */
  page: string;
  path: string;
  title: string;
  what: What;
  words: Words | null;
  /** Where a moved file was before. */
  from: string | null;
  /** The last event's sequence (a deleted file is shown as it was just before). */
  seq: number;
}

/** A page's title by its path (`useTitleOf().of`: the outline's title, else its file name). */
type TitleOf = (path: string) => string;

/** "+38 −12 words", or null when nothing changed. */
export function wordsText(w: Words | null): string | null {
  if (!w || (w.added === 0 && w.removed === 0)) return null;
  return `+${w.added} −${w.removed} words`;
}

const asWords = (v: unknown): Words | null => {
  const w = v as Partial<Words> | null | undefined;
  if (!w || typeof w.added !== "number" || typeof w.removed !== "number") return null;
  return typeof w.before === "number"
    ? { added: w.added, removed: w.removed, before: w.before }
    : { added: w.added, removed: w.removed };
};

const isPage = (path: string) => path.endsWith(".md");

/** What a request's content events did, one row per page, in the order it was first touched. */
export function touchedBy(events: LedgerEvent[], titleOf: TitleOf): Touched[] {
  const byPage = new Map<string, LedgerEvent[]>();
  for (const e of events) {
    if (e.op === "comment" || e.op === "verify") continue;
    const list = byPage.get(e.page_id) ?? [];
    list.push(e);
    byPage.set(e.page_id, list);
  }
  const out: Touched[] = [];
  for (const evs of byPage.values()) {
    const last = evs[evs.length - 1] as LedgerEvent;
    const created = evs.some((e) => (e.op === "put" || e.op === "import") && e.prev_hash === null);
    const counted = evs.map((e) => asWords(e.meta?.words)).filter((w) => w !== null);
    const first = counted[0];
    const words: Words | null =
      counted.length === 0
        ? null
        : {
            added: counted.reduce((n, w) => n + w.added, 0),
            removed: counted.reduce((n, w) => n + w.removed, 0),
            ...(first?.before !== undefined ? { before: first.before } : {}),
          };
    const moved = evs.find((e) => e.op === "move");
    const what: What =
      last.op === "delete" || (last.op === "revert" && last.hash === null)
        ? "deleted"
        : created
          ? "added"
          : evs.some((e) => e.op === "revert")
            ? "reverted"
            : evs.some((e) => e.op === "put" || e.op === "import")
              ? rewrote(words)
                ? "rewrote"
                : "edited"
              : "moved";
    const from = typeof moved?.meta?.from_path === "string" ? moved.meta.from_path : null;
    out.push({
      page: last.page_id,
      path: last.path,
      title: titleOf(last.path),
      what,
      words: what === "edited" || what === "rewrote" || what === "reverted" ? words : null,
      from: what === "moved" ? from : null,
      seq: last.seq,
    });
  }
  return out;
}

/** Whether a request was made by a person in the app (not by one of their agents). */
export const byPerson = (r: Pick<LedgerRequest, "actor" | "by">) =>
  r.actor.startsWith("human:") && !r.by?.agent;

/** "You and 2 agents", "You, 1 other person and 3 agents", "2 people". */
export function whoWorksHere(you: boolean, people: number, agents: number): string {
  const parts: string[] = [];
  if (you) parts.push("You");
  if (people > 0)
    parts.push(
      you
        ? `${people} other ${people === 1 ? "person" : "people"}`
        : `${people} ${people === 1 ? "person" : "people"}`,
    );
  if (agents > 0) parts.push(plural(agents, "agent"));
  if (parts.length === 0) return "Nobody yet";
  const last = parts.pop() as string;
  return parts.length > 0 ? `${parts.join(", ")} and ${last}` : last;
}

// ---------------------------------------------------------------- by page

/** How many pages one request may change and still be told page by page; past it, one row. */
export const BULK_PAGES = 3;

/** How many of a bulk row's pages are named before "and n more". */
export const BULK_LISTED = 2;

/** What happened to a page, as its row's line says it. */
export type Did = What | "commented" | "replied" | "resolved" | "reopened" | "checked";

/**
 * One kind of change one person (or agent) made to a page in a day, however many times: "Edited
 * twice by Claude Code for @dev, +252 −42 words · “note”".
 */
export interface Doing {
  actor: string;
  by: ActedBy | null;
  did: Did;
  /** How many requests did it. */
  times: number;
  /** Words added and removed, over all of them. */
  words: Words | null;
  /** The newest note (a change) or comment (a comment), on one line. */
  quote: string | null;
  /** Its newest event. */
  seq: number;
}

/** A page's changes in one day: one row, the title over a line of who did what. */
export interface PageRow {
  kind: "page";
  key: string;
  /** Its newest path; "" for the library itself (a library thread, TEMPRA-222). */
  path: string;
  title: string;
  /** Its newest event (a deleted page is shown as it was just before). */
  seq: number;
  gone: boolean;
  /** Newest first. */
  doings: Doing[];
}

/** One request that changed more than BULK_PAGES pages (an import, a folder moved): one row. */
export interface BulkRow {
  kind: "bulk";
  key: string;
  actor: string;
  by: ActedBy | null;
  /** What it did to all of them, or "changed" when it did several things. */
  what: What | "changed";
  imported: boolean;
  count: number;
  unit: "page" | "file";
  /** Their folder by name, "4 folders", or null when some are at the top. */
  where: string | null;
  /** The first few, to link. */
  pages: { path: string; title: string; seq: number; gone: boolean }[];
  quote: string | null;
}

export type DayRow = PageRow | BulkRow;

/** One day's rows under its heading. */
export interface ActivityDay {
  label: string;
  rows: DayRow[];
}

const oneQuote = (s: string | null | undefined, max = 160): string | null => {
  const t = s?.replace(/\s+/g, " ").trim();
  if (!t) return null;
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
};

const COMMENT_DID: Record<string, Did> = {
  open: "commented",
  reply: "replied",
  resolve: "resolved",
  reopen: "reopened",
};

function addWords(a: Words | null, b: Words | null): Words | null {
  if (!a) return b;
  if (!b) return a;
  return { added: a.added + b.added, removed: a.removed + b.removed };
}

/** Where a bulk row's pages are: their one folder's name, "n folders", or null. */
function whereOf(paths: string[]): string | null {
  const dirs = [...new Set(paths.map(dirOf))];
  if (dirs.includes("")) return null;
  if (dirs.length === 1) return folderName(dirs[0] as string);
  return `${dirs.length} folders`;
}

const BY_NAME = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });

/** Folders in the tree's order: a folder, then what is inside it, then its next sibling. */
function byFolder(a: string, b: string): number {
  const x = a.split("/");
  const y = b.split("/");
  for (let i = 0; i < Math.min(x.length, y.length); i++) {
    const c = BY_NAME.compare(x[i] as string, y[i] as string);
    if (c !== 0) return c;
  }
  return x.length - y.length;
}

/**
 * The folder filter's choices: All folders, then every folder in the library's index in path
 * order, by readable name ("App / Reader"); the folder in the URL too when the index lacks it.
 */
export function folderOptions(
  index: Pick<OutlineFile, "path" | "kind">[],
  current: string,
): { value: string; label: string }[] {
  const dirs = new Set<string>();
  for (const f of index) {
    if (f.kind === "dir") dirs.add(f.path);
    for (let d = dirOf(f.path); d !== ""; d = dirOf(d)) dirs.add(d);
  }
  const now = current.replace(/\/+$/, "");
  if (now) dirs.add(now);
  return [
    { value: "", label: "All folders" },
    ...[...dirs]
      .sort(byFolder)
      .map((d) => ({ value: d, label: d.split("/").map(folderName).join(" / ") })),
  ];
}

/** Whether a path is in a folder or is it; with no folder, everything is. */
export function inFolder(prefix: string, path: string | null | undefined): boolean {
  const dir = prefix.replace(/\/+$/, "");
  if (!dir) return true;
  return !!path && (path === dir || path.startsWith(`${dir}/`));
}

/**
 * Activity by page (Option B, TEMPRA-308): requests (newest first, as the API pages them) as
 * days, newest first, each a row per page changed that day, ordered by its newest change, with
 * each person's each kind of change once ("Edited twice by …"). A request that changed more than
 * BULK_PAGES pages is a row of its own. `who` keeps only agents' or only people's requests.
 */
export function byPage(
  requests: LedgerRequest[],
  titleOf: TitleOf,
  now: number,
  who: Who = "everyone",
): ActivityDay[] {
  const days: ActivityDay[] = [];
  const rows = new Map<string, PageRow>();
  const ids = new Set<string>();
  for (const r of requests) {
    if (ids.has(r.request_id)) continue;
    ids.add(r.request_id);
    if (who === "people" && !byPerson(r)) continue;
    if (who === "agents" && byPerson(r)) continue;
    const last = r.events[r.events.length - 1];
    if (!last) continue;
    const label = dayLabel(last.ts, now);
    let found = days.find((d) => d.label === label);
    if (!found) {
      found = { label, rows: [] };
      days.push(found);
    }
    const day = found;
    const by = r.by ?? null;
    const add = (
      e: Pick<LedgerEvent, "page_id" | "path" | "seq">,
      did: Did,
      words: Words | null,
      quote: string | null,
      gone = false,
    ) => {
      const key = `${label} ${e.page_id || e.path}`;
      let row = rows.get(key);
      if (!row) {
        row = {
          kind: "page",
          key,
          path: e.path,
          title: e.path ? titleOf(e.path) : "The library",
          seq: e.seq,
          gone,
          doings: [],
        };
        rows.set(key, row);
        day.rows.push(row);
      }
      const same = row.doings.find(
        (d) =>
          d.did === did && d.actor === r.actor && (d.by?.person ?? null) === (by?.person ?? null),
      );
      if (same) {
        same.times++;
        same.words = addWords(same.words, words);
        same.quote ??= quote;
      } else {
        row.doings.push({ actor: r.actor, by, did, times: 1, words, quote, seq: e.seq });
      }
    };

    const note = oneQuote(r.note);
    const content = r.events.filter((e) => e.op !== "comment" && e.op !== "verify");
    const touched = touchedBy(content, titleOf);
    if (touched.length > BULK_PAGES) {
      const whats = [...new Set(touched.map((t) => t.what))];
      day.rows.push({
        kind: "bulk",
        key: r.request_id,
        actor: r.actor,
        by,
        what: whats.length === 1 ? (whats[0] as What) : "changed",
        imported: content.every((e) => e.op === "import"),
        count: touched.length,
        unit: touched.every((t) => isPage(t.path)) ? "page" : "file",
        where: whereOf(touched.map((t) => t.path)),
        pages: touched.slice(0, BULK_LISTED).map((t) => ({
          path: t.path,
          title: t.title,
          seq: t.seq,
          gone: t.what === "deleted",
        })),
        quote: note,
      });
    } else {
      for (const t of touched) {
        const e = { page_id: t.page, path: t.path, seq: t.seq };
        add(e, t.what, t.words, note, t.what === "deleted");
      }
    }
    // Comments and checks, newest first, so a row quotes the newest comment.
    for (const e of [...r.events].reverse()) {
      if (e.op === "comment") {
        const c = e.meta?.comment as { kind?: string; body?: unknown } | undefined;
        const body = typeof c?.body === "string" ? c.body : null;
        add(e, COMMENT_DID[c?.kind ?? "reply"] ?? "replied", null, oneQuote(body));
      } else if (e.op === "verify") {
        add(e, "checked", null, null);
      }
    }
  }
  return days.filter((d) => d.rows.length > 0);
}

/** " twice", " 3 times", or nothing for once. */
const timesText = (n: number) => (n <= 1 ? "" : n === 2 ? " twice" : ` ${n} times`);

/** A change as the line says it before the name ("edited twice by "). */
const PAST: Record<What | "changed", string> = {
  added: "added",
  edited: "edited",
  rewrote: "rewritten",
  moved: "moved",
  deleted: "deleted",
  reverted: "reverted",
  changed: "changed",
};

const capital = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/**
 * A doing as the words around its person's name: a change says the name after it ("Edited twice
 * by " … ", +38 −12 words · “note”"), a comment before it (… " commented: “Why?”"). `first` is
 * whether it starts the line (a later one is lowercase after " · "). People read "checked",
 * never "verified" (TEMPRA-295).
 */
export function doingText(d: Doing, first: boolean): { before: string; after: string } {
  const quote = d.quote ? `“${d.quote}”` : "";
  switch (d.did) {
    case "commented":
    case "replied":
      return { before: "", after: ` ${d.did}${timesText(d.times)}${quote ? `: ${quote}` : ""}` };
    case "resolved":
    case "reopened": {
      const threads = d.times === 1 ? "a thread" : `${d.times} threads`;
      return { before: "", after: ` ${d.did} ${threads}` };
    }
    case "checked": {
      const verb = `checked${timesText(d.times)} by `;
      return { before: first ? capital(verb) : verb, after: "" };
    }
    default: {
      const verb = `${PAST[d.did]}${timesText(d.times)} by `;
      const words = wordsText(d.words);
      return {
        before: first ? capital(verb) : verb,
        after: `${words ? `, ${words}` : ""}${quote ? ` · ${quote}` : ""}`,
      };
    }
  }
}

/** A bulk row's title: "11 new pages", "4 pages moved", "5 files changed". */
export function bulkTitle(b: Pick<BulkRow, "what" | "count" | "unit">): string {
  if (b.what === "added") return `${b.count} new ${b.count === 1 ? b.unit : `${b.unit}s`}`;
  return `${plural(b.count, b.unit)} ${PAST[b.what]}`;
}

/** A bulk row's words before its person's name: "Imported by ", "Moved by ". */
export const bulkVerb = (b: Pick<BulkRow, "what" | "imported">) =>
  `${b.imported ? "Imported" : capital(PAST[b.what])} by `;

/**
 * Working now (Option B): the agents writing now, newest first, one each; none for People, and
 * only writes in the folder filter.
 */
export function workingNow(
  writes: Iterable<LiveWrite>,
  now: number,
  f: { who?: Who; prefix?: string } = {},
): LiveWrite[] {
  if (f.who === "people") return [];
  return [...writes]
    .filter((w) => isLive(w, now) && inFolder(f.prefix ?? "", w.path))
    .sort((a, b) => b.at - a.at);
}

/** One writer: an actor for one person. */
export const writerKey = (w: Pick<LiveWrite, "actor" | "by">) => `${w.actor} ${w.by?.person ?? ""}`;

/**
 * The writers after a batch of feed events heard at `at`: each agent's newest change (not a
 * comment or a delete, `isAgentChange`) replaces its last.
 */
export function heardWrites(
  writes: ReadonlyMap<string, LiveWrite>,
  events: FeedEvent[],
  at: number,
): Map<string, LiveWrite> {
  const next = new Map(writes);
  for (const e of events) {
    if (!isAgentChange(e)) continue;
    const w = { actor: e.actor, by: e.by ?? null, path: e.path, seq: e.seq, at };
    next.set(writerKey(w), w);
  }
  return next;
}

// ---------------------------------------------------------------- every event

/**
 * Every event (take 4, TEMPRA-115): the ledger as a table, one row per event, newest first. The
 * rows come from the same `GET …/requests` pages as the Summary, so each carries its request's
 * note, who acted and whether a person or an agent did.
 */

/** The kinds the table names, in the order the "Any kind" filter lists them. */
export const KINDS = [
  "write",
  "edit",
  "move",
  "delete",
  "comment",
  "verify",
  "revert",
  "import",
] as const;

/** An event's kind as the table names it: a new page is a write, a new version an edit. */
export function kindOf(e: Pick<LedgerEvent, "op" | "prev_hash">): string {
  if (e.op === "put") return e.prev_hash === null ? "write" : "edit";
  return e.op;
}

/** One row of Every event. */
export interface EventRow {
  event: LedgerEvent;
  request: LedgerRequest;
  kind: string;
  /** What the row says beside the path: a comment's words, where a move came from, the note. */
  note: string;
  /** The first row of its request shown: the one that names who and when. */
  lead: boolean;
}

const oneLine = (s: string, max = 140) => {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
};

/** What an event's row says beside its path. */
export function eventNote(e: LedgerEvent, r: Pick<LedgerRequest, "note">): string {
  if (e.op === "comment") {
    const c = e.meta?.comment as { kind?: string; body?: unknown } | undefined;
    if (typeof c?.body === "string" && c.body.trim()) return oneLine(c.body);
    if (c?.kind === "resolve") return "Resolved a thread";
    if (c?.kind === "reopen") return "Reopened a thread";
  }
  if (e.op === "move" && typeof e.meta?.from_path === "string") {
    const from = e.meta.from_path;
    return r.note?.trim() ? oneLine(r.note) : `From ${from}`;
  }
  return r.note?.trim() ? oneLine(r.note) : "";
}

/** The filters Every event applies in the app (who and the folder go to the server). */
interface EventFilter {
  who?: "everyone" | "agents" | "people";
  kind?: string;
  /** Text to find in the path or the note, case aside. */
  q?: string;
}

/**
 * Requests (newest first, as the API pages them) as table rows, newest event first, filtered.
 * A request is listed once even when two pages both carry it.
 */
export function eventRows(requests: LedgerRequest[], f: EventFilter = {}): EventRow[] {
  const q = f.q?.trim().toLowerCase() ?? "";
  const ids = new Set<string>();
  const rows: EventRow[] = [];
  for (const r of requests) {
    if (ids.has(r.request_id)) continue;
    ids.add(r.request_id);
    if (f.who === "people" && !byPerson(r)) continue;
    if (f.who === "agents" && byPerson(r)) continue;
    let lead = true;
    for (const e of [...r.events].reverse()) {
      const kind = kindOf(e);
      if (f.kind && kind !== f.kind) continue;
      const note = eventNote(e, r);
      if (q && !e.path.toLowerCase().includes(q) && !note.toLowerCase().includes(q)) continue;
      rows.push({ event: e, request: r, kind, note, lead });
      lead = false;
    }
  }
  return rows;
}

/** How long after an agent's last write it still reads as writing now (the pulsing dot). */
export const LIVE_MS = 60_000;

/** An agent's write seen arriving on the change feed. */
export interface LiveWrite {
  actor: string;
  by: ActedBy | null;
  path: string;
  seq: number;
  /** When it arrived (this browser's clock). */
  at: number;
}

/** Whether an agent's write arrived recently enough to read as writing now. */
export const isLive = (w: Pick<LiveWrite, "at"> | null | undefined, now: number) =>
  !!w && now - w.at < LIVE_MS;

// ---------------------------------------------------------------- days

/** "Today", "Yesterday", or the date (`day`): the heading of a day's rows (local time). */
export function dayLabel(ts: string, now: number): string {
  const d = new Date(ts).toDateString();
  const yesterday = new Date(now);
  yesterday.setDate(yesterday.getDate() - 1);
  if (d === new Date(now).toDateString()) return "Today";
  if (d === yesterday.toDateString()) return "Yesterday";
  return day(ts);
}

/** Requests per page of Activity, as the ledger pages them. */
export const REQUESTS_PAGE = 30;

/** A page of `GET …/requests`: newest first, and where the next (older) page starts. */
export interface RequestPage {
  requests: LedgerRequest[];
  next: number | null;
}

/** The cache key of Activity's newest page under its filters (see useLoad). */
export const activityKey = (urls: Urls, filters: ActivityFilters) =>
  `activity ${urls.base} ${filters.prefix ?? ""} ${filters.actor ?? ""}`;

/** What Activity loads first: the head, then the newest page of requests its filters match. */
export async function loadActivity(urls: Urls, filters: ActivityFilters) {
  // The head first: the feed then replays anything that lands while the page loads.
  const { seq } = await api<{ seq: number }>(urls.api("stats"));
  const page = await api<RequestPage>(
    urls.api("requests", {
      prefix: filters.prefix || undefined,
      actor: filters.actor || undefined,
      limit: REQUESTS_PAGE,
    }),
  );
  return { ...page, head: seq };
}

registerPage("activity", (route, urls) => ({
  key: activityKey(urls, route.filters),
  load: () => loadActivity(urls, route.filters),
}));
