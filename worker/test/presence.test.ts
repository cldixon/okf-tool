import { describe, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import {
  broadcastPresence,
  type Caller,
  callerOf,
  FEED_MAX_AGE_MS,
  type FeedMessage,
  PRESENCE_THROTTLE_MS,
  Presence,
  type PresenceMessage,
  presencePaths,
} from "../src/feed";
import { API, setup } from "./harness";

// Agents' presence on the change feed (TEMPRA-219): what an agent reads now, sent to the
// library's sockets, throttled, never for people, never for a search, never stored.

const agent: Caller = {
  actor: "claude-code/test",
  by: { person: "user_1", agent: "agt_1" },
  surface: "mcp",
  reader: "agent",
};
const page = (path: string) => ({ kind: "page", path, hash: "h" });

describe("presence messages", () => {
  test("a read and a page name their file; the generated index and a search name none", () => {
    expect(presencePaths("read", page("a/b.md"))).toEqual(["a/b.md"]);
    expect(presencePaths("read", { kind: "attachment", path: "a/x.png" })).toEqual(["a/x.png"]);
    expect(presencePaths("read", { kind: "derived", path: "index.md" })).toEqual([]);
    expect(presencePaths("page", { file: page("c.md"), head: 3 })).toEqual(["c.md"]);
    expect(presencePaths("search", { seq: 1, results: [{ path: "p.md" }] })).toEqual([]);
    expect(presencePaths("outline", { files: [] })).toEqual([]);
  });

  test("people are never presence: a human actor, or no caller at all", () => {
    const p = new Presence();
    const person = callerOf({ id: "session:user_1", actor: "human:owner", created_by: "user_1" });
    expect(person).toEqual({
      actor: "human:owner",
      by: { person: "user_1" },
      surface: "app",
      reader: "person",
    });
    expect(p.message(person, "read", page("a.md"))).toBeNull();
    expect(
      p.message(
        { actor: "human:owner", by: null, surface: "api", reader: "person" },
        "read",
        page("a.md"),
      ),
    ).toBeNull();
    expect(p.message(null, "read", page("a.md"))).toBeNull();
    expect(callerOf({ actor: "claude-code/x", created_by: "u", agent: "agt" }, "mcp")).toEqual({
      actor: "claude-code/x",
      by: { person: "u", agent: "agt" },
      surface: "mcp",
      reader: "agent",
    });
  });

  test("only reads: a search marks nothing, writes are the events' own", () => {
    const p = new Presence();
    expect(p.message(agent, "apply", { seq: 2, results: [page("a.md")] })).toBeNull();
    expect(p.message(agent, "search", { seq: 2, results: [{ path: "b.md" }] })).toBeNull();
    expect(p.message(agent, "read", page("a.md"))).toEqual({
      type: "presence",
      kind: "reading",
      actor: "claude-code/test",
      by: { person: "user_1", agent: "agt_1" },
      paths: ["a.md"],
    });
  });

  test("throttled per agent and file", () => {
    const p = new Presence();
    const t = 1_000_000;
    expect(p.message(agent, "read", page("a.md"), t)?.paths).toEqual(["a.md"]);
    // The same agent on the same file, too soon: nothing, by `read` or `page`.
    expect(p.message(agent, "read", page("a.md"), t + 1000)).toBeNull();
    expect(p.message(agent, "page", { file: page("a.md") }, t + 1000)).toBeNull();
    // Another agent or another file goes through.
    expect(
      p.message({ ...agent, actor: "other/x" }, "read", page("a.md"), t + 1000),
    ).not.toBeNull();
    expect(p.message(agent, "read", page("b.md"), t + 1000)).not.toBeNull();
    // Past the throttle, again.
    expect(p.message(agent, "read", page("a.md"), t + PRESENCE_THROTTLE_MS)).not.toBeNull();
  });

  test("each socket gets the files under its prefix; old or broken sockets are skipped", () => {
    const now = Date.now();
    const got: Record<string, FeedMessage[]> = { all: [], notes: [], other: [], old: [] };
    const socket = (name: string, prefix: string, opened = now) => ({
      prefix,
      opened,
      close: () => {
        throw new Error("presence never closes a socket");
      },
      send: (m: string) => got[name]?.push(JSON.parse(m) as FeedMessage),
    });
    const message: PresenceMessage = {
      type: "presence",
      kind: "reading",
      actor: "claude-code/test",
      by: null,
      paths: ["notes/a.md"],
    };
    const elsewhere: PresenceMessage = { ...message, paths: ["x.md"] };
    const sockets = [
      socket("all", ""),
      socket("notes", "notes"),
      socket("other", "other"),
      socket("old", "", now - FEED_MAX_AGE_MS - 1),
      {
        prefix: "",
        opened: now,
        close: () => {},
        send: () => {
          throw new Error("closed");
        },
      },
    ];
    expect(broadcastPresence(sockets, message, now)).toBe(2);
    expect(broadcastPresence(sockets, elsewhere, now)).toBe(1);
    expect(got.all).toEqual([message, elsewhere]);
    expect(got.notes).toEqual([message]);
    expect(got.other).toEqual([]);
    expect(got.old).toEqual([]);
  });
});

describe("presence from the API and MCP", () => {
  async function library() {
    const s = setup();
    for (const [path, title, body] of [
      ["notes/alpha.md", "Alpha", "Pelicans fly over the bay."],
      ["notes/beta.md", "Beta", "Pelicans nest on the cliffs."],
      ["gamma.md", "Gamma", "Nothing about birds."],
    ] as const) {
      const r = await s.req(`/files/${path}`, {
        method: "PUT",
        headers: { "Content-Type": "text/markdown" },
        body: `---\ntype: Note\ntitle: ${title}\ndescription: A note.\n---\n${body}\n`,
      });
      expect(r.status).toBeLessThan(300);
    }
    // The writes themselves send no presence: their events are on the feed.
    expect(s.presence).toEqual([]);
    return s;
  }

  test("an agent's GET …/files and …/page are reading; its search marks nothing", async () => {
    const s = await library();
    const read = await s.req("/files/notes/alpha.md", { headers: { Accept: "application/json" } });
    expect(read.status).toBe(200);
    const page = await s.req("/page/gamma.md", { token: "reader" });
    expect(page.status).toBe(200);
    const found = await s.req("/search?q=pelicans");
    expect(found.status).toBe(200);
    expect(s.presence.map((p) => [p.message.kind, p.message.actor, p.message.paths])).toEqual([
      ["reading", "claude-code/test", ["notes/alpha.md"]],
      ["reading", "claude-code/reader", ["gamma.md"]],
    ]);
    expect(s.presence.every((p) => p.doId === "lib-1")).toBe(true);
  });

  test("people's own reads in the app, and a human: token's, say nothing", async () => {
    const s = await library();
    expect((await s.app.request(`${API}/page/gamma.md`)).status).toBe(200);
    expect(
      (await s.app.request(`${API}/files/gamma.md`, { headers: { Accept: "application/json" } }))
        .status,
    ).toBe(200);
    expect((await s.app.request(`${API}/search?q=pelicans`)).status).toBe(200);
    expect((await s.req("/files/gamma.md", { token: "human" })).status).toBe(200);
    expect(s.presence).toEqual([]);
  });

  test("MCP read is presence, throttled; MCP search is not", async () => {
    const s = await library();
    const transport = new StreamableHTTPClientTransport(new URL("http://localhost/mcp"), {
      requestInit: { headers: { Authorization: "Bearer writer" } },
      fetch: async (url, init) => s.app.request(url.toString(), init as RequestInit),
    });
    const client = new Client({ name: "test", version: "1.0.0" });
    await client.connect(transport);
    const call = async (name: string, args: Record<string, unknown>) => {
      const r = await client.callTool({ name, arguments: args });
      expect(r.isError).toBeFalsy();
    };
    await call("search", { q: "pelicans" });
    expect(s.presence).toEqual([]);
    await call("read", { path: "notes/beta.md" });
    await call("read", { path: "notes/beta.md" });
    // The second read came within the throttle.
    expect(s.presence.map((p) => [p.message.kind, p.message.paths])).toEqual([
      ["reading", ["notes/beta.md"]],
    ]);
    await client.close();
  });
});
