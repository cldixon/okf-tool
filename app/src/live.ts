import type { ActedBy } from "./agents";
import { api, cache } from "./api";
import { type PresenceMessage, PresenceStore } from "./presence";
import type { Urls } from "./urls";

/** One committed ledger event, as the change feed sends it (worker/src/feed.ts). */
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
  from_path: string | null;
  /** For a comment: what was done, to which thread (absent in tests that make events by hand). */
  comment?: { kind: string; thread: string } | null;
  /** The person and agent behind the actor, by id; absent on events from before it was kept. */
  by?: ActedBy | null;
}

/** What the socket sends; presence (TEMPRA-219) carries no head and moves no cursor. */
export type Message =
  | { type: "hello"; head: number }
  | { type: "events"; head: number; events: FeedEvent[] }
  | PresenceMessage;

/** What a page hears: new events in order, or that the ledger was rolled back (a restore). */
export interface Listener {
  events(events: FeedEvent[]): void;
  /** The ledger is behind what the page saw (a point-in-time restore): reload everything. */
  reset(): void;
}

interface Subscription {
  listener: Listener;
  /** The ledger sequence the page's data reflects, until the events after it are replayed. */
  from: number | null;
  /** Events that arrive during a replay, handed on after it. */
  pending: FeedEvent[];
}

/** The close code the server uses to have a socket reconnect, authorized afresh. */
const REAUTHORIZE = 4001;

/**
 * The close code for a connection refused over the library's or the account's cap on open
 * sockets (TEMPRA-80): the feed polls the ledger instead and tries a socket again much later.
 */
export const FEED_FULL = 4029;

/**
 * How often a feed refused a socket reads the ledger, and when it first tries a socket again;
 * and how long a failed catch-up waits before the next, doubling up to a minute (F-19).
 */
export const FALLBACK = {
  pollMs: 15_000,
  retryMs: 5 * 60_000,
  maxRetryMs: 30 * 60_000,
  catchUpMs: 2000,
  maxCatchUpMs: 60_000,
};

/** Whether the feed is following the library, or trying to get back to it. */
export type FeedStatus = "live" | "reconnecting";

/** How many delivered events a feed keeps for pages that catch up (`replay`). */
const RECENT = 500;

/** Whether the page is out of sight (a background tab): retries wait for it to show again. */
const pageHidden = () => typeof document !== "undefined" && document.visibilityState === "hidden";

/**
 * The change feed of one library (tempra-dev: app/live): one WebSocket shared by every page of
 * the library that listens. It reconnects with backoff and, after any gap, catches up from
 * `GET /events?since=` so no event is missed; listeners see each event once, in order. A page
 * says which sequence its data reflects (`sync`), and hears every event after it, including
 * any that arrived while it was loading. Retries (a socket, a catch-up) back off and wait while
 * the tab is hidden; `status` says when the feed is reconnecting, for the frame's quiet notice.
 */
export class LibraryFeed {
  private socket: WebSocket | null = null;
  private subs = new Set<Subscription>();
  /** The last sequence handed to listeners. */
  private last: number | null = null;
  /**
   * The events handed to listeners lately, every one after `recentFrom` up to `last`, so a page
   * drawn from the cache catches up from here rather than from the ledger (TEMPRA-103).
   */
  private recent: FeedEvent[] = [];
  private recentFrom: number | null = null;
  private retry = 0;
  private ping: ReturnType<typeof setInterval> | undefined;
  private idle: ReturnType<typeof setTimeout> | undefined;
  private catching: Promise<void> | null = null;
  /** A gap was seen while a catch-up was running: run it again when it ends. */
  private again = false;
  /** Set while the server refuses a socket (FEED_FULL): the ledger is polled instead. */
  private polling: ReturnType<typeof setInterval> | undefined;
  private retrySocket: ReturnType<typeof setTimeout> | undefined;
  /** Sockets refused in a row, to space out the next try. */
  private refused = 0;
  /** Catch-ups failed in a row, to space out the next. */
  private failed = 0;
  /** Retries that came due while the tab was hidden, run when it shows again (one per kind). */
  private paused = new Map<string, () => void>();
  private timers = new Set<ReturnType<typeof setTimeout>>();
  status: FeedStatus = "live";
  private watchers = new Set<(s: FeedStatus) => void>();
  /**
   * What agents are reading, searching and writing now (TEMPRA-219): from the socket's presence
   * messages and its live events, never from a catch-up (those are past).
   */
  readonly presence = new PresenceStore();

  constructor(
    private urls: Urls,
    private open: (url: URL) => WebSocket = (url) => new WebSocket(url),
    private read: typeof readEvents = readEvents,
    fallback: Partial<typeof FALLBACK> = {},
    private hidden: () => boolean = pageHidden,
  ) {
    this.fallback = { ...FALLBACK, ...fallback };
  }

  private fallback: typeof FALLBACK;

  /** Calls `fn` with each change of status, until the function it returns is called. */
  watch(fn: (s: FeedStatus) => void): () => void {
    this.watchers.add(fn);
    return () => this.watchers.delete(fn);
  }

  private setStatus(s: FeedStatus) {
    if (this.status === s) return;
    this.status = s;
    for (const fn of this.watchers) fn(s);
  }

  /**
   * Runs `fn` after `ms`, or, when the tab is hidden by then, once it shows again (`wake`): a
   * background tab spends nothing on retries. One paused retry is kept of each kind.
   */
  private later(kind: string, fn: () => void, ms: number) {
    const t = setTimeout(() => {
      this.timers.delete(t);
      if (this.hidden()) this.paused.set(kind, fn);
      else fn();
    }, ms);
    this.timers.add(t);
  }

  /** The tab shows again: run the retries it held back. */
  wake() {
    if (this.hidden()) return;
    const due = [...this.paused.values()];
    this.paused.clear();
    for (const fn of due) fn();
  }

  subscribe(listener: Listener): Subscription & { close(): void } {
    const sub: Subscription = { listener, from: null, pending: [] };
    this.subs.add(sub);
    clearTimeout(this.idle);
    if (!this.socket && this.polling === undefined) this.connect();
    return Object.assign(sub, {
      close: () => {
        this.subs.delete(sub);
        // Moving between pages of the same library keeps the socket.
        if (this.subs.size === 0) this.idle = setTimeout(() => this.close(), 10_000);
      },
    });
  }

  /** The page's data reflects the ledger up to `seq`: hand it whatever came after. */
  sync(sub: Subscription, seq: number) {
    sub.from = seq;
    void this.replay(sub);
  }

  private connect() {
    const url = new URL(this.urls.api("feed"), location.href);
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    const ws = this.open(url);
    this.socket = ws;
    ws.onopen = () => {
      this.retry = 0;
      this.ping = setInterval(() => ws.readyState === WebSocket.OPEN && ws.send("ping"), 30_000);
    };
    ws.onmessage = (e) => {
      if (typeof e.data !== "string" || e.data === "pong") return;
      this.receive(JSON.parse(e.data) as Message);
    };
    ws.onclose = (e) => {
      clearInterval(this.ping);
      if (this.socket !== ws) return;
      this.socket = null;
      if (this.subs.size === 0) return;
      // Over a cap on open sockets: poll, and try a socket again much later, never in a loop.
      if (e.code === FEED_FULL) {
        this.poll();
        return;
      }
      this.stopPolling();
      this.refused = 0;
      // Asked to reconnect (the server re-checks access): at once; otherwise back off, and say
      // that the feed is reconnecting.
      if (e.code !== REAUTHORIZE) this.setStatus("reconnecting");
      const wait = e.code === REAUTHORIZE ? 0 : Math.min(30_000, 1000 * 2 ** this.retry++);
      this.later("socket", () => this.subs.size && !this.socket && this.connect(), wait);
    };
  }

  /**
   * The socket was refused: read the ledger every so often instead (the same catch-up a gap
   * runs), and try a socket again after a wait that doubles with each refusal.
   */
  private poll() {
    if (this.polling === undefined) {
      this.polling = setInterval(() => {
        if (this.subs.size === 0) return;
        // Never connected: start from what the pages loaded, not from the ledger's beginning.
        if (this.last === null) {
          const from = [...this.subs].flatMap((s) => (s.from === null ? [] : [s.from]));
          if (from.length === 0) return;
          this.last = Math.min(...from);
          for (const sub of this.subs) void this.replay(sub);
        }
        void this.catchUp();
      }, this.fallback.pollMs);
    }
    const wait = Math.min(this.fallback.maxRetryMs, this.fallback.retryMs * 2 ** this.refused++);
    clearTimeout(this.retrySocket);
    this.retrySocket = setTimeout(() => {
      if (this.subs.size && !this.socket) this.connect();
    }, wait);
  }

  private stopPolling() {
    clearInterval(this.polling);
    clearTimeout(this.retrySocket);
    this.polling = undefined;
  }

  /** A message from the socket. */
  receive(m: Message) {
    if (m.type === "presence") {
      this.presence.add(m);
      return;
    }
    if (m.type === "events") this.presence.events(m.events);
    if (this.last !== null && m.head < this.last) {
      // The ledger went back (a restore): start again from where it is now.
      this.last = m.head;
      this.recent = [];
      this.recentFrom = m.head;
      cache.wrote();
      for (const sub of this.subs) {
        sub.from = null;
        sub.pending = [];
        sub.listener.reset();
      }
      if (m.type === "hello") return;
    }
    if (m.type === "hello") {
      // A socket is open again: the server took it, so stop polling.
      this.stopPolling();
      this.refused = 0;
      if (this.failed === 0) this.setStatus("live");
      if (this.last === null) {
        this.last = m.head;
        this.recentFrom = m.head;
      } else if (m.head > this.last) void this.catchUp();
      for (const sub of this.subs) void this.replay(sub);
      return;
    }
    const first = m.events[0]?.seq ?? m.head;
    if (this.last !== null && first > this.last + 1) {
      void this.catchUp();
      return;
    }
    this.deliver(m.events);
    if (this.last !== null && m.head > this.last) void this.catchUp();
  }

  private deliver(events: FeedEvent[]) {
    const fresh = events.filter((e) => this.last === null || e.seq > this.last);
    if (fresh.length === 0) return;
    // What pages asked for before these writes is no longer fresh: the next to mount asks again.
    cache.wrote();
    this.remember(fresh);
    this.last = fresh[fresh.length - 1]?.seq ?? this.last;
    for (const sub of this.subs) {
      // A page catching up hears these after the events it missed.
      if (sub.from === null) sub.listener.events(fresh);
      else sub.pending.push(...fresh);
    }
  }

  /** Keeps the events just delivered (they follow `last`), the last RECENT of them. */
  private remember(fresh: FeedEvent[]) {
    // Before any hello: the buffer starts at the first of these.
    if (this.recentFrom === null) this.recentFrom = (fresh[0]?.seq ?? 1) - 1;
    this.recent.push(...fresh);
    const over = this.recent.length - RECENT;
    if (over > 0) {
      this.recentFrom = this.recent[over - 1]?.seq ?? this.recentFrom;
      this.recent = this.recent.slice(over);
    }
  }

  /**
   * Hands a page that just loaded the events between its data and what the feed has delivered
   * (they arrived, or committed, while it was loading); from then on it hears events live.
   */
  private async replay(sub: Subscription) {
    const from = sub.from;
    const upTo = this.last;
    if (from === null || upTo === null) return;
    let missed: FeedEvent[] = [];
    if (from < upTo) {
      if (this.recentFrom !== null && from >= this.recentFrom) {
        // Delivered lately: no need to ask the ledger again. Handed on after the caller's
        // turn, as a read would be, never inside the effect that synced (it would track what
        // the listener reads and sync again).
        missed = this.recent.filter((e) => e.seq > from && e.seq <= upTo);
        await Promise.resolve();
      } else {
        try {
          missed = (await this.read(this.urls, from)).filter((e) => e.seq <= upTo);
        } catch {
          // Offline: the page reloads on the next event or reconnect.
        }
      }
      // Synced again (it reloaded) or gone: that replay takes over.
      if (sub.from !== from || !this.subs.has(sub)) return;
    }
    const events = [...missed, ...sub.pending].filter((e) => e.seq > from);
    sub.from = null;
    sub.pending = [];
    if (events.length > 0) sub.listener.events(events);
  }

  /** Reads what the socket did not deliver from the ledger, then hands it on. */
  private catchUp(): Promise<void> {
    if (this.catching) {
      this.again = true;
      return this.catching;
    }
    this.catching = (async () => {
      try {
        do {
          this.again = false;
          this.deliver(await this.read(this.urls, this.last ?? 0));
        } while (this.again);
        this.failed = 0;
        if (this.socket || this.polling !== undefined) this.setStatus("live");
      } catch {
        // Retry while anyone listens, waiting longer each time and not while the tab is hidden
        // (each read spends the session's rate limit); a reconnect's hello also starts one.
        this.setStatus("reconnecting");
        const { catchUpMs, maxCatchUpMs } = this.fallback;
        const wait = Math.min(maxCatchUpMs, catchUpMs * 2 ** this.failed++);
        this.later("catch-up", () => this.subs.size && void this.catchUp(), wait);
      } finally {
        this.catching = null;
      }
    })();
    return this.catching;
  }

  private close() {
    clearInterval(this.ping);
    this.stopPolling();
    this.refused = 0;
    this.failed = 0;
    for (const t of this.timers) clearTimeout(t);
    this.timers.clear();
    this.paused.clear();
    this.setStatus("live");
    const ws = this.socket;
    this.socket = null;
    ws?.close(1000, "done");
  }
}

/** Every ledger event after `since`, in order, read page by page. */
async function readEvents(urls: Urls, since: number): Promise<FeedEvent[]> {
  const out: FeedEvent[] = [];
  for (let after = since; ; ) {
    const page = await api<{
      events: (Omit<FeedEvent, "note" | "from_path" | "by"> & {
        meta: { note?: unknown; from_path?: unknown; by?: ActedBy } | null;
      })[];
      next: number | null;
    }>(urls.api("events", { since: after, limit: 1000 }));
    for (const e of page.events) {
      out.push({
        ...e,
        note: typeof e.meta?.note === "string" ? e.meta.note : null,
        from_path: typeof e.meta?.from_path === "string" ? e.meta.from_path : null,
        by: typeof e.meta?.by?.person === "string" ? e.meta.by : null,
      });
    }
    if (page.next === null || page.events.length === 0) return out;
    after = page.events[page.events.length - 1]?.seq ?? page.next;
  }
}

const feeds = new Map<string, LibraryFeed>();

/** The library's one feed, made on first use; a tab shown again wakes every feed's retries. */
export function feedOf(urls: Urls): LibraryFeed {
  const key = `${urls.owner}/${urls.slug}`;
  let feed = feeds.get(key);
  if (!feed) {
    if (feeds.size === 0 && typeof document !== "undefined") {
      document.addEventListener("visibilitychange", () => {
        for (const f of feeds.values()) f.wake();
      });
    }
    feed = new LibraryFeed(urls);
    feeds.set(key, feed);
  }
  return feed;
}
