import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { flushSync } from "svelte";
import CommentsList from "./src/comments/CommentsList.svelte";
import { commentParts, type Placed } from "./src/comments/data";
import { type FeedEvent, feedOf } from "./src/live";
import { type PresenceMessage, PresenceStore } from "./src/presence";
import { Urls } from "./src/urls";
import { draw, settle } from "./test/dom";

// The library's managed agent in the app (TEMPRA-222; tempra-dev: agents/managed-agent): "Tempra
// is replying…" on the thread it answers, cleared by its reply or a timeout; links in comments.
// (The home's corner Comments is the page tools' look, TEMPRA-283.)

const BY = { person: "u1", agent: "agt_t" };
const AGENT = "tempra/agent";

const replying = (thread: string, path = "a.md"): PresenceMessage => ({
  type: "presence",
  kind: "replying",
  actor: AGENT,
  by: BY,
  paths: [path],
  thread,
});

const comment = (seq: number, thread: string, actor = AGENT, path = "a.md"): FeedEvent => ({
  seq,
  ts: "2026-10-30T00:00:00Z",
  actor,
  request_id: `r${seq}`,
  op: "comment",
  path,
  page_id: "c1",
  hash: "h",
  note: null,
  from_path: null,
  comment: { kind: "reply", thread },
  by: BY,
});

describe("replying presence (presence.ts)", () => {
  test("marks the thread, not the tree; the agent's reply clears it; a person's does not", () => {
    const p = new PresenceStore(() => 0, 8000, 60_000);
    p.add(replying("t1"));
    expect([...p.replying().keys()]).toEqual(["t1"]);
    expect(p.active().size).toBe(0);
    p.events([comment(1, "t1", "human:ann")]);
    expect(p.replying().has("t1")).toBe(true);
    p.events([comment(2, "t1")]);
    expect(p.replying().has("t1")).toBe(false);
  });

  test("fades when the turn stops saying it, and the watchers hear it go", async () => {
    const p = new PresenceStore(Date.now, 8000, 30);
    let heard = 0;
    p.watch(() => heard++);
    p.add(replying("t2"));
    expect(heard).toBe(1);
    await new Promise((r) => setTimeout(r, 120));
    expect(heard).toBe(2);
    expect(p.replying().size).toBe(0);
  });
});

describe("links in a comment (commentParts)", () => {
  const file = (path: string) => `/ann/lib/${path}`;
  test("URLs and pages by path are links; the rest is text", () => {
    expect(
      commentParts("See https://x.dev/a/b.md, and /dir/page.md. Not a/b.md or e@x.md", file),
    ).toEqual([
      { text: "See " },
      { text: "https://x.dev/a/b.md", href: "https://x.dev/a/b.md" },
      { text: ", and " },
      { text: "dir/page", href: "/ann/lib/dir/page.md" },
      { text: ". Not a/b.md or e@x.md" },
    ]);
    expect(commentParts("plain", file)).toEqual([{ text: "plain" }]);
  });

  test("a page of this library cited by URL reads as its path, links in the app (TEMPRA-225)", () => {
    const lib = "https://app.tempra.dev/ann/lib/";
    expect(
      commentParts(
        `Source: ${lib}datasets/ntsb-narratives.md (a draft). Changes: ${lib}a%20b.md?since=4. ` +
          `Not ${lib}-/activity or https://app.tempra.dev/bob/x/y.md`,
        file,
        lib,
      ),
    ).toEqual([
      { text: "Source: " },
      { text: "datasets/ntsb-narratives", href: "/ann/lib/datasets/ntsb-narratives.md" },
      { text: " (a draft). Changes: " },
      { text: "a b", href: "/ann/lib/a b.md?since=4" },
      { text: ". Not " },
      { text: `${lib}-/activity`, href: `${lib}-/activity` },
      { text: " or " },
      { text: "https://app.tempra.dev/bob/x/y.md", href: "https://app.tempra.dev/bob/x/y.md" },
    ]);
  });
});

class NoSocket {
  static OPEN = 1;
  readyState = 0;
  addEventListener() {}
  removeEventListener() {}
  close() {}
  send() {}
}
const realSocket = globalThis.WebSocket;
const realFetch = globalThis.fetch;
beforeEach(() => {
  globalThis.WebSocket = NoSocket as unknown as typeof WebSocket;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    const body = url.includes("/members")
      ? { owner: "ann", members: [], agents: ["tempra"] }
      : url.includes("/agents")
        ? { contributors: [] }
        : {};
    return new Response(JSON.stringify(body), { headers: { "Content-Type": "application/json" } });
  }) as typeof fetch;
});
afterEach(() => {
  globalThis.WebSocket = realSocket;
  globalThis.fetch = realFetch;
});

const thread = (id: string, over: Partial<Placed> = {}): Placed => ({
  id,
  path: "",
  kind: "comment",
  status: "open",
  actor: "human:ann",
  created_seq: 1,
  last_seq: 1,
  resolved_by: null,
  replies: 0,
  anchor: null,
  comments: [
    {
      id: `c-${id}`,
      actor: "human:ann",
      body: "@tempra is this current?",
      ts: "2026-10-30T00:00:00Z",
      seq: 1,
    },
  ],
  at: null,
  ...over,
});

describe("the Comments panel (CommentsList.svelte)", () => {
  test("Tempra is replying… on its thread, open or compact, until its reply lands", async () => {
    const urls = new Urls("ann", "agent-replying");
    const list = draw(CommentsList, {
      urls,
      path: "",
      placed: [thread("t1"), thread("t2", { kind: "request" })],
      error: null,
      loading: false,
      writable: true,
      draft: null,
      onDraftDone: () => {},
      active: "t1",
      onActive: () => {},
      onChanged: () => {},
    });
    await settle(10);
    const text = () => list.host.textContent ?? "";
    expect(text()).not.toContain("Tempra is replying…");
    // The library's own threads: "Comment on the library…", no "select text".
    expect(text()).toContain("Comment on the library…");
    expect(text()).not.toContain("Or select text");
    // A request says so.
    expect(list.host.querySelector(".thread-request")?.textContent).toBe("Request");
    feedOf(urls).receive(replying("t1", ""));
    feedOf(urls).receive(replying("t2", ""));
    flushSync();
    expect(list.host.querySelectorAll(".thread-replying")).toHaveLength(2);
    expect(list.host.querySelector("section .thread-replying")?.getAttribute("role")).toBe(
      "status",
    );
    feedOf(urls).receive({ type: "events", head: 5, events: [comment(5, "t1", AGENT, "")] });
    flushSync();
    expect(list.host.querySelectorAll(".thread-replying")).toHaveLength(1);
    expect(list.host.querySelector("section .thread-replying")).toBeNull();
    list.destroy();
  });
});
