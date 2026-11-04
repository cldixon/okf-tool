/**
 * Read history (TEMPRA-220, tempra-dev: v2/read-history): how often a page is read and how
 * recently, by surface and by agent or person, never by whom. Counted in memory and flushed in
 * batches as TEMPRA-87 counts reads (store.ts), so a read never writes. Free of Worker APIs.
 */
import { sha256Hex } from "../format/hash";

/** Where a read came from: MCP, the app (a person's session), or the REST API with a token. */
export type ReadSurface = "mcp" | "app" | "api";
export const READ_SURFACES: readonly ReadSurface[] = ["mcp", "app", "api"];

/** Who reads: an agent, or a person (a `human:` actor, a session). */
export type ReaderKind = "agent" | "person";

/**
 * The reader behind a library call, as the Worker says (feed.ts `readingOf`). `reader` is a
 * hashed key (`readerKey`) for counting a reader once a day and distinct readers; it is stored
 * and never shown. `person` is the hashed key of the person an agent acts for, so a page an agent
 * shows the person (MCP `show`) counts as the person's read.
 */
export interface Reading {
  surface: ReadSurface;
  kind: ReaderKind;
  reader: string;
  person?: string;
}

/**
 * A reader's stored key: a SHA-256 of who it is (`a:<agent>` or `p:<person>`), so the read log
 * keeps no raw person or actor id. Synchronous (format/hash.ts, not WebCrypto).
 */
export function readerKey(who: string): string {
  return sha256Hex(`tempra-reader:${who}`).slice(0, 32);
}

/** Reads over one window: in all, by agents and people, by surface, and how many readers. */
export interface ReadCounts {
  /**
   * Reads, each reader counted once per page and day (a person opening it again that day, or an
   * agent reading it again, adds nothing); those from before TEMPRA-220, with no reader, as
   * they were counted.
   */
  total: number;
  agents: number;
  people: number;
  mcp: number;
  app: number;
  api: number;
  /** Distinct readers, a count only. */
  readers: number;
}

/** A page's read history: the last 7 and 30 days, and the last read on each surface. */
export interface ReadHistory {
  week: ReadCounts;
  month: ReadCounts;
  last: Record<ReadSurface, string | null>;
  /** The latest of `last`. */
  last_read: string | null;
}

/** The short window, in days, today included. */
export const READ_WEEK_DAYS = 7;

/** One row of counts: a day, a surface, a kind and a reader ('' for reads from before). */
export interface ReadRow {
  day: string;
  surface: string;
  kind: string;
  reader: string;
  reads: number;
}

const empty = (): ReadCounts => ({
  total: 0,
  agents: 0,
  people: 0,
  mcp: 0,
  app: 0,
  api: 0,
  readers: 0,
});

/**
 * Counts rows from `start` (a YYYY-MM-DD day) on, each reader once per day: in all, by kind and
 * on each surface it read on that day (so the surfaces can add up to more than the total when a
 * reader used two). Rows with no reader (from before TEMPRA-220) count in the total only.
 */
export function tallyReads(rows: ReadRow[], start: string): ReadCounts {
  const out = empty();
  const days = new Set<string>();
  const onSurface = new Set<string>();
  const readers = new Set<string>();
  for (const r of rows) {
    if (r.day < start || r.reads <= 0) continue;
    if (!r.reader) {
      out.total += r.reads;
      continue;
    }
    const who = `${r.kind}|${r.reader}`;
    readers.add(who);
    const day = `${r.day}|${who}`;
    if (!days.has(day)) {
      days.add(day);
      out.total++;
      if (r.kind === "agent") out.agents++;
      else if (r.kind === "person") out.people++;
    }
    if (r.surface === "mcp" || r.surface === "app" || r.surface === "api") {
      const key = `${r.surface}|${day}`;
      if (!onSurface.has(key)) {
        onSurface.add(key);
        out[r.surface]++;
      }
    }
  }
  out.readers = readers.size;
  return out;
}

/** The read history from its rows and the last read per surface. */
export function readHistory(
  rows: ReadRow[],
  last: Partial<Record<string, string>>,
  starts: { week: string; month: string },
): ReadHistory {
  const lasts = {
    mcp: last.mcp ?? null,
    app: last.app ?? null,
    api: last.api ?? null,
  };
  const latest =
    Object.values(lasts)
      .filter((t): t is string => t !== null)
      .sort()
      .at(-1) ?? null;
  return {
    week: tallyReads(rows, starts.week),
    month: tallyReads(rows, starts.month),
    last: lasts,
    last_read: latest,
  };
}

/** A moment as an agent reads it: "just now", "5 min ago", "2 hours ago", "3 days ago", a date. */
export function agoText(iso: string, now: number): string {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return iso;
  const secs = Math.max(0, Math.round((now - t) / 1000));
  if (secs < 60) return "just now";
  if (secs < 3600) return `${Math.floor(secs / 60)} min ago`;
  if (secs < 86_400) {
    const h = Math.floor(secs / 3600);
    return `${h} hour${h === 1 ? "" : "s"} ago`;
  }
  const d = Math.floor(secs / 86_400);
  if (d === 1) return "yesterday";
  if (d < 30) return `${d} days ago`;
  return iso.slice(0, 10);
}

/**
 * The `reads:` line MCP `read` shows (TEMPRA-220), e.g. `reads: 12 in 7 days (9 by agents, 3 by
 * people · mcp 9, app 3), 40 in 30 days by 5 readers; last read 2 hours ago (mcp), yesterday
 * (app)`.
 */
export function readsText(h: ReadHistory, now: number): string {
  const split = (c: ReadCounts) => {
    const who = [
      c.agents > 0 ? `${c.agents} by agents` : "",
      c.people > 0 ? `${c.people} by people` : "",
    ].filter(Boolean);
    const where = READ_SURFACES.filter((s) => c[s] > 0).map((s) => `${s} ${c[s]}`);
    const parts = [who.join(", "), where.join(", ")].filter(Boolean);
    return parts.length > 0 ? ` (${parts.join(" · ")})` : "";
  };
  const counts = `${h.week.total} in ${READ_WEEK_DAYS} days${split(h.week)}, ${h.month.total} in 30 days${
    h.month.readers > 0 ? ` by ${h.month.readers} reader${h.month.readers === 1 ? "" : "s"}` : ""
  }`;
  const lasts = READ_SURFACES.flatMap((s) => {
    const t = h.last[s];
    return t ? [{ s, t }] : [];
  })
    // Newest first; a tie keeps the surfaces' order (mcp, app, api).
    .sort((a, b) => (a.t === b.t ? 0 : a.t < b.t ? 1 : -1))
    .map(({ s, t }) => `${agoText(t, now)} (${s})`);
  return `reads: ${counts}; ${lasts.length > 0 ? `last read ${lasts.join(", ")}` : "no last read recorded"}`;
}
