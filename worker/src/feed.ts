/**
 * The change feed (tempra-dev: app/live): every committed ledger event, pushed to the library's
 * open WebSockets, and agents' presence: what they read now (TEMPRA-219). Free of Worker APIs;
 * the Library DO holds the sockets (hibernation API) and calls these.
 */
import type { ActedBy } from "./agents";
import { normalizeDir, underPrefix } from "./format/paths";
import { type ReaderKind, type Reading, type ReadSurface, readerKey } from "./store/reads";
import type { EventRow } from "./store/store";

/** One event as the feed sends it. */
export interface FeedEvent {
  seq: number;
  ts: string;
  actor: string;
  request_id: string;
  op: string;
  path: string;
  page_id: string;
  hash: string | null;
  note: string | null;
  /** For a move: where the file was. */
  from_path: string | null;
  /** For a comment: what was done, to which thread. */
  comment: { kind: string; thread: string } | null;
  /** The person and agent behind the actor (TEMPRA-75), by id; null before they were kept. */
  by: ActedBy | null;
}

/**
 * What the feed sends: on connect, the head; after each write, its events; after an agent's
 * read, its presence (TEMPRA-219), which carries no head and moves no cursor.
 */
export type FeedMessage =
  | { type: "hello"; head: number }
  | { type: "events"; head: number; events: FeedEvent[] }
  | PresenceMessage;

/** An open feed socket and the path prefix it asked for ("" for the whole library). */
export interface FeedSocket {
  prefix: string;
  /** When it was accepted (ms since the epoch). */
  opened: number;
  send(message: string): void;
  close(code: number, reason: string): void;
}

/**
 * How long a socket may carry events before it must reconnect. The Worker authorizes a socket
 * once, at the upgrade; a revoked token, a suspension or a transfer is enforced again at the
 * next connect, so this bounds how long a lapsed caller can still see the library's events.
 */
export const FEED_MAX_AGE_MS = 10 * 60_000;

/** The close code that asks a client to reconnect (and be authorized again) at once. */
export const FEED_REAUTHORIZE = 4001;

/**
 * Open feed sockets one library holds at most (TEMPRA-80): each write's fan-out is O(sockets ×
 * events), and the app opens one socket per library per tab. Counted in the Library DO from
 * `getWebSockets()`, which hibernation keeps, never from memory.
 */
export const FEED_SOCKETS_PER_LIBRARY = 200;

/**
 * Open feed sockets one account holds at most, across every library it reaches (its person's
 * tabs and agents together). Counted by the account's AccountFeeds object (feed-leases.ts).
 */
export const FEED_SOCKETS_PER_ACCOUNT = 50;

/**
 * The close code for a feed connection refused over a cap: the socket opens and closes at once
 * with it, as a browser cannot read an HTTP refusal of a WebSocket. The client polls
 * `GET /events?since=` instead and tries the socket again later.
 */
export const FEED_FULL = 4029;

/** The DO's write methods: a call to one of these may add events. */
export const WRITE_METHODS = new Set(["apply", "import", "revert", "verify", "comment"]);

export function feedEvent(e: EventRow): FeedEvent {
  const meta = e.meta ?? {};
  return {
    seq: e.seq,
    ts: e.ts,
    actor: e.actor,
    request_id: e.request_id,
    op: e.op,
    path: e.path,
    page_id: e.page_id,
    hash: e.hash,
    note: typeof meta.note === "string" ? meta.note : null,
    from_path: typeof meta.from_path === "string" ? meta.from_path : null,
    comment: commentOf(meta.comment),
    by: byOf(meta.by),
  };
}

/** The `by` of an event's meta, if it has a well-formed one. */
export function byOf(v: unknown): ActedBy | null {
  if (!v || typeof v !== "object") return null;
  const b = v as { person?: unknown; agent?: unknown };
  if (typeof b.person !== "string") return null;
  return typeof b.agent === "string" ? { person: b.person, agent: b.agent } : { person: b.person };
}

function commentOf(v: unknown): FeedEvent["comment"] {
  if (!v || typeof v !== "object") return null;
  const c = v as { kind?: unknown; thread?: unknown };
  return typeof c.kind === "string" && typeof c.thread === "string"
    ? { kind: c.kind, thread: c.thread }
    : null;
}

/** The prefix a socket asked for, normalized the way the store normalizes directories. */
export function feedPrefix(raw: string | null | undefined): string {
  return normalizeDir(raw ?? "");
}

/** Whether an event concerns a prefix: its path, or for a move, where it came from. */
export function concerns(e: FeedEvent, prefix: string): boolean {
  return underPrefix(e.path, prefix) || (e.from_path !== null && underPrefix(e.from_path, prefix));
}

/**
 * Sends each socket the events under its prefix. A socket that fails to take a message is
 * skipped, and one older than FEED_MAX_AGE_MS is closed instead of sent to; either way the
 * client catches up from `GET /events?since=` when it reconnects, authorized afresh.
 */
export function broadcast(
  sockets: readonly FeedSocket[],
  head: number,
  events: FeedEvent[],
  now = Date.now(),
) {
  let sent = 0;
  for (const s of sockets) {
    const mine = events.filter((e) => concerns(e, s.prefix));
    if (mine.length === 0) continue;
    if (now - s.opened > FEED_MAX_AGE_MS) {
      try {
        s.close(FEED_REAUTHORIZE, "reconnect");
      } catch {
        // Already closed.
      }
      continue;
    }
    const message: FeedMessage = { type: "events", head, events: mine };
    try {
      s.send(JSON.stringify(message));
      sent++;
    } catch {
      // Closed or closing: nothing to do.
    }
  }
  return sent;
}

// ---------------------------------------------------------------- presence (TEMPRA-219)

/**
 * What an agent is doing to a file now: reading it (`read`, `GET …/files`, `GET …/page`) or
 * writing it. Reading is a presence message; writing needs none, since its events are on the
 * feed already and the app marks the files an agent's events name. A search marks nothing (the
 * product owner's call on TEMPRA-219): a page it found shows only once the agent reads it.
 */
export type PresenceKind = "reading" | "writing";

/**
 * Who makes a library call: the actor and, when known, its person and agent (presence,
 * TEMPRA-219); where the call came from and whether the reader is an agent or a person (read
 * history, TEMPRA-220). Every call a token or a session makes carries one; the Worker's own calls
 * (downloads by a signed link, maintenance) carry none.
 */
export interface Caller {
  actor: string;
  by: ActedBy | null;
  surface: ReadSurface;
  reader: ReaderKind;
}

/**
 * A presence message: one agent, what it is doing, the files it read in one call. Nothing of it
 * is stored, and a socket that misses one misses nothing it needs: the mark fades in seconds.
 * `replying` (TEMPRA-222) is the library's managed agent working on a reply in `thread`, whose
 * page is `paths[0]` ("" for a library thread); sent again while the turn runs, it fades unless
 * renewed, and the reply landing on the feed clears it.
 */
export type PresenceMessage =
  | {
      type: "presence";
      kind: "reading";
      actor: string;
      by: ActedBy | null;
      paths: string[];
    }
  | {
      type: "presence";
      kind: "replying";
      actor: string;
      by: ActedBy | null;
      paths: string[];
      thread: string;
    };

/** Whether an actor is a person (`human:<handle>`): people's reads are never presence. */
export const isPersonActor = (actor: string) => actor.startsWith("human:");

/**
 * The caller behind a token (a session's included): an agent, or a person (`human:` actors and
 * the app's sessions), on `surface`: MCP when the /mcp route says so, else the app for a session
 * and the REST API for a bearer token.
 */
export function callerOf(
  t: { id?: string; actor: string; created_by?: string | null; agent?: string },
  surface?: ReadSurface,
): Caller {
  const by: ActedBy | null = t.created_by
    ? t.agent
      ? { person: t.created_by, agent: t.agent }
      : { person: t.created_by }
    : null;
  return {
    actor: t.actor,
    by,
    surface: surface ?? (t.id?.startsWith("session:") ? "app" : "api"),
    reader: isPersonActor(t.actor) ? "person" : "agent",
  };
}

/**
 * The reader a call counts its reads as (TEMPRA-220): its surface and kind, a key for the reader
 * (the agent, else the person, else the actor) and for the person it acts for, both hashed
 * (`readerKey`): stored, never shown, and no raw id in the read log.
 */
export function readingOf(c: Caller): Reading {
  const person = c.by?.person ? readerKey(`p:${c.by.person}`) : undefined;
  const reader =
    c.reader === "agent"
      ? readerKey(`a:${c.by?.agent ?? c.actor}`)
      : (person ?? readerKey(`p:${c.actor}`));
  return { surface: c.surface, kind: c.reader, reader, ...(person ? { person } : {}) };
}

/** The least time between two presence messages for one agent and file. */
export const PRESENCE_THROTTLE_MS = 3000;

/**
 * The file a read method's result names: a read file (a page or an attachment; not the
 * library's generated index or log, which are no row in the tree) or a page's file. Any other
 * method, `search` included, names none.
 */
export function presencePaths(method: string, value: unknown): string[] {
  if (!value || typeof value !== "object") return [];
  const fileOf = (v: unknown) => {
    const f = v as { kind?: unknown; path?: unknown } | null;
    return f && (f.kind === "page" || f.kind === "attachment") && typeof f.path === "string"
      ? [f.path]
      : [];
  };
  if (method === "read") return fileOf(value);
  if (method === "page") return fileOf((value as { file?: unknown }).file);
  return [];
}

/**
 * Presence for one library, kept in its Durable Object's memory (nothing is stored): from a read
 * call's caller and result, the message to send, throttled per agent and file, or null.
 * Hibernation forgets the throttle, which only lets one message through sooner.
 */
export class Presence {
  /** Per agent and file, when its last message went. */
  private last = new Map<string, number>();

  constructor(private readonly throttleMs = PRESENCE_THROTTLE_MS) {}

  message(
    caller: Caller | null | undefined,
    method: string,
    value: unknown,
    now = Date.now(),
  ): PresenceMessage | null {
    if (!caller || caller.reader === "person" || isPersonActor(caller.actor)) return null;
    const paths = presencePaths(method, value).filter((p) => {
      const key = `${caller.actor}|${p}`;
      const at = this.last.get(key);
      if (at !== undefined && now - at < this.throttleMs) return false;
      this.last.set(key, now);
      return true;
    });
    if (this.last.size > 2000) this.prune(now);
    if (paths.length === 0) return null;
    return { type: "presence", kind: "reading", actor: caller.actor, by: caller.by, paths };
  }

  private prune(now: number) {
    for (const [k, at] of this.last) if (now - at >= this.throttleMs) this.last.delete(k);
  }
}

/**
 * Sends a presence message to each socket, with only the files under its prefix; a socket with
 * none is skipped. A socket past its age is skipped too, left for the next write's broadcast
 * to close.
 */
export function broadcastPresence(
  sockets: readonly FeedSocket[],
  message: PresenceMessage,
  now = Date.now(),
) {
  let sent = 0;
  for (const s of sockets) {
    if (now - s.opened > FEED_MAX_AGE_MS) continue;
    const paths = message.paths.filter((p) => underPrefix(p, s.prefix));
    if (paths.length === 0) continue;
    try {
      s.send(JSON.stringify({ ...message, paths }));
      sent++;
    } catch {
      // Closed or closing: nothing to do.
    }
  }
  return sent;
}
