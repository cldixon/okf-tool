import { describe, expect, test } from "bun:test";
import {
  broadcast,
  concerns,
  FEED_MAX_AGE_MS,
  FEED_REAUTHORIZE,
  type FeedEvent,
  type FeedMessage,
  feedEvent,
} from "../src/feed";
import { API, ORIGIN, setup } from "./harness";

// The change feed (tempra-dev: app/live, TEMPRA-12).

const event = (path: string, from: string | null = null): FeedEvent => ({
  seq: 1,
  ts: "2026-10-04T00:00:00Z",
  actor: "claude-code/test",
  request_id: "r1",
  op: from ? "move" : "put",
  path,
  page_id: "c1",
  hash: "h",
  note: null,
  from_path: from,
  comment: null,
  by: null,
});

describe("broadcast", () => {
  test("each socket gets the events under its prefix, moves out of it included", () => {
    const got: Record<string, FeedMessage[]> = { all: [], notes: [], other: [] };
    const socket = (name: string, prefix: string) => ({
      prefix,
      opened: Date.now(),
      close: () => {},
      send: (m: string) => got[name]?.push(JSON.parse(m) as FeedMessage),
    });
    const events = [event("notes/a.md"), event("tables/b.md", "notes/b.md"), event("x.md")];
    const sent = broadcast(
      [socket("all", ""), socket("notes", "notes"), socket("other", "other")],
      7,
      events,
    );
    expect(sent).toBe(2);
    expect(got.all?.[0]).toMatchObject({ type: "events", head: 7 });
    expect(got.all?.[0]?.type === "events" && got.all[0].events.length).toBe(3);
    const notes = got.notes?.[0];
    expect(notes?.type === "events" && notes.events.map((e) => e.path)).toEqual([
      "notes/a.md",
      "tables/b.md",
    ]);
    expect(got.other).toEqual([]);
  });

  test("a socket that cannot take a message does not stop the others", () => {
    const ok: string[] = [];
    const sent = broadcast(
      [
        {
          prefix: "",
          opened: Date.now(),
          close: () => {},
          send: () => {
            throw new Error("closed");
          },
        },
        { prefix: "", opened: Date.now(), close: () => {}, send: (m) => ok.push(m) },
      ],
      1,
      [event("a.md")],
    );
    expect(sent).toBe(1);
    expect(ok).toHaveLength(1);
  });

  test("a socket past its age is closed to reconnect (and be authorized again), not sent to", () => {
    const now = 1_000_000_000;
    const sent: string[] = [];
    const closed: number[] = [];
    const socket = (opened: number) => ({
      prefix: "",
      opened,
      send: (m: string) => sent.push(m),
      close: (code: number) => closed.push(code),
    });
    const n = broadcast(
      [socket(now - FEED_MAX_AGE_MS - 1), socket(now - 1000)],
      1,
      [event("a.md")],
      now,
    );
    expect(n).toBe(1);
    expect(sent).toHaveLength(1);
    expect(closed).toEqual([FEED_REAUTHORIZE]);
  });

  test("concerns: the directory itself, below it, not a sibling with the same start", () => {
    expect(concerns(event("notes/a.md"), "notes")).toBe(true);
    expect(concerns(event("notesx/a.md"), "notes")).toBe(false);
    expect(concerns(event("anything.md"), "")).toBe(true);
  });

  test("events from a real write carry the note and the move's origin", async () => {
    const s = setup();
    await s.req("/files/a.md", {
      method: "PUT",
      headers: { "Content-Type": "text/markdown", "X-Note": "first" },
      body: "---\ntype: Note\n---\nA\n",
    });
    await s.req("/files/a.md/move", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ to: "b.md", note: "renamed" }),
    });
    const events = s.store().events({}).events.map(feedEvent);
    expect(events.map((e) => [e.op, e.path, e.note, e.from_path])).toEqual([
      ["put", "a.md", "first", null],
      ["move", "b.md", "renamed", "a.md"],
    ]);
    expect(events[0]).toMatchObject({ actor: "claude-code/test", seq: 1 });
  });
});

describe("GET /feed", () => {
  const upgrade = { Upgrade: "websocket", Connection: "Upgrade" };

  function wired() {
    const s = setup();
    const calls: { doId: string; prefix: string; account: string }[] = [];
    s.deps.feed = async (doId, _req, { prefix, account }) => {
      calls.push({ doId, prefix, account });
      // bun cannot make a 101; the Durable Object does that in workerd.
      return new Response("feed", { status: 200 });
    };
    return { s, calls };
  }

  test("must be a WebSocket upgrade", async () => {
    const { s } = wired();
    const r = await s.app.request(`${API}/feed`);
    expect(r.status).toBe(426);
  });

  test("the signed-in owner, from this site, reaches the library's object; prefix passes", async () => {
    const { s, calls } = wired();
    const r = await s.app.request(`${API}/feed?prefix=notes`, {
      headers: { ...upgrade, Origin: ORIGIN },
    });
    expect(r.status).toBe(200);
    expect(calls).toEqual([{ doId: "lib-1", prefix: "notes", account: "owner" }]);
    // Counted once, as a connection.
    expect(s.usage.filter((u) => u.kind === "feed")).toEqual([
      { kind: "feed", account: "owner", library: "lib-1" },
    ]);
  });

  test("a session from another site is refused; a bearer token needs no Origin", async () => {
    const { s, calls } = wired();
    const cross = await s.app.request(`${API}/feed`, {
      headers: { ...upgrade, Origin: "https://evil.example" },
    });
    expect(cross.status).toBe(403);
    const bearer = await s.anon.request(`${API}/feed`, {
      headers: { ...upgrade, Authorization: "Bearer reader" },
    });
    expect(bearer.status).toBe(200);
    expect(calls).toHaveLength(1);
  });

  test("a stranger gets 404, like every library route", async () => {
    const { s, calls } = wired();
    const other = await s.stranger();
    const r = await other.app.request(`${API}/feed`, { headers: { ...upgrade, Origin: ORIGIN } });
    expect(r.status).toBe(404);
    expect(calls).toEqual([]);
  });
});
