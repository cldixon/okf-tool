import { describe, expect, test } from "bun:test";
import { AuthCache, TtlCache } from "../src/authcache";
import { sha256Hex } from "../src/format/hash";
import { d1Sessions } from "../src/session";
import { bunD1 } from "./d1";
import { API, LIB, ORIGIN, OWNER, setup } from "./harness";
import { approve, connectApp } from "./oauth-flow";

/*
 * TEMPRA-84: what authorization reads from D1 is kept per isolate for up to 30 s (tempra-dev:
 * v2/tenancy, Caching), dropped at once by a change this isolate makes, never served past its
 * window and never to another session or account.
 */

describe("TtlCache", () => {
  test("expires, evicts the oldest past its size, and drops by tag", () => {
    let t = 0;
    const c = new TtlCache<number>(2, () => t);
    c.set("a", 1, 100, ["x"]);
    c.set("b", 2, 100, ["y"]);
    expect(c.get("a")).toBe(1);
    c.set("c", 3, 100, ["y"]);
    // "a" was set first, so it goes first, whatever was read since.
    expect(c.get("a")).toBeUndefined();
    expect(c.size).toBe(2);
    c.drop(["y"]);
    expect(c.size).toBe(0);
    c.set("d", 4, 100);
    t = 99;
    expect(c.get("d")).toBe(4);
    t = 100;
    expect(c.get("d")).toBeUndefined();
    c.set("e", 5, 0);
    expect(c.get("e")).toBeUndefined();
  });

  test("never keeps an answer read before a drop", () => {
    const c = new TtlCache<number>();
    // A read starts, a change here drops its tag, then the read's answer arrives: not kept.
    const since = c.drops;
    c.drop(["u:1"]);
    c.set("a", 1, 100, ["u:1"], since);
    expect(c.get("a")).toBeUndefined();
    c.set("a", 1, 100, ["u:1"], c.drops);
    expect(c.get("a")).toBe(1);
  });
});

describe("a warm isolate", () => {
  test("serves a session's library requests and its library page with no D1 query", async () => {
    const s = setup({ authCache: true });
    expect((await s.app.request(`${API}/stats`)).status).toBe(200);
    s.queries.length = 0;
    expect((await s.app.request(`${API}/stats`)).status).toBe(200);
    expect((await s.app.request(`${API}/files/index.md`)).status).toBe(200);
    expect(s.queries).toEqual([]);
    // Signed in with no library named: the person alone, kept too.
    expect((await s.app.request("/api/v1/me")).status).toBe(200);
    s.queries.length = 0;
    expect((await s.app.request("/api/v1/me")).status).toBe(200);
    expect(s.queries.filter((q) => /FROM sessions/.test(q))).toEqual([]);
  });

  test("serves a token's request with no D1 query", async () => {
    const s = setup({ authCache: true });
    const friend = await s.stranger("friend@example.com");
    const stats = () =>
      s.anon.request("/api/v1/libraries/friend/demo/stats", {
        headers: { Authorization: `Bearer ${friend.writer}` },
      });
    expect((await stats()).status).toBe(200);
    s.queries.length = 0;
    expect((await stats()).status).toBe(200);
    expect(s.queries).toEqual([]);
  });

  test("serves an app connection with no D1 query for what it reaches", async () => {
    const s = setup({ authCache: true });
    const { call } = await connectApp(s.app, { ...approve, libraries: "all", library: "" });
    expect((await call("start", { library: "owner/demo" })).isError).toBe(false);
    s.queries.length = 0;
    expect((await call("start", { library: "owner/demo" })).isError).toBe(false);
    // (The library's title, which `start` shows, is content, not authorization.)
    expect(s.queries.filter((q) => /FROM users|library_members|grant_libraries/.test(q))).toEqual(
      [],
    );
  });

  test("a change made here applies at once: a library made or deleted, for a connection", async () => {
    const s = setup({ authCache: true });
    const { call } = await connectApp(s.app, { ...approve, libraries: "all", library: "" });
    expect((await call("start", {})).text).not.toContain("owner/recipes");
    const made = await s.accounts.createLibrary("recipes", { id: OWNER.id, handle: "owner" });
    expect((await call("start", {})).text).toContain("owner/recipes");
    await s.accounts.deleteLibrary(made.id);
    expect((await call("start", { library: "owner/recipes" })).isError).toBe(true);
  });

  test("a change made here applies at once: removal, a lower role, sign-out", async () => {
    const s = setup({ authCache: true });
    const friend = await s.stranger("friend@example.com");
    await s.accounts.share(LIB.id, friend.user.id, "write", OWNER.id);
    const put = () =>
      friend.app.request(`${API}/files/notes/a.md`, {
        method: "PUT",
        headers: { Origin: ORIGIN, "Content-Type": "text/markdown" },
        body: "---\ntype: Note\n---\nA.\n",
      });
    expect((await put()).status).toBe(200);
    // Lowered to read: the next write is refused, though the write was just let in.
    await s.accounts.share(LIB.id, friend.user.id, "read", OWNER.id);
    expect((await put()).status).toBe(403);
    expect((await friend.app.request(`${API}/stats`)).status).toBe(200);
    await s.accounts.unshare(LIB.id, friend.user.id);
    expect((await friend.app.request(`${API}/stats`)).status).toBe(404);

    expect((await s.app.request(`${API}/stats`)).status).toBe(200);
    const out = await s.app.request("/sign-out", { method: "POST", headers: { Origin: ORIGIN } });
    expect(out.status).toBe(303);
    expect((await s.app.request(`${API}/stats`)).status).toBe(401);
  });

  test("a member's token stops at once when the member is removed here", async () => {
    const s = setup({ authCache: true });
    const friend = await s.stranger("friend@example.com");
    await s.accounts.share(LIB.id, friend.user.id, "write", OWNER.id);
    const minted = await s.accounts.createToken({
      libraryId: LIB.id,
      actor: "claude-code/friend",
      scope: "write",
      prefix: null,
      expires: null,
      mcpTiers: "all",
      createdBy: friend.user.id,
    });
    const stats = () =>
      s.anon.request(`${API}/stats`, { headers: { Authorization: `Bearer ${minted.secret}` } });
    expect((await stats()).status).toBe(200);
    await s.accounts.unshare(LIB.id, friend.user.id);
    expect((await stats()).status).toBe(401);
  });
});

describe("another isolate's change", () => {
  /** A deployment's sessions over a clock the test moves, with an owner, a library and a member. */
  function world() {
    const { d1, db } = bunD1();
    let t = Date.parse("2026-10-31T12:00:00Z");
    const now = () => t;
    const sessions = d1Sessions(d1, now, new AuthCache({ now }));
    const iso = (ms: number) => new Date(ms).toISOString();
    const user = (id: string, handle: string) =>
      db.run("INSERT INTO users (id, email, actor, handle, created) VALUES (?, ?, ?, ?, ?)", [
        id,
        `${handle}@example.com`,
        `human:${handle}`,
        handle,
        iso(t),
      ]);
    user("u_owner", "owner");
    user("u_member", "member");
    user("u_other", "other");
    db.run(
      "INSERT INTO libraries (id, slug, owner, visibility, created, do_id) VALUES ('lib', 'demo', 'u_owner', 'private', ?, 'lib')",
      [iso(t)],
    );
    db.run(
      "INSERT INTO library_members (library, user, role, granted_by, created) VALUES ('lib', 'u_member', 'write', 'u_owner', ?)",
      [iso(t)],
    );
    const session = (who: string, expires = t + 86_400_000) => {
      const secret = `s-${who}-${crypto.randomUUID()}`;
      db.run(
        "INSERT INTO sessions (hash, user, created, last_seen, idle_expires, expires) VALUES (?, ?, ?, ?, ?, ?)",
        [sha256Hex(secret), who, iso(t), iso(t), iso(expires), iso(expires)],
      );
      return secret;
    };
    return {
      db,
      sessions,
      session,
      advance: (ms: number) => {
        t += ms;
      },
    };
  }

  test("is served for at most 30 s: a suspension, a removal, a deleted session", async () => {
    const w = world();
    const owner = w.session("u_owner");
    const member = w.session("u_member");
    expect((await w.sessions.access(owner, "owner", "demo"))?.library?.id).toBe("lib");
    expect((await w.sessions.access(member, "owner", "demo"))?.memberRole).toBe("write");
    // Changed elsewhere (another isolate, or the operator's CLI): this isolate does not know.
    w.db.run("UPDATE users SET suspended = 'x' WHERE id = 'u_owner'");
    w.db.run("DELETE FROM library_members WHERE user = 'u_member'");
    w.advance(29_999);
    expect(await w.sessions.access(owner, "owner", "demo")).not.toBeNull();
    expect((await w.sessions.access(member, "owner", "demo"))?.memberRole).toBe("write");
    w.advance(1);
    expect(await w.sessions.access(owner, "owner", "demo")).toBeNull();
    expect((await w.sessions.access(member, "owner", "demo"))?.memberRole).toBeNull();
  });

  test("never outlives the session, nor reaches another session or account", async () => {
    const w = world();
    const short = w.session("u_member", Date.parse("2026-10-31T12:00:10Z"));
    expect((await w.sessions.access(short, "owner", "demo"))?.memberRole).toBe("write");
    w.advance(10_000);
    expect(await w.sessions.access(short, "owner", "demo")).toBeNull();

    const owner = w.session("u_owner");
    expect((await w.sessions.access(owner, "owner", "demo"))?.user.id).toBe("u_owner");
    const other = w.session("u_other");
    const theirs = await w.sessions.access(other, "owner", "demo");
    expect(theirs?.user.id).toBe("u_other");
    expect(theirs?.memberRole).toBeNull();
    // A denial is not kept: sharing it elsewhere lets them in on the next request.
    w.db.run(
      "INSERT INTO library_members (library, user, role, granted_by, created) VALUES ('lib', 'u_other', 'read', 'u_owner', 'x')",
    );
    expect((await w.sessions.access(other, "owner", "demo"))?.memberRole).toBe("read");
    expect(await w.sessions.access("not-a-session", "owner", "demo")).toBeNull();
  });
});

describe("GET …/agents", () => {
  test("names every person in one query", async () => {
    const s = setup();
    const friend = await s.stranger("friend@example.com");
    await s.accounts.share(LIB.id, friend.user.id, "write", OWNER.id);
    const minted = await s.accounts.createToken({
      libraryId: LIB.id,
      actor: "claude-code/friend",
      scope: "write",
      prefix: null,
      expires: null,
      mcpTiers: "all",
      createdBy: friend.user.id,
    });
    const note = { method: "PUT", body: "---\ntype: Note\n---\nA.\n" };
    const headers = { "Content-Type": "text/markdown" };
    const byFriend = await s.req("/files/notes/a.md", { ...note, headers, token: minted.secret });
    expect(byFriend.status).toBe(200);
    const byOwner = await s.app.request(`${API}/files/notes/b.md`, {
      ...note,
      headers: { ...headers, Origin: ORIGIN },
    });
    expect(byOwner.status).toBe(200);
    s.queries.length = 0;
    const r = await s.app.request(`${API}/agents`);
    expect(r.status).toBe(200);
    const body = (await r.json()) as { contributors: { person: string | null }[] };
    expect(new Set(body.contributors.map((c) => c.person))).toEqual(new Set(["owner", "friend"]));
    expect(s.queries.filter((q) => /FROM users/.test(q) && !/sessions/.test(q))).toHaveLength(1);
  });
});
