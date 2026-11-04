import { describe, expect, test } from "bun:test";
import { sha256Hex } from "../src/format/hash";
import { API, LIB, OWNER, setup, UI } from "./harness";
import { makePng } from "./images";

/*
 * A session's library request authorizes in one D1 query (TEMPRA-192, `Sessions.access`): the
 * person, the library by name and their membership, joined with every condition the separate
 * lookups had. authorizeLibrary still decides (tenancy.test.ts walks every route).
 */

describe("Sessions.access", () => {
  test("the person, the library and their membership, or what is missing", async () => {
    const s = setup();
    const friend = await s.stranger("friend@example.com");
    const own = await s.sessions.access(s.ownerSession, "owner", "demo");
    expect(own?.user.id).toBe(OWNER.id);
    expect(own?.library).toEqual({ ...LIB, ownerId: OWNER.id });
    expect(own?.memberRole).toBeNull();
    // Someone else's library: found, with no membership until it is shared.
    const theirs = s.sessionFor(friend.user.id);
    expect((await s.sessions.access(theirs, "owner", "demo"))?.memberRole).toBeNull();
    await s.accounts.share(LIB.id, friend.user.id, "read", OWNER.id);
    expect((await s.sessions.access(theirs, "owner", "demo"))?.memberRole).toBe("read");
    // No such library, or an owner who is not there: the person, and no library.
    const none = await s.sessions.access(s.ownerSession, "owner", "nope");
    expect(none?.user.id).toBe(OWNER.id);
    expect(none?.library).toBeNull();
    expect((await s.sessions.access(s.ownerSession, "nobody", "demo"))?.library).toBeNull();
  });

  test("a removed member, a suspended person or owner, an expired or idle session", async () => {
    const s = setup();
    const friend = await s.stranger("friend@example.com");
    const theirs = s.sessionFor(friend.user.id);
    await s.accounts.share(LIB.id, friend.user.id, "write", OWNER.id);
    await s.accounts.unshare(LIB.id, friend.user.id);
    expect((await s.sessions.access(theirs, "owner", "demo"))?.memberRole).toBeNull();

    // The library's owner suspended: no library by that name.
    s.db.run("UPDATE users SET suspended = ? WHERE id = ?", [new Date().toISOString(), OWNER.id]);
    expect((await s.sessions.access(theirs, "owner", "demo"))?.library).toBeNull();
    // The person suspended: no session at all.
    expect(await s.sessions.access(s.ownerSession, "owner", "demo")).toBeNull();
    s.db.run("UPDATE users SET suspended = NULL WHERE id = ?", [OWNER.id]);

    const past = new Date(Date.now() - 60_000).toISOString();
    const later = new Date(Date.now() + 86_400_000).toISOString();
    const cases: [name: string, idle: string, expires: string][] = [
      ["expired", later, past],
      ["idle", past, later],
    ];
    for (const [name, idle, expires] of cases) {
      s.db.run(
        "INSERT INTO sessions (hash, user, created, last_seen, idle_expires, expires) VALUES (?, ?, ?, ?, ?, ?)",
        [sha256Hex(name), OWNER.id, past, past, idle, expires],
      );
      expect(await s.sessions.access(name, "owner", "demo")).toBeNull();
    }
  });
});

describe("a session's library request", () => {
  test("one D1 query before the library, for the owner and for a member", async () => {
    const s = setup();
    s.queries.length = 0;
    expect((await s.app.request(`${API}/stats`)).status).toBe(200);
    expect(s.queries).toHaveLength(1);
    const friend = await s.stranger("friend@example.com");
    await s.accounts.share(LIB.id, friend.user.id, "read", OWNER.id);
    s.queries.length = 0;
    expect((await friend.app.request(`${API}/stats`)).status).toBe(200);
    expect(s.queries).toHaveLength(1);
  });

  test("access ends at once: a removed member, a signed-out session", async () => {
    const s = setup();
    const friend = await s.stranger("friend@example.com");
    await s.accounts.share(LIB.id, friend.user.id, "read", OWNER.id);
    expect((await friend.app.request(`${API}/stats`)).status).toBe(200);
    await s.accounts.unshare(LIB.id, friend.user.id);
    expect((await friend.app.request(`${API}/stats`)).status).toBe(404);
    await s.sessions.end(s.ownerSession);
    expect((await s.app.request(`${API}/stats`)).status).toBe(401);
  });
});

describe("a session's library page, image or download (TEMPRA-201)", () => {
  const PNG = makePng(64, 32);
  const HASH = new Bun.CryptoHasher("sha256").update(PNG).digest("hex");
  async function withFiles() {
    const s = setup();
    await s.req("/files/notes/a.md", {
      method: "PUT",
      body: "---\ntype: Note\n---\nA.\n",
      headers: { "Content-Type": "text/markdown" },
    });
    await s.req("/files/img/a.png", {
      method: "PUT",
      headers: { "Content-Type": "image/png" },
      body: PNG as unknown as BodyInit,
    });
    return s;
  }

  test("one D1 query before the library, for the owner and for a member", async () => {
    const s = await withFiles();
    const friend = await s.stranger("friend@example.com");
    await s.accounts.share(LIB.id, friend.user.id, "read", OWNER.id);
    for (const who of [s.app, friend.app]) {
      for (const path of [`${UI}/-/raw/notes/a.md`, `${UI}/-/image/${HASH}`]) {
        s.queries.length = 0;
        expect((await who.request(path)).status).toBe(200);
        expect(s.queries).toHaveLength(1);
      }
    }
  });

  test("a stranger and a removed member are told nothing; no session goes to sign-in", async () => {
    const s = await withFiles();
    const image = `${UI}/-/image/${HASH}`;
    const stranger = await s.stranger("stranger@example.com");
    expect((await stranger.app.request(image)).status).toBe(404);
    const friend = await s.stranger("friend@example.com");
    await s.accounts.share(LIB.id, friend.user.id, "read", OWNER.id);
    expect((await friend.app.request(image)).status).toBe(200);
    await s.accounts.unshare(LIB.id, friend.user.id);
    expect((await friend.app.request(image)).status).toBe(404);
    const anon = await s.anon.request(image);
    expect(anon.status).toBe(302);
    expect(anon.headers.get("Location")).toStartWith("/sign-in?next=");
  });
});
