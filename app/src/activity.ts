import type { ActedBy } from "./agents";
import { api } from "./api";
import { registerPage } from "./prefetch";
import { day, plural, relativeTime } from "./ui";
import type { ActivityFilters, Urls } from "./urls";

/*
 * Activity (take 4, TEMPRA-115; tempra-dev: app/activity): what happened, for people. One entry per
 * request, told as a sentence of what it did ("Claude Code changed 3 pages in The app"), with
 * its note and the pages it touched. The Activity page draws them grouped by day
 * (EntryRow.svelte, LiveEntry.svelte); the hooks are in activity.svelte.ts.
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
  path: string;
  title: string;
  what: What;
  words: Words | null;
  /** Where a moved file was before. */
  from: string | null;
  /** The last event's sequence (a deleted file is shown as it was just before). */
  seq: number;
}

/** A piece of an entry's sentence: words, a page to link, or a folder to link. */
export type Part =
  | string
  | { page: string; title: string; seq: number; gone: boolean; words: Words | null }
  | { folder: string };

/** One request as Activity tells it. */
export interface Entry {
  id: string;
  /** When it ended (its last event). */
  ts: string;
  actor: string;
  by: ActedBy | null;
  /** Its first and last sequence. */
  first: number;
  last: number;
  /** What it did, after the person's name. */
  parts: Part[];
  /** The request's note, or what a comment said, quoted under the sentence. */
  quote: string | null;
  /** Content it changed, in order (not comments or verifications). */
  touched: Touched[];
  /** The sentence names every change itself, so a list beneath would only repeat it. */
  named: boolean;
}

/** A page's title by its path (`useTitleOf().of`: the outline's title, else its file name). */
type TitleOf = (path: string) => string;

/** "+38 −12 words", or null when nothing changed. */
export function wordsText(w: Words | null): string | null {
  if (!w || (w.added === 0 && w.removed === 0)) return null;
  return `+${w.added} −${w.removed} words`;
}

/** Joins clauses as a person writes a list: "a", "a and b", "a, b and c". */
function joinParts(clauses: Part[][]): Part[] {
  const out: Part[] = [];
  clauses.forEach((c, i) => {
    if (i > 0) out.push(i === clauses.length - 1 ? " and " : ", ");
    out.push(...c);
  });
  return out;
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

const pagePart = (t: Touched, withWords: boolean): Part => ({
  page: t.path,
  title: t.title,
  seq: t.seq,
  gone: t.what === "deleted",
  words: withWords ? t.words : null,
});

/** " in The app and Decisions", " across 4 folders", or nothing when some are at the top. */
function wherePart(paths: string[]): Part[] {
  const dirs: string[] = [];
  for (const p of paths) {
    const i = p.indexOf("/");
    if (i === -1) return [];
    const d = p.slice(0, i);
    if (!dirs.includes(d)) dirs.push(d);
  }
  if (dirs.length === 0) return [];
  if (dirs.length > 2) return [` across ${dirs.length} folders`];
  return [" in ", ...joinParts(dirs.map((d) => [{ folder: d }]))];
}

/** The content clause: "rewrote A and added B", or "changed 3 pages in The app". */
function contentClauses(touched: Touched[], imported: boolean): Part[][] {
  if (touched.length === 0) return [];
  const unit = touched.every((t) => isPage(t.path)) ? "page" : "file";
  const verbs = [...new Set(touched.map((t) => t.what))];
  if (imported) {
    return [[`imported ${plural(touched.length, unit)}`, ...wherePart(touched.map((t) => t.path))]];
  }
  if (touched.length > 2) {
    const verb = verbs.length === 1 ? verbs[0] : "changed";
    return [[`${verb} ${plural(touched.length, unit)}`, ...wherePart(touched.map((t) => t.path))]];
  }
  return verbs.map((verb) => [
    `${verb} `,
    ...joinParts(touched.filter((t) => t.what === verb).map((t) => [pagePart(t, true)])),
  ]);
}

/** The comment clauses: "replied on Reader and resolved it", "opened a thread on Tenancy". */
function commentClauses(events: LedgerEvent[], titleOf: TitleOf): Part[][] {
  const threads = new Map<string, { path: string; seq: number; kinds: string[] }>();
  for (const e of events) {
    if (e.op !== "comment") continue;
    const c = e.meta?.comment as { kind?: string; thread?: string } | undefined;
    const id = c?.thread ?? String(e.seq);
    const t = threads.get(id) ?? { path: e.path, seq: e.seq, kinds: [] };
    t.kinds.push(c?.kind ?? "reply");
    threads.set(id, t);
  }
  if (threads.size === 0) return [];
  // A library thread (TEMPRA-222) is on no page.
  const on = (t: { path: string; seq: number }): Part =>
    t.path
      ? { page: t.path, title: titleOf(t.path), seq: t.seq, gone: false, words: null }
      : "the library";
  const list = [...threads.values()];
  if (list.length > 2) {
    const paths = [...new Set(list.map((t) => t.path))];
    const first = list[0] as (typeof list)[number];
    return paths.length === 1
      ? [[`commented ${list.length} times on `, on(first)]]
      : [[`commented on ${plural(paths.length, "page")}`]];
  }
  return list.map((t) => {
    const k = new Set(t.kinds);
    if (k.has("open")) return ["opened a thread on ", on(t)];
    if (k.has("reply") && k.has("resolve")) return ["replied on ", on(t), " and resolved it"];
    if (k.has("reply")) return ["replied on ", on(t)];
    if (k.has("resolve")) return ["resolved a thread on ", on(t)];
    return ["reopened a thread on ", on(t)];
  });
}

/** The verification clause: "verified A", "verified A and B", "verified A and 2 more". */
function verifyClauses(events: LedgerEvent[], titleOf: TitleOf): Part[][] {
  const seen = new Map<string, LedgerEvent>();
  for (const e of events) if (e.op === "verify") seen.set(e.path, e);
  if (seen.size === 0) return [];
  const items: Part[][] = [...seen.values()].map((e) => [
    { page: e.path, title: titleOf(e.path), seq: e.seq, gone: false, words: null },
  ]);
  if (items.length > 2)
    return [["verified ", ...(items[0] ?? []), ` and ${items.length - 1} more`]];
  return [["verified ", ...joinParts(items)]];
}

/** The first thing a comment in the request said, on one line and kept short. */
function commentQuote(events: LedgerEvent[]): string | null {
  for (const e of events) {
    const body = (e.meta?.comment as { body?: unknown } | undefined)?.body;
    if (e.op === "comment" && typeof body === "string" && body.trim()) {
      const said = body.replace(/\s+/g, " ").trim();
      return said.length > 160 ? `${said.slice(0, 159)}…` : said;
    }
  }
  return null;
}

/**
 * A request as an Activity entry, or null when nothing of it is left to show (`hideComments`
 * drops comment events, so a request that only commented goes).
 */
export function toEntry(
  r: LedgerRequest,
  titleOf: TitleOf,
  opts: { hideComments?: boolean } = {},
): Entry | null {
  const events = opts.hideComments ? r.events.filter((e) => e.op !== "comment") : r.events;
  const first = events[0];
  const last = events[events.length - 1];
  if (!first || !last) return null;
  const touched = touchedBy(events, titleOf);
  const imported = events.every((e) => e.op === "import");
  const clauses = [
    ...contentClauses(touched, imported),
    ...commentClauses(events, titleOf),
    ...verifyClauses(events, titleOf),
  ];
  return {
    id: r.request_id,
    ts: last.ts,
    actor: r.actor,
    by: r.by ?? null,
    first: first.seq,
    last: last.seq,
    parts: joinParts(clauses),
    quote: r.note?.trim() || commentQuote(events),
    touched,
    named: touched.length <= 2 && !imported,
  };
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

// ---------------------------------------------------------------- times

/** The time of day as `localTime` writes it ("4:52 PM"), in the reader's time zone. */
const CLOCK = new Intl.DateTimeFormat(undefined, { timeStyle: "short" });

/** "Today", "Yesterday", or the date (`day`): the heading of a day's entries (local time). */
export function dayLabel(ts: string, now: number): string {
  const d = new Date(ts).toDateString();
  const yesterday = new Date(now);
  yesterday.setDate(yesterday.getDate() - 1);
  if (d === new Date(now).toDateString()) return "Today";
  if (d === yesterday.toDateString()) return "Yesterday";
  return day(ts);
}

/** Entries in order, split into days, newest first as they come. */
export function groupByDay<T extends { ts: string }>(
  items: T[],
  now: number,
): { label: string; items: T[] }[] {
  const days: { label: string; items: T[] }[] = [];
  for (const item of items) {
    const label = dayLabel(item.ts, now);
    const last = days[days.length - 1];
    if (last?.label === label) last.items.push(item);
    else days.push({ label, items: [item] });
  }
  return days;
}

/**
 * When, beside an entry under its day's heading: "14 min ago" today (relativeTime), the time of
 * day on an earlier day.
 */
export function entryTime(ts: string, now: number): string {
  return dayLabel(ts, now) === "Today" ? relativeTime(ts, now) : CLOCK.format(new Date(ts));
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
