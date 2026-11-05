import { describe, expect, test } from "bun:test";
import { d1Accounts } from "../src/accounts";
import { d1BlobRefs } from "../src/blobrefs";
import { healthDigest } from "../src/library-health";
import { d1Sessions } from "../src/session";
import { digestText, pruneAccounts, sweep } from "../src/sweep";
import { bunD1 } from "./d1";
import { memoryBucket } from "./harness";

const DAY = 86_400_000;

/** The query plan's lines, as `EXPLAIN QUERY PLAN` prints them. */
function plan(db: ReturnType<typeof bunD1>["db"], sql: string): string[] {
  return (db.query(`EXPLAIN QUERY PLAN ${sql}`).all() as { detail: string }[]).map((r) => r.detail);
}

/** A full scan of a table: `SCAN t`, not `SCAN t USING … INDEX` or a constant row. */
const scans = (lines: string[]) =>
  lines.filter((l) => /^SCAN /.test(l) && !/USING|CONSTANT/.test(l));

const MINTED_BY = `(created_by = ?1 OR (created_by IS NULL AND library IN (SELECT id FROM libraries WHERE owner = ?1)))`;

describe("D1 indexes (TEMPRA-78)", () => {
  const { db } = bunD1();
  // Every query the issue names, and those added with Sharing and Notifications that filter or
  // join on a column other than a primary key.
  const queries = {
    libraryByDoId: "SELECT 1 AS ok FROM libraries WHERE do_id = ?",
    // A session's library request, in one query (TEMPRA-192, `Sessions.access`).
    "a session's library access": `SELECT s.hash, u.id, l.id AS lib_id, o.id AS lib_owner_id, m.role
      FROM sessions s JOIN users u ON u.id = s.user
      LEFT JOIN users o ON o.handle = ?3 AND o.suspended IS NULL
      LEFT JOIN libraries l ON l.owner = o.id AND l.slug = ?4
      LEFT JOIN library_members m ON m.library = l.id AND m.user = u.id
      WHERE s.hash = ?1 AND s.idle_expires > ?2 AND s.expires > ?2 AND u.suspended IS NULL`,
    "token count": `SELECT COUNT(*) FROM tokens WHERE revoked IS NULL AND (expires IS NULL OR expires > ?2) AND ${MINTED_BY}`,
    "account's tokens": `SELECT t.id FROM tokens t JOIN libraries l ON l.id = t.library
      JOIN users o ON o.id = l.owner LEFT JOIN users u ON u.id = t.created_by
      WHERE t.rowid IN (SELECT t2.rowid FROM tokens t2 JOIN libraries l2 ON l2.id = t2.library WHERE l2.owner = ?1
        UNION SELECT rowid FROM tokens WHERE created_by = ?1) ORDER BY t.rowid DESC`,
    "sign-in rate limit": `SELECT (SELECT COUNT(*) FROM sign_in_links
      WHERE email = ?1 AND created > ?2 AND purpose <> 'invitation') AS by_email,
      (SELECT COUNT(*) FROM sign_in_links WHERE ip = ?3 AND created > ?2) AS by_ip`,
    "sign-in code": `UPDATE sign_in_links SET used = ?1 WHERE email = ?2 AND purpose = 'sign-in'
      AND used IS NULL AND expires > ?1 AND code_hash IS NOT NULL AND tries < ?3 AND code_hash = ?4`,
    "sign-in code tries": `UPDATE sign_in_links SET tries = tries + 1 WHERE email = ?2
      AND purpose = 'sign-in' AND used IS NULL AND expires > ?1 AND code_hash IS NOT NULL`,
    "prune links":
      "DELETE FROM sign_in_links WHERE rowid IN (SELECT rowid FROM sign_in_links WHERE created < ?1 AND (purpose <> 'invitation' OR expires < ?2) LIMIT 1000)",
    "prune sessions":
      "DELETE FROM sessions WHERE rowid IN (SELECT rowid FROM sessions WHERE idle_expires <= ?1 LIMIT 1000)",
    "delete a library (foreign keys)": "DELETE FROM libraries WHERE id = ?",
    "delete a library's notifications": "DELETE FROM notifications WHERE library = ?",
    "delete a library's cursors": "DELETE FROM library_seen WHERE library = ?",
    "delete a library's mail settings": "DELETE FROM notification_prefs WHERE library = ?",
    "shared libraries": `SELECT l.id FROM library_members m JOIN libraries l ON l.id = m.library
      JOIN users u ON u.id = l.owner WHERE m.user = ?1`,
    members: `SELECT m.user, u.handle FROM library_members m JOIN users u ON u.id = m.user
      WHERE m.library = ? ORDER BY u.handle`,
    agents: "SELECT a.id FROM agents a JOIN users u ON u.id = a.user WHERE a.id IN (?, ?)",
    "a person's invitations": `SELECT i.id FROM library_invitations i JOIN libraries l ON l.id = i.library
      JOIN users o ON o.id = l.owner WHERE i.user = ? AND i.status = 'pending' AND i.expires > ?`,
    "a library's invitations": `SELECT i.id FROM library_invitations i JOIN libraries l ON l.id = i.library
      WHERE i.library = ? AND i.status = 'pending' AND i.expires > ? ORDER BY i.created DESC`,
    inbox:
      "SELECT id FROM notifications WHERE user = ? AND done_at IS NULL ORDER BY rowid DESC LIMIT ?",
    "mail settings": "SELECT library, immediate, digest FROM notification_prefs WHERE user = ?",
    "a connection's created libraries":
      "SELECT library FROM grant_libraries WHERE grant_id = ? AND user = ?",
    "delete a library's connection rows": "DELETE FROM grant_libraries WHERE library = ?",
    "delete an account's connection rows": "DELETE FROM grant_libraries WHERE user = ?",
    // The blob sweep (TEMPRA-81, TEMPRA-91): what a normal day runs.
    "sweep: libraries holding deletion": `SELECT COUNT(*) FROM blob_ref_libraries s
      JOIN libraries l ON l.do_id = s.library WHERE s.counted IS NULL OR s.pending IS NOT NULL`,
    "sweep: open libraries to recount": `SELECT library, pending FROM blob_ref_libraries
      WHERE (counted IS NULL OR pending IS NOT NULL) AND library > ? ORDER BY library LIMIT ?`,
    "sweep: expired orphans": `SELECT o.hash FROM blob_orphans o WHERE o.since <= ?
      AND NOT EXISTS (SELECT 1 FROM blob_refs r WHERE r.hash = o.hash) ORDER BY o.since LIMIT ?`,
    "sweep: a library's references": "SELECT hash, added FROM blob_refs WHERE library = ?",
    "sweep: full dispatch page": `SELECT l.do_id AS library, s.pending FROM libraries l
      LEFT JOIN blob_ref_libraries s ON s.library = l.do_id WHERE l.do_id > ? ORDER BY l.do_id LIMIT ?`,
  };
  for (const [name, sql] of Object.entries(queries)) {
    test(`${name} scans no table`, () => {
      expect(scans(plan(db, sql))).toEqual([]);
    });
  }

  test("the indexes the issue names exist", () => {
    expect(plan(db, queries.libraryByDoId).join()).toContain("libraries_do_id");
    expect(plan(db, queries["sign-in rate limit"]).join()).toContain("sign_in_links_ip");
    expect(plan(db, queries["prune links"]).join()).toContain("sign_in_links_created");
    expect(plan(db, queries["token count"]).join()).toContain("tokens_created_by");
    expect(plan(db, queries["token count"]).join()).toContain("tokens_library");
  });

  test("do_id is unique", () => {
    db.run("INSERT INTO users (id, email, actor, handle) VALUES ('u1', 'a@x', 'human:a', 'a')");
    db.run(
      "INSERT INTO libraries (id, slug, owner, visibility, do_id) VALUES ('l1', 'one', 'u1', 'private', 'l1')",
    );
    expect(() =>
      db.run(
        "INSERT INTO libraries (id, slug, owner, visibility, do_id) VALUES ('l2', 'two', 'u1', 'private', 'l1')",
      ),
    ).toThrow();
  });
});

describe("the account's tokens (union over owner and minter)", () => {
  test("lists tokens on owned libraries and those minted on shared ones, newest first", async () => {
    const { d1, db } = bunD1();
    db.run(
      "INSERT INTO users (id, email, actor, handle) VALUES ('ann', 'ann@x', 'human:ann', 'ann')",
    );
    db.run(
      "INSERT INTO users (id, email, actor, handle) VALUES ('bob', 'bob@x', 'human:bob', 'bob')",
    );
    const accounts = d1Accounts(d1);
    const annLib = await accounts.createLibrary("notes", { id: "ann", handle: "ann" });
    const bobLib = await accounts.createLibrary("plans", { id: "bob", handle: "bob" });
    const t = { scope: "write" as const, prefix: null, expires: null, mcpTiers: "all" as const };
    const mine = await accounts.createToken({
      ...t,
      libraryId: annLib.id,
      actor: "cli/ann",
      createdBy: "ann",
    });
    const bobs = await accounts.createToken({
      ...t,
      libraryId: annLib.id,
      actor: "cli/bob",
      createdBy: "bob",
    });
    const onShared = await accounts.createToken({
      ...t,
      libraryId: bobLib.id,
      actor: "cli/ann2",
      createdBy: "ann",
    });
    await accounts.createToken({ ...t, libraryId: bobLib.id, actor: "cli/bob2", createdBy: "bob" });
    const ids = (await accounts.tokens("ann")).map((r) => r.id);
    expect(ids).toEqual([onShared.id, bobs.id, mine.id]);
    expect((await accounts.tokens("ann")).find((r) => r.id === onShared.id)?.library).toBe(
      "bob/plans",
    );
  });
});

describe("daily account prune (TEMPRA-79)", () => {
  const NOW = new Date("2026-10-11T04:30:00Z");
  const iso = (ms: number) => new Date(NOW.getTime() + ms).toISOString();

  function seeded() {
    const { d1, db } = bunD1();
    db.run("INSERT INTO users (id, email, actor, handle) VALUES ('u1', 'a@x', 'human:a', 'a')");
    for (const u of ["u2", "u3", "u4"]) {
      db.run("INSERT INTO users (id, email, actor, handle) VALUES (?, ?, ?, ?)", [
        u,
        `${u}@x`,
        `human:${u}`,
        u,
      ]);
    }
    db.run(
      "INSERT INTO libraries (id, slug, owner, visibility, do_id) VALUES ('l1', 'one', 'u1', 'private', 'l1')",
    );
    const session = (hash: string, idle: number, max: number) =>
      db.run(
        "INSERT INTO sessions (hash, user, created, last_seen, idle_expires, expires) VALUES (?, 'u1', ?, ?, ?, ?)",
        [hash, iso(-DAY), iso(-DAY), iso(idle), iso(max)],
      );
    session("live", 10 * DAY, 60 * DAY);
    session("idle", -DAY, 60 * DAY);
    session("old", -2 * DAY, -2 * DAY);
    const link = (hash: string, created: number) =>
      db.run(
        "INSERT INTO sign_in_links (hash, email, created, expires, purpose) VALUES (?, 'a@x', ?, ?, 'sign-in')",
        [hash, iso(created), iso(created + 900_000)],
      );
    link("fresh", -3_600_000);
    link("stale", -DAY - 60_000);
    // Invitation links (TEMPRA-287) are kept until 30 days past their 7-day expiry.
    const invitationLink = (hash: string, created: number) =>
      db.run(
        "INSERT INTO sign_in_links (hash, email, created, expires, purpose) VALUES (?, 'a@x', ?, ?, 'invitation')",
        [hash, iso(created), iso(created + 7 * DAY)],
      );
    invitationLink("invited-lately", -20 * DAY);
    invitationLink("invited-long-ago", -40 * DAY);
    const invitation = (
      id: string,
      status: string,
      created: number,
      expires: number,
      decided: number | null,
      user = "u2",
    ) =>
      db.run(
        "INSERT INTO library_invitations (id, library, user, role, invited_by, created, expires, status, decided) VALUES (?, 'l1', ?, 'read', 'u1', ?, ?, ?, ?)",
        [id, user, iso(created), iso(expires), status, decided === null ? null : iso(decided)],
      );
    // At most one pending invitation per person per library.
    invitation("pending", "pending", -DAY, 13 * DAY, null);
    invitation("expired-long-ago", "pending", -60 * DAY, -46 * DAY, null, "u3");
    invitation("expired-lately", "pending", -20 * DAY, -6 * DAY, null, "u4");
    invitation("declined-long-ago", "declined", -60 * DAY, -46 * DAY, -59 * DAY);
    invitation("revoked-long-ago", "revoked", -60 * DAY, -46 * DAY, -59 * DAY);
    invitation("declined-lately", "declined", -3 * DAY, 11 * DAY, -2 * DAY);
    invitation("accepted-long-ago", "accepted", -60 * DAY, -46 * DAY, -59 * DAY);
    return { d1, db };
  }

  test("deletes expired sessions, links older than a day and old finished invitations", async () => {
    const { d1, db } = seeded();
    const r = await pruneAccounts(d1, NOW);
    expect(r).toEqual({ sessions: 2, sign_in_links: 2, invitations: 3, mail_sent: 0 });
    const col = (sql: string) => (db.query(sql).all() as { k: string }[]).map((x) => x.k).sort();
    expect(col("SELECT hash AS k FROM sessions")).toEqual(["live"]);
    expect(col("SELECT hash AS k FROM sign_in_links")).toEqual(["fresh", "invited-lately"]);
    expect(col("SELECT id AS k FROM library_invitations")).toEqual([
      "accepted-long-ago",
      "declined-lately",
      "expired-lately",
      "pending",
    ]);
    // Again: nothing left to do.
    expect(await pruneAccounts(d1, NOW)).toEqual({
      sessions: 0,
      sign_in_links: 0,
      invitations: 0,
      mail_sent: 0,
    });
  });

  test("deletes in batches of a thousand until done", async () => {
    const { d1, db } = bunD1();
    const insert = db.prepare(
      "INSERT INTO sign_in_links (hash, email, created, expires, purpose) VALUES (?, 'a@x', ?, ?, 'sign-in')",
    );
    db.transaction(() => {
      for (let i = 0; i < 2500; i++) insert.run(`h${i}`, iso(-2 * DAY), iso(-2 * DAY));
    })();
    expect((await pruneAccounts(d1, NOW)).sign_in_links).toBe(2500);
    expect(db.query("SELECT COUNT(*) AS n FROM sign_in_links").get()).toEqual({ n: 0 });
  });

  test("creating a sign-in link no longer deletes old ones", async () => {
    const { d1, db } = seeded();
    const sessions = d1Sessions(d1, () => NOW.getTime());
    expect(await sessions.createLink("c@x", "1.2.3.4")).toBeString();
    expect(db.query("SELECT COUNT(*) AS n FROM sign_in_links").get()).toEqual({ n: 5 });
  });

  test("the sweep runs it and the digest reports its counts", async () => {
    const { d1 } = seeded();
    const bucket = memoryBucket();
    const r = await sweep({
      refs: d1BlobRefs(d1),
      queue: { send: async () => {}, sendBatch: async () => {} },
      health: (t) => healthDigest(d1, t),
      bucket: { delete: (keys) => bucket.delete(keys) },
      prune: () => pruneAccounts(d1, NOW),
      now: NOW,
    });
    expect(r.pruned).toEqual({ sessions: 2, sign_in_links: 2, invitations: 3, mail_sent: 0 });
    expect(digestText(r)).toContain(
      "Pruned sessions 2, sign-in links 2, invitations 3, sent mail keys 0.",
    );
  });

  test("a failed prune is something to look at, and the sweep goes on", async () => {
    const { d1 } = bunD1();
    const bucket = memoryBucket();
    const r = await sweep({
      refs: d1BlobRefs(d1),
      queue: { send: async () => {}, sendBatch: async () => {} },
      health: (t) => healthDigest(d1, t),
      bucket: { delete: (keys) => bucket.delete(keys) },
      prune: async () => {
        throw new Error("D1 busy");
      },
      now: NOW,
    });
    expect(r.pruned).toBeUndefined();
    expect(r.attention).toContain("Account prune failed: D1 busy");
    expect(digestText(r)).not.toContain("Pruned");
  });
});
