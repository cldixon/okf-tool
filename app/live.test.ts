import { describe, expect, test } from "bun:test";
import { FEED_FULL, type FeedEvent, LibraryFeed, type Message } from "./src/live";
import { Urls } from "./src/urls";

// The feed client (app/src/live.ts) without a browser: a fake socket and a fake ledger.

(globalThis as { location?: unknown }).location ??= { href: "http://localhost/ann/notes/" };
(globalThis as { WebSocket?: unknown }).WebSocket ??= { OPEN: 1 };

const ev = (seq: number, path = `p${seq}.md`): FeedEvent => ({
  seq,
  ts: "2026-10-05T00:00:00Z",
  actor: "claude-code/agent",
  request_id: `r${seq}`,
  op: "put",
  path,
  page_id: `c${seq}`,
  hash: null,
  note: null,
  from_path: null,
});

/** A feed whose ledger holds events 1..head; `read` can be held to stage races. */
function harness(
  fallback?: ConstructorParameters<typeof LibraryFeed>[3],
  hidden: () => boolean = () => false,
) {
  const ledger: FeedEvent[] = [];
  const holds: (() => void)[] = [];
  let hold = false;
  let failing = 0;
  let reads = 0;
  // A read sees the ledger as it was when the request was served (its start).
  const read = async (_urls: Urls, since: number) => {
    reads++;
    const served = ledger.filter((e) => e.seq > since);
    if (hold) await new Promise<void>((r) => holds.push(r));
    if (failing > 0) {
      failing--;
      throw new Error("offline");
    }
    return served;
  };
  const sockets: WebSocket[] = [];
  const feed = new LibraryFeed(
    new Urls("ann", "notes"),
    () => {
      const ws = {} as WebSocket;
      sockets.push(ws);
      return ws;
    },
    read,
    fallback,
    hidden,
  );
  const heard: number[] = [];
  let resets = 0;
  const sub = feed.subscribe({
    events: (events) => heard.push(...events.map((e) => e.seq)),
    reset: () => resets++,
  });
  const commit = (n: number) => {
    for (let i = 0; i < n; i++) ledger.push(ev(ledger.length + 1));
  };
  const send = (m: Message) => feed.receive(m);
  const tick = () => new Promise((r) => setTimeout(r, 0));
  return {
    feed,
    sub,
    heard,
    resets: () => resets,
    commit,
    send,
    tick,
    ledger,
    sockets,
    hold: (on: boolean) => {
      hold = on;
      if (!on) for (const r of holds.splice(0)) r();
    },
    failNext: (times = 1) => {
      failing = times;
    },
    reads: () => reads,
  };
}

describe("LibraryFeed", () => {
  test("events that committed while the page loaded are handed to it once it syncs", async () => {
    const h = harness();
    h.commit(12);
    // The page read the ledger at 10; the socket opened after 11 and 12 committed.
    h.send({ type: "hello", head: 12 });
    h.feed.sync(h.sub, 10);
    await h.tick();
    expect(h.heard).toEqual([11, 12]);
    // From then on, live, once each.
    h.commit(1);
    h.send({ type: "events", head: 13, events: [ev(13)] });
    expect(h.heard).toEqual([11, 12, 13]);
  });

  test("a page that syncs before the socket says hello still hears what it missed", async () => {
    const h = harness();
    h.commit(5);
    h.feed.sync(h.sub, 3);
    h.send({ type: "hello", head: 5 });
    await h.tick();
    expect(h.heard).toEqual([4, 5]);
  });

  test("a page drawn from older data catches up from what the feed delivered, not the ledger", async () => {
    // TEMPRA-103: a page drawn from the cache reflects a sequence the feed has passed since.
    const h = harness();
    h.commit(4);
    h.send({ type: "hello", head: 4 });
    h.commit(2);
    h.send({ type: "events", head: 6, events: [ev(5), ev(6)] });
    expect(h.heard).toEqual([5, 6]);
    const late: number[] = [];
    const page = h.feed.subscribe({
      events: (events) => late.push(...events.map((e) => e.seq)),
      reset: () => {},
    });
    h.feed.sync(page, 5);
    await h.tick();
    expect(late).toEqual([6]);
    // From before the socket opened: only the ledger has those.
    const older: number[] = [];
    const old = h.feed.subscribe({
      events: (events) => older.push(...events.map((e) => e.seq)),
      reset: () => {},
    });
    h.feed.sync(old, 2);
    await h.tick();
    expect(older).toEqual([3, 4, 5, 6]);
    expect(h.reads()).toBe(1);
  });

  test("events arriving during a replay follow it, in order, without duplicates", async () => {
    const h = harness();
    h.commit(10);
    h.send({ type: "hello", head: 10 });
    h.hold(true);
    h.feed.sync(h.sub, 8);
    h.commit(1);
    h.send({ type: "events", head: 11, events: [ev(11)] });
    expect(h.heard).toEqual([]);
    h.hold(false);
    await h.tick();
    expect(h.heard).toEqual([9, 10, 11]);
  });

  test("a gap seen during a catch-up runs it again, so the later event is not lost", async () => {
    const h = harness();
    h.commit(10);
    h.send({ type: "hello", head: 10 });
    h.commit(2);
    h.hold(true);
    // 11 and 12 committed; the socket missed them and says the head is 12: catch up.
    h.send({ type: "hello", head: 12 });
    // While that read is in flight (it will return 11 and 12), 14 arrives after 13 commits.
    h.commit(2);
    h.send({ type: "events", head: 14, events: [ev(14)] });
    h.hold(false);
    await h.tick();
    await h.tick();
    expect(h.heard).toEqual([11, 12, 13, 14]);
  });

  test("a failed catch-up is retried", async () => {
    const h = harness();
    h.commit(3);
    h.send({ type: "hello", head: 3 });
    h.commit(2);
    h.failNext();
    h.send({ type: "events", head: 5, events: [ev(5)] });
    await h.tick();
    expect(h.heard).toEqual([]);
    await new Promise((r) => setTimeout(r, 2100));
    expect(h.heard).toEqual([4, 5]);
  });

  test("a restore (the head goes back) resets the pages and follows the new head", async () => {
    const h = harness();
    h.commit(20);
    h.send({ type: "hello", head: 20 });
    // Restored to 12; the next write is 13.
    h.ledger.splice(12);
    h.send({ type: "hello", head: 12 });
    expect(h.resets()).toBe(1);
    h.commit(1);
    h.send({ type: "events", head: 13, events: [ev(13)] });
    expect(h.heard).toEqual([13]);
  });

  // TEMPRA-80: over a cap on open sockets the server opens and closes the socket with FEED_FULL.
  test("a refused socket falls back to polling the ledger and retries a socket rarely", async () => {
    const h = harness({ pollMs: 20, retryMs: 100, maxRetryMs: 1000 });
    const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
    const refuse = (i: number) => h.sockets[i]?.onclose?.({ code: FEED_FULL } as CloseEvent);
    h.commit(5);
    h.feed.sync(h.sub, 3);
    refuse(0);
    await wait(50);
    // Polled from where the page's data stands, with no new socket.
    expect(h.heard).toEqual([4, 5]);
    expect(h.sockets).toHaveLength(1);
    h.commit(1);
    await wait(40);
    expect(h.heard).toEqual([4, 5, 6]);
    // Tried again once, later; refused again, the next try waits twice as long.
    await wait(60);
    expect(h.sockets).toHaveLength(2);
    refuse(1);
    await wait(120);
    expect(h.sockets).toHaveLength(2);
    await wait(120);
    expect(h.sockets).toHaveLength(3);
    // Taken this time: polling stops, and the socket carries the events.
    h.send({ type: "hello", head: 6 });
    h.commit(1);
    await wait(60);
    expect(h.heard).toEqual([4, 5, 6]);
    h.send({ type: "events", head: 7, events: [ev(7)] });
    expect(h.heard).toEqual([4, 5, 6, 7]);
    h.sub.close();
  });

  // F-19: offline, the catch-up waits longer each time, not every 2 s forever.
  test("a failing catch-up backs off, doubling, and says it is reconnecting", async () => {
    const h = harness({ catchUpMs: 20, maxCatchUpMs: 1000 });
    const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
    const statuses: string[] = [];
    h.feed.watch((s) => statuses.push(s));
    h.commit(3);
    h.send({ type: "hello", head: 3 });
    h.commit(2);
    h.failNext(3);
    // Read at 0 (fails), then 20, 60 (fail), then 140 (served).
    h.send({ type: "events", head: 5, events: [ev(5)] });
    await wait(45);
    expect(h.reads()).toBe(2);
    expect(h.feed.status).toBe("reconnecting");
    await wait(50);
    expect(h.reads()).toBe(3);
    expect(h.heard).toEqual([]);
    await wait(80);
    expect(h.reads()).toBe(4);
    expect(h.heard).toEqual([4, 5]);
    expect(statuses).toEqual(["reconnecting", "live"]);
    h.sub.close();
  });

  test("a hidden tab holds its retries until it shows again", async () => {
    let hidden = true;
    const h = harness({ catchUpMs: 20 }, () => hidden);
    const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
    h.commit(3);
    h.send({ type: "hello", head: 3 });
    h.commit(2);
    h.failNext();
    h.send({ type: "events", head: 5, events: [ev(5)] });
    await wait(80);
    // Due at 20 ms, but the tab is hidden: nothing read, nothing spent.
    expect(h.reads()).toBe(1);
    expect(h.heard).toEqual([]);
    hidden = false;
    h.feed.wake();
    await h.tick();
    expect(h.reads()).toBe(2);
    expect(h.heard).toEqual([4, 5]);
    h.sub.close();
  });

  test("a socket that drops reconnects with backoff, and the feed recovers what it missed", async () => {
    const h = harness();
    const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
    h.commit(3);
    h.feed.sync(h.sub, 3);
    h.send({ type: "hello", head: 3 });
    await h.tick();
    // The dev server restarts: the socket closes, and two writes commit meanwhile.
    h.sockets[0]?.onclose?.({ code: 1006 } as CloseEvent);
    expect(h.feed.status).toBe("reconnecting");
    h.commit(2);
    await wait(1100);
    expect(h.sockets).toHaveLength(2);
    // The new socket says hello at the new head: the gap is read from the ledger.
    h.send({ type: "hello", head: 5 });
    await h.tick();
    await h.tick();
    expect(h.heard).toEqual([4, 5]);
    expect(h.feed.status).toBe("live");
    h.sub.close();
  });
});
