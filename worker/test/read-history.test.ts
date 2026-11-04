import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { callerOf, readingOf } from "../src/feed";
import { agoText, type ReadHistory, type Reading, readerKey, readsText } from "../src/store/reads";
import type { SqlHandle } from "../src/store/sql";
import { LibraryStore } from "../src/store/store";
import { DAY, md } from "./changes";
import { API, ORIGIN, setup } from "./harness";
import { bunSqlHandle } from "./sqlite";

// Read history (TEMPRA-220, tempra-dev: v2/read-history): reads by surface and by agent or
// person, the last read per surface, distinct readers as a count; never who.

const ctx = () => ({ actor: "claude-code/test", request_id: crypto.randomUUID() });
const agentMcp: Reading = { surface: "mcp", kind: "agent", reader: "a:agt_1" };
const otherAgentApi: Reading = { surface: "api", kind: "agent", reader: "a:agt_2" };
const personApp: Reading = { surface: "app", kind: "person", reader: "p:user_1" };
const personMcp: Reading = { surface: "mcp", kind: "person", reader: "p:user_1" };

function recorded(db = new Database(":memory:")) {
  const inner = bunSqlHandle(db);
  const sent: string[] = [];
  const sql: SqlHandle = {
    all: (q, ...p) => {
      sent.push(q);
      return inner.all(q, ...p);
    },
    run: (q, ...p) => {
      sent.push(q);
      inner.run(q, ...p);
    },
    script: (q) => inner.script(q),
    transaction: (fn) => inner.transaction(fn),
  };
  return { db, sql, sent };
}
const writes = (sent: string[]) =>
  sent.filter((q) => /^\s*(INSERT|UPDATE|DELETE|REPLACE)\b/i.test(q));

function library(start = "2026-10-20T12:00:00Z", db = new Database(":memory:")) {
  const clock = { t: Date.parse(start) };
  const rec = recorded(db);
  const store = new LibraryStore(rec.sql, { now: () => new Date(clock.t) });
  store.apply(ctx(), [
    { op: "write", path: "p.md", content: md("T p", "Policy.\n") },
    { op: "write", path: "q.md", content: md("T q", "Quiet.\n") },
  ]);
  return { store, clock, ...rec };
}

/** A page's history as the app's GET sees it: a session's GETs count nothing. */
const historyOf = (store: LibraryStore, path: string): ReadHistory => {
  const v = store.reading(personApp, () => store.read(path, { reads: true }));
  if (v.kind !== "page" || !v.reads) throw new Error("no reads");
  return v.reads;
};

describe("read history in the store", () => {
  test("counts and last read by surface and by agent or person", () => {
    const { store, clock } = library();
    store.reading(agentMcp, () => store.read("p.md"));
    store.reading(agentMcp, () => store.read("p.md"));
    store.reading(otherAgentApi, () => store.read("p.md"));
    store.reading(personMcp, () => store.read("p.md"));
    clock.t += 3 * 60_000;
    store.reading(personApp, () => store.viewed("p.md"));
    // Ten days ago: in the month, not the week.
    clock.t -= 10 * DAY;
    store.reading(agentMcp, () => store.read("p.md"));
    clock.t += 10 * DAY;

    // Each reader once a day: agt_1 twice over MCP is one read, and the person over MCP and in
    // the app is one read, on both surfaces.
    const h = historyOf(store, "p.md");
    expect(h.week).toEqual({ total: 3, agents: 2, people: 1, mcp: 2, app: 1, api: 1, readers: 3 });
    expect(h.month).toEqual({
      total: 4,
      agents: 3,
      people: 1,
      mcp: 3,
      app: 1,
      api: 1,
      readers: 3,
    });
    expect(h.last.app).toBe("2026-10-20T12:03:00Z");
    expect(h.last.api).toBe("2026-10-20T12:00:00Z");
    // The latest MCP read stays the latest, though an older one was counted after it.
    expect(h.last.mcp).toBe("2026-10-20T12:00:00Z");
    expect(h.last_read).toBe("2026-10-20T12:03:00Z");

    // The same once flushed, with nothing pending.
    store.flushReads();
    expect(store.reading(personApp, () => store.page("p.md")).reads).toEqual(h);
    // The usage window's count is every read (before this one); a call with no reader (the
    // Worker's own, a store test's) still counts, in totals only, as reads did before.
    const computed = store.read("p.md", { computed: true });
    expect(computed.kind === "page" && computed.markdown).toContain("usage_count: 6");
    expect(historyOf(store, "p.md").month).toMatchObject({ total: 5, agents: 3, people: 1 });
  });

  test("a reader counts once per page and day; the last read still moves", () => {
    const { store, clock } = library();
    for (let i = 0; i < 5; i++) store.reading(agentMcp, () => store.read("p.md"));
    for (let i = 0; i < 3; i++) {
      clock.t += 60_000;
      store.reading(personApp, () => store.viewed("p.md"));
    }
    let h = historyOf(store, "p.md");
    expect(h.week).toMatchObject({ total: 2, agents: 1, people: 1, mcp: 1, app: 1, readers: 2 });
    expect(h.last.app).toBe("2026-10-20T12:03:00Z");
    // The next day they count again; still two readers.
    clock.t += DAY;
    store.reading(agentMcp, () => store.read("p.md"));
    store.reading(personApp, () => store.viewed("p.md"));
    store.flushReads();
    h = historyOf(store, "p.md");
    expect(h.week).toMatchObject({ total: 4, agents: 2, people: 2, readers: 2 });
    // The raw count stays for usage_count, as before.
    const computed = store.read("p.md", { computed: true });
    expect(computed.kind === "page" && computed.markdown).toContain("usage_count: 10");
  });

  test("a page an agent shows its person (MCP show) is the person's read", () => {
    const { store } = library();
    const forPerson: Reading = { ...agentMcp, person: "p:user_1" };
    store.reading(forPerson, () => store.page("p.md", { shown: true }));
    expect(historyOf(store, "p.md").week).toMatchObject({
      total: 1,
      agents: 0,
      people: 1,
      mcp: 1,
    });
    // Their own open the same day adds the app, not a read.
    store.reading(personApp, () => store.viewed("p.md"));
    expect(historyOf(store, "p.md").week).toMatchObject({ total: 1, people: 1, mcp: 1, app: 1 });
    // The agent's own page read, or one with no person known, stays the agent's.
    store.reading(forPerson, () => store.page("q.md"));
    store.reading(agentMcp, () => store.page("q.md", { shown: true }));
    expect(historyOf(store, "q.md").week).toMatchObject({ total: 1, agents: 1, people: 0 });
  });

  test("the app's reads count only from the page it shows, never from its GETs", () => {
    const { store } = library();
    for (let i = 0; i < 5; i++) {
      store.reading(personApp, () => store.page("p.md"));
      store.reading(personApp, () => store.read("p.md"));
    }
    expect(historyOf(store, "p.md").month.app).toBe(0);
    expect(store.reading(personApp, () => store.viewed("p.md")).reads.week).toMatchObject({
      total: 1,
      people: 1,
      app: 1,
    });
    // An attachment, a derived file or a missing page is not a page shown.
    expect(() => store.viewed("index.md")).toThrow();
    expect(() => store.viewed("nope.md")).toThrow();
  });

  test("a read never writes: counts flush in batches, with the last reads", () => {
    const { store, db, sent } = library();
    sent.length = 0;
    for (let i = 0; i < 40; i++) {
      store.reading(i % 2 ? agentMcp : otherAgentApi, () => store.read("p.md"));
    }
    store.reading(personApp, () => store.viewed("q.md"));
    expect(writes(sent)).toEqual([]);
    expect(store.pendingReads()).toBe(41);
    expect(db.query("SELECT COUNT(*) AS n FROM last_read").get()).toEqual({ n: 0 });
    expect(store.flushReads()).toBe(41);
    expect(
      db
        .query(
          "SELECT surface, kind, SUM(reads) AS n FROM access_log GROUP BY surface, kind ORDER BY surface",
        )
        .all(),
    ).toEqual([
      { surface: "api", kind: "agent", n: 20 },
      { surface: "app", kind: "person", n: 1 },
      { surface: "mcp", kind: "agent", n: 20 },
    ]);
    expect(db.query("SELECT COUNT(*) AS n FROM last_read").get()).toEqual({ n: 3 });
    // One row per day, page, surface, kind and reader: upserts, not a row per read.
    expect(db.query("SELECT COUNT(*) AS n FROM access_log").get()).toEqual({ n: 3 });
  });

  test("an older library is upgraded once; its counts stay, in totals only", () => {
    const db = new Database(":memory:");
    const { store: first } = library("2026-10-20T12:00:00Z", db);
    const id = (
      db.query("SELECT page_id AS id FROM paths WHERE path = 'p.md'").get() as {
        id: string;
      }
    ).id;
    first.flushReads();
    // As a library from before TEMPRA-220 has it: no surface or kind, no last_read.
    db.run("DROP TABLE access_log");
    db.run("DROP TABLE last_read");
    db.run("CREATE TABLE access_log (day TEXT, page_id TEXT, actor TEXT, reads INTEGER)");
    db.run("CREATE UNIQUE INDEX access_log_key ON access_log(day, page_id, actor)");
    db.run("DELETE FROM meta WHERE key = 'read_history'");
    db.run("INSERT INTO access_log VALUES ('2026-10-19', ?, '', 4), ('2026-10-01', ?, '', 6)", [
      id,
      id,
    ]);

    const store = new LibraryStore(bunSqlHandle(db), {
      now: () => new Date("2026-10-20T12:00:00Z"),
    });
    const cols = (db.query("PRAGMA table_info(access_log)").all() as { name: string }[]).map(
      (c) => c.name,
    );
    expect(cols).toEqual(["day", "page_id", "actor", "reads", "surface", "kind"]);
    expect(db.query("SELECT name FROM sqlite_master WHERE name = 'access_log_key'").all()).toEqual(
      [],
    );
    store.reading(agentMcp, () => store.read("p.md"));
    store.flushReads();
    const h = historyOf(store, "p.md");
    expect(h.week).toEqual({ total: 5, agents: 1, people: 0, mcp: 1, app: 0, api: 0, readers: 1 });
    expect(h.month.total).toBe(11);
    expect(h.last.mcp).toBe("2026-10-20T12:00:00Z");
    // Opening it again changes nothing.
    new LibraryStore(bunSqlHandle(db), { now: () => new Date("2026-10-20T12:00:00Z") });
    expect(db.query("SELECT COUNT(*) AS n FROM access_log").get()).toEqual({ n: 3 });
  });

  test("pruning drops counts past the window; a last read stays while its page exists", () => {
    const { store, clock, db } = library();
    store.reading(agentMcp, () => store.read("p.md"));
    store.reading(agentMcp, () => store.read("q.md"));
    store.flushReads();
    const hash = (store.read("q.md") as { hash: string }).hash;
    store.apply(ctx(), [{ op: "delete", path: "q.md", if_match: hash }]);
    clock.t += 40 * DAY;
    expect(store.pruneUsage()).toBeGreaterThan(0);
    expect(db.query("SELECT COUNT(*) AS n FROM access_log").get()).toEqual({ n: 0 });
    const h = historyOf(store, "p.md");
    expect(h.month.total).toBe(0);
    expect(h.last.mcp).toBe("2026-10-20T12:00:00Z");
    expect(db.query("SELECT COUNT(*) AS n FROM last_read").get()).toEqual({ n: 1 });
  });

  test("pages sort by reads and filter by bounds over 30 days", () => {
    const { store } = library();
    store.apply(ctx(), [{ op: "write", path: "r.md", content: md("T r", "Rare.\n") }]);
    // Three readers of q (one of them twice: still once that day), one of r.
    for (const r of [agentMcp, agentMcp, otherAgentApi, personApp]) {
      store.reading(r, () => (r === personApp ? store.viewed("q.md") : store.read("q.md")));
    }
    store.reading(agentMcp, () => store.read("r.md"));
    const hot = store.pages({ sort: "reads" });
    expect(hot.items.map((c) => [c.path, "reads" in c ? c.reads : null])).toEqual([
      ["q.md", 3],
      ["r.md", 1],
      ["p.md", 0],
    ]);
    expect(store.pages({ max_reads: 0 }).items.map((c) => c.path)).toEqual(["p.md"]);
    expect(store.pages({ min_reads: 1 }).items.map((c) => c.path)).toEqual(["q.md", "r.md"]);
    expect(store.pages({}).items.every((c) => !("reads" in c))).toBe(true);
  });

  test("reader keys are hashed: no raw person or actor id is stored", () => {
    const agent = readingOf(
      callerOf({ actor: "claude-code/dev", created_by: "user_1", agent: "agt_1" }, "mcp"),
    );
    const session = readingOf(
      callerOf({ id: "session:user_1", actor: "human:dev", created_by: "user_1" }),
    );
    for (const key of [agent.reader, agent.person, session.reader]) {
      expect(key).toMatch(/^[0-9a-f]{32}$/);
    }
    expect(JSON.stringify([agent, session])).not.toMatch(/user_1|agt_1|claude-code|human:/);
    expect(agent).toMatchObject({ surface: "mcp", kind: "agent", reader: readerKey("a:agt_1") });
    // The person an agent acts for is the same key as the person's own session.
    expect(agent.person).toBe(session.reader);
    expect(session).toMatchObject({ surface: "app", kind: "person" });
    // Stored as such.
    const { store, db } = library();
    store.reading(agent, () => store.read("p.md"));
    store.reading(session, () => store.viewed("p.md"));
    store.flushReads();
    const stored = db.query("SELECT actor FROM access_log ORDER BY actor").all() as {
      actor: string;
    }[];
    expect(stored.map((r) => r.actor).sort()).toEqual([agent.reader, session.reader].sort());
  });

  test("the reads line agents read", () => {
    const now = Date.parse("2026-10-20T12:00:00Z");
    expect(agoText("2026-10-20T10:00:00Z", now)).toBe("2 hours ago");
    expect(agoText("2026-10-19T10:00:00Z", now)).toBe("yesterday");
    const h: ReadHistory = {
      week: { total: 12, agents: 9, people: 3, mcp: 9, app: 3, api: 0, readers: 4 },
      month: { total: 40, agents: 30, people: 10, mcp: 30, app: 10, api: 0, readers: 5 },
      last: { mcp: "2026-10-20T10:00:00Z", app: "2026-10-19T10:00:00Z", api: null },
      last_read: "2026-10-20T10:00:00Z",
    };
    expect(readsText(h, now)).toBe(
      "reads: 12 in 7 days (9 by agents, 3 by people · mcp 9, app 3), 40 in 30 days by 5 readers; last read 2 hours ago (mcp), yesterday (app)",
    );
  });
});

type Text = { type: "text"; text: string };

async function connect(app: ReturnType<typeof setup>["app"], token = "writer") {
  const transport = new StreamableHTTPClientTransport(new URL("http://localhost/mcp"), {
    requestInit: { headers: { Authorization: `Bearer ${token}` } },
    fetch: async (url, init) => app.request(url.toString(), init as RequestInit),
  });
  const client = new Client({ name: "test", version: "1.0.0" });
  await client.connect(transport);
  return async (name: string, args: Record<string, unknown> = {}) => {
    const r = await client.callTool({ name, arguments: args });
    return (r.content as Text[]).map((c) => c.text).join("\n");
  };
}

async function seed(s: ReturnType<typeof setup>) {
  for (const path of ["a.md", "b.md"]) {
    const r = await s.req(`/files/${path}`, {
      method: "PUT",
      headers: { "Content-Type": "text/markdown" },
      body: `---\ntype: Note\ntitle: ${path}\n---\nText.\n`,
    });
    expect(r.status).toBe(200);
  }
}

const pageReads = async (s: ReturnType<typeof setup>, token?: string) => {
  const r = token
    ? await s.req("/page/a.md", { token })
    : await s.app.request(`${API}/page/a.md`, { headers: { Accept: "application/json" } });
  expect(r.status).toBe(200);
  return ((await r.json()) as { reads: ReadHistory }).reads;
};

describe("read history over MCP and REST", () => {
  test("MCP read counts as an agent's over MCP and shows the reads line", async () => {
    const s = setup();
    await seed(s);
    const call = await connect(s.app);
    await call("read", { path: "a.md" });
    const second = await call("read", { path: "a.md" });
    // Read twice the same day: one read.
    expect(second).toContain("reads: 1 in 7 days (1 by agents · mcp 1), 1 in 30 days by 1 reader");
    expect(second).toContain("last read just now (mcp)");
    // A person's human: token over MCP is a person, over MCP.
    const mine = await connect(s.app, "human");
    expect(await mine("read", { path: "a.md" })).toContain("(1 by agents, 1 by people · mcp 2)");
    // Never who.
    const line = second.split("\n").find((l) => l.startsWith("reads:")) ?? "";
    expect(line).not.toMatch(/claude-code|human:|agt|user_/);
  });

  test("GET …/page carries reads; a bearer token's read counts as the API's", async () => {
    const s = setup();
    await seed(s);
    const r = await pageReads(s, "writer");
    expect(r.week).toMatchObject({ total: 1, agents: 1, api: 1 });
    expect(r.last.api).not.toBeNull();
    // GET …/files with a token counts too: the same agent again that day adds nothing; another
    // reader adds one.
    await s.req("/files/a.md", { token: "writer" });
    expect((await pageReads(s)).week.api).toBe(1);
    await s.req("/files/a.md", { token: "reader" });
    expect((await pageReads(s)).week).toMatchObject({ total: 2, agents: 2, api: 2, readers: 2 });
  });

  test("a person's app reads count once per page opened, not per prefetch or re-check", async () => {
    const s = setup();
    await seed(s);
    // Prefetches, the boot data and background re-checks are GETs with the session: none count.
    for (let i = 0; i < 6; i++) {
      await s.app.request(`${API}/page/a.md`);
      await s.app.request(`${API}/files/a.md`, { headers: { Accept: "application/json" } });
      await s.app.request(`${API}/page/b.md`);
    }
    expect((await pageReads(s)).month.total).toBe(0);
    // The page shown: one read, a person's in the app.
    const opened = await s.app.request(`${API}/read/a.md`, {
      method: "POST",
      headers: { Origin: ORIGIN },
    });
    expect(opened.status).toBe(200);
    const body = (await opened.json()) as { path: string; reads: ReadHistory };
    expect(body.path).toBe("a.md");
    expect(body.reads.week).toEqual({
      total: 1,
      agents: 0,
      people: 1,
      mcp: 0,
      app: 1,
      api: 0,
      readers: 1,
    });
    expect(body.reads.last.app).not.toBeNull();
    expect((await pageReads(s)).week.app).toBe(1);
    // Opened again the same day: no more reads.
    await s.app.request(`${API}/read/a.md`, { method: "POST", headers: { Origin: ORIGIN } });
    expect((await pageReads(s)).week).toMatchObject({ total: 1, people: 1, app: 1 });
    // Not a ledger event.
    const events = (await (await s.req("/history/a.md")).json()) as { events: { op: string }[] };
    expect(events.events.map((e) => e.op)).toEqual(["put"]);
  });

  test("the app's read route is the app's: no token, no other site", async () => {
    const s = setup();
    await seed(s);
    const token = await s.req("/read/a.md", { method: "POST" });
    expect(token.status).toBe(400);
    expect(await token.text()).toContain("app_only");
    const cross = await s.app.request(`${API}/read/a.md`, {
      method: "POST",
      headers: { Origin: "https://elsewhere.example" },
    });
    expect(cross.status).toBe(403);
    const missing = await s.app.request(`${API}/read/nope.md`, {
      method: "POST",
      headers: { Origin: ORIGIN },
    });
    expect(missing.status).toBe(404);
    expect((await pageReads(s)).month.total).toBe(0);
  });

  test("MCP query finds hot and cold pages", async () => {
    const s = setup();
    await seed(s);
    const call = await connect(s.app);
    await call("read", { path: "b.md" });
    await call("read", { path: "b.md" });
    await (await connect(s.app, "reader"))("read", { path: "b.md" });
    const hot = await call("query", { sort: "reads" });
    expect(hot.indexOf("b.md")).toBeLessThan(hot.indexOf("a.md"));
    // Two readers, one of them twice: two reads.
    expect(hot).toContain("b.md · stable (not set) · unverified · 2 reads in 30 days");
    const cold = await call("query", { max_reads: 0 });
    expect(cold).toContain("1 matching page ");
    expect(cold).toContain("a.md · stable");
  });

  test("MCP show is the person's read, and counts with their own app read once", async () => {
    const s = setup();
    const other = await s.stranger();
    const api = `/api/v1/libraries/${other.user.handle}/demo`;
    const put = await s.anon.request(`${api}/files/x.md`, {
      method: "PUT",
      headers: { Authorization: `Bearer ${other.writer}`, "Content-Type": "text/markdown" },
      body: "---\ntype: Note\ntitle: X\n---\nText.\n",
    });
    expect(put.status).toBe(200);
    const agent = await connect(s.app, other.writer);
    expect(await agent("show", { path: "x.md" })).not.toContain("Error");
    const reads = async () =>
      ((await (await other.app.request(`${api}/page/x.md`)).json()) as { reads: ReadHistory })
        .reads;
    expect((await reads()).week).toMatchObject({ total: 1, agents: 0, people: 1, mcp: 1 });
    await other.app.request(`${api}/read/x.md`, { method: "POST", headers: { Origin: ORIGIN } });
    expect((await reads()).week).toMatchObject({
      total: 1,
      people: 1,
      mcp: 1,
      app: 1,
      readers: 1,
    });
    // The agent's own read is the agent's.
    await agent("read", { path: "x.md" });
    expect((await reads()).week).toMatchObject({ total: 2, agents: 1, people: 1, readers: 2 });
  });
});
