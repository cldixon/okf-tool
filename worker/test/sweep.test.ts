import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { d1BlobRefs, RECOUNT_MARGIN_MS } from "../src/blobrefs";
import { healthDigest, healthRow, writeHealth } from "../src/library-health";
import { MAX_SLEEP_DAYS, nextMaintenance, runMaintenance } from "../src/maintain";
import { LibraryStore } from "../src/store/store";
import {
  DISPATCH_PAGE,
  digestText,
  FULL_RECOUNT_DAYS,
  GRACE_DAYS,
  handleSweepMessage,
  isSweepMessage,
  type SweepMessage,
  sweep,
} from "../src/sweep";
import { bunD1 } from "./d1";
import { memoryBucket, setup } from "./harness";
import { bunSqlHandle } from "./sqlite";

const DAY = 86_400_000;
const T0 = new Date("2026-10-01T04:30:00Z");
const at = (days: number) => new Date(T0.getTime() + days * DAY);

/**
 * Libraries in D1, each with the hashes its Durable Object would report (or an error), a bucket,
 * and a queue whose messages `drain` hands to the consumer, as Cloudflare Queues would.
 */
function world() {
  const { d1, db } = bunD1();
  const refs = d1BlobRefs(d1);
  db.run(
    "INSERT INTO users (id, email, actor, handle, created) VALUES ('u', 'u@x', 'human:o', 'o', '')",
  );
  const libs = new Map<string, string[] | Error>();
  const objects = new Map<string, Date>();
  const queued: SweepMessage[] = [];
  const queue = {
    send: async (m: SweepMessage) => {
      queued.push(m);
    },
    sendBatch: async (ms: SweepMessage[]) => {
      if (ms.length > 100) throw new Error("sendBatch takes at most 100 messages");
      queued.push(...ms);
    },
  };
  const calls = { hashes: 0, deleted: [] as string[] };
  let clock = T0;
  /** A library row; `counted` as a library made by today's code is, or not as one from before. */
  const addLibrary = (id: string, hashes: string[] | Error, counted = false) => {
    db.run(
      "INSERT INTO libraries (id, slug, owner, visibility, created, do_id) VALUES (?, ?, 'u', 'private', '', ?)",
      [id, id, id],
    );
    if (counted) {
      db.run("INSERT INTO blob_ref_libraries (library, counted) VALUES (?, ?)", [
        id,
        clock.toISOString(),
      ]);
    }
    libs.set(id, hashes);
  };
  /** Bytes put in R2 by today's code: recorded first. */
  const upload = async (hash: string) => {
    await refs.stored(hash, clock);
    objects.set(`blobs/${hash}`, clock);
  };
  const consumer = {
    refs,
    queue,
    libraryHashes: async (id: string) => {
      calls.hashes++;
      const v = libs.get(id);
      if (v instanceof Error) throw v;
      return v ?? [];
    },
    bucket: {
      list: async (o: { prefix: string; cursor?: string; limit: number }) => {
        const keys = [...objects.keys()].filter((k) => k.startsWith(o.prefix)).sort();
        const start = Number(o.cursor ?? 0);
        const page = keys.slice(start, start + o.limit);
        const truncated = start + o.limit < keys.length;
        return {
          objects: page.map((key) => ({ key, uploaded: objects.get(key) as Date })),
          truncated,
          ...(truncated ? { cursor: String(start + o.limit) } : {}),
        };
      },
    },
    now: () => clock,
  };
  /** Runs every queued message (and what they queue), retrying failures as the queue would. */
  const drain = async () => {
    const failed: SweepMessage[] = [];
    for (let i = 0; i < 10_000 && queued.length > 0; i++) {
      const m = queued.shift() as SweepMessage;
      try {
        await handleSweepMessage(m, consumer);
      } catch {
        failed.push(m);
      }
    }
    return failed;
  };
  const cron = (now: Date) => {
    clock = now;
    return sweep({
      refs,
      queue,
      bucket: {
        delete: async (keys) => {
          for (const k of keys) {
            objects.delete(k);
            calls.deleted.push(k);
          }
        },
      },
      health: (t) => healthDigest(d1, t),
      now,
    });
  };
  /** The cron, then everything it queued. */
  const day = async (now: Date) => {
    const r = await cron(now);
    await drain();
    return r;
  };
  const setClock = (d: Date) => {
    clock = d;
  };
  return {
    d1,
    db,
    refs,
    libs,
    objects,
    queued,
    calls,
    addLibrary,
    upload,
    drain,
    cron,
    day,
    setClock,
  };
}

describe("blob sweep (TEMPRA-81, TEMPRA-91)", () => {
  test("a blob nobody references goes after 31 days unreferenced, not before", async () => {
    const w = world();
    w.addLibrary("a", ["kept", "shared"], true);
    w.addLibrary("b", ["shared"], true);
    for (const h of ["kept", "shared", "orphan"]) await w.upload(h);
    await w.refs.reference("a", ["kept", "shared"], T0);
    await w.refs.reference("b", ["shared"], T0);

    const first = await w.day(T0);
    expect(first).toMatchObject({ stored: 3, referenced: 2, orphaned: 1, deleted: 0 });
    // The very first run waits for its own full pass to have reached every library.
    expect(first.held).toBe("the first count of every library has not finished");
    expect((await w.day(at(1))).held).toBeUndefined();

    expect((await w.day(at(GRACE_DAYS - 1))).deleted).toBe(0);
    expect(w.objects.has("blobs/orphan")).toBe(true);

    const due = await w.day(at(GRACE_DAYS));
    expect(due).toMatchObject({ deleted: 1, stored: 2, orphaned: 0 });
    expect([...w.objects.keys()].sort()).toEqual(["blobs/kept", "blobs/shared"]);
  });

  test("referenced again in time (a re-upload, an attach): the clock resets", async () => {
    const w = world();
    w.addLibrary("a", [], true);
    await w.upload("h");
    await w.day(T0);
    // Uploaded again on day 20 to be attached: a fresh 31 days.
    w.setClock(at(20));
    await w.upload("h");
    expect((await w.day(at(40))).deleted).toBe(0);
    // Attached: no longer an orphan at all.
    await w.refs.reference("a", ["h"], at(41));
    w.libs.set("a", ["h"]);
    expect((await w.day(at(80))).deleted).toBe(0);
    expect(w.objects.has("blobs/h")).toBe(true);
  });

  test("libraries from before are counted once before anything is deleted", async () => {
    const w = world();
    // Two libraries from before: no count-state rows; bytes in R2 that today's code never saw.
    w.addLibrary("old1", ["x"]);
    w.addLibrary("old2", ["y"]);
    for (const h of ["x", "y", "gone"]) w.objects.set(`blobs/${h}`, at(-100));
    // An orphan the old sweep had already been timing.
    w.db.run("INSERT INTO blob_orphans (hash, since) VALUES ('gone', ?)", [at(-60).toISOString()]);

    // The first cron is a full day; until the recounts land, deletion is held.
    const first = await w.cron(T0);
    expect(first.recount).toBe("all");
    expect(first.deleted).toBe(0);
    expect(first.held).toBe("the first count of every library has not finished");
    expect(first.attention.some((a) => a.startsWith("Blob sweep held"))).toBe(true);
    expect(await w.drain()).toEqual([]);
    // The listing filled blobs_stored; recounts cleared the referenced ones' orphan rows.
    expect(await w.refs.counts()).toEqual({ stored: 3, referenced: 2, waiting: 1 });

    const next = await w.day(at(1));
    expect(next.held).toBeUndefined();
    expect(next.recount).toBe("open");
    expect(next.deleted).toBe(1);
    expect([...w.objects.keys()].sort()).toEqual(["blobs/x", "blobs/y"]);
  });

  test("a library that never answered holds deletion; once counted, its failures are local", async () => {
    const w = world();
    w.addLibrary("ok", [], true);
    w.addLibrary("flaky", new Error("overloaded"));
    w.objects.set("blobs/f", at(-100));
    await w.upload("orphan");

    await w.day(T0);
    const held = await w.day(at(GRACE_DAYS + 1));
    expect(held.deleted).toBe(0);
    expect(held.held).toContain("o/flaky");
    expect(w.objects.has("blobs/orphan")).toBe(true);

    // It answers once, and is counted.
    w.libs.set("flaky", ["f"]);
    await w.day(at(GRACE_DAYS + 2));
    // Then fails again, for weeks: its rows stay, so its blob stays; the true orphan goes.
    w.libs.set("flaky", new Error("overloaded"));
    const later = await w.day(at(GRACE_DAYS + 30));
    expect(later.held).toBeUndefined();
    expect(later.deleted).toBe(1);
    expect(w.objects.has("blobs/f")).toBe(true);
    expect(w.objects.has("blobs/orphan")).toBe(false);
  });

  test("a normal day wakes no library for the sweep; a full day recounts every one", async () => {
    const w = world();
    for (let i = 0; i < 3; i++) w.addLibrary(`l${i}`, [], true);
    await w.day(T0);
    expect(w.calls.hashes).toBe(3);

    w.calls.hashes = 0;
    const normal = await w.day(at(1));
    expect(normal.recount).toBe("open");
    expect(w.calls.hashes).toBe(0);

    const full = await w.day(at(FULL_RECOUNT_DAYS));
    expect(full.recount).toBe("all");
    expect(w.calls.hashes).toBe(3);
  });

  test("dispatch pages through every library, 100 recounts to a batch", async () => {
    const w = world();
    const n = DISPATCH_PAGE + 7;
    for (let i = 0; i < n; i++) w.addLibrary(`lib${String(i).padStart(4, "0")}`, []);
    await w.cron(T0);
    expect(await w.drain()).toEqual([]);
    expect(w.calls.hashes).toBe(n);
    expect((await w.refs.held(1)).count).toBe(0);
  });

  test("a recount keeps a row a write just recorded, and drops older ones the library lacks", async () => {
    const w = world();
    w.addLibrary("a", ["kept"], true);
    for (const h of ["kept", "stale", "fresh"]) await w.upload(h);
    await w.refs.reference("a", ["kept", "stale"], T0);
    // A write recorded "fresh" a minute before the snapshot, and commits after it.
    await w.refs.reference("a", ["fresh"], at(1));
    const r = await w.refs.replace("a", ["kept"], new Date(at(1).getTime() + 60_000));
    expect(r).toEqual({ added: 0, removed: 1 });
    const rows = w.db.query("SELECT hash FROM blob_refs ORDER BY hash").all();
    expect(rows).toEqual([{ hash: "fresh" }, { hash: "kept" }]);
    // The dropped one is an orphan from now.
    const o = w.db.query("SELECT hash, since FROM blob_orphans").all();
    expect(o).toEqual([{ hash: "stale", since: new Date(at(1).getTime() + 60_000).toISOString() }]);
    expect(RECOUNT_MARGIN_MS).toBeGreaterThanOrEqual(60_000);
  });

  test("a restore holds deletion until the recount carrying its token", async () => {
    const w = world();
    w.addLibrary("a", ["h"], true);
    await w.upload("h");
    await w.upload("orphan");
    await w.refs.reference("a", ["h"], T0);
    await w.day(T0);

    await w.refs.pend("a", "token-1");
    // A recount without the token (the weekly pass) does not clear it.
    await w.refs.replace("a", ["h"], at(GRACE_DAYS + 1));
    const held = await w.cron(at(GRACE_DAYS + 1));
    expect(held.held).toContain("o/a");
    expect(held.deleted).toBe(0);
    // The day's dispatch re-sends the pending recount with its token; it lands and clears it.
    await w.drain();
    expect((await w.day(at(GRACE_DAYS + 2))).deleted).toBe(1);
  });

  test("a deleted library's blobs wait 31 days from the delete", async () => {
    const w = world();
    w.addLibrary("a", ["h"], true);
    await w.upload("h");
    await w.refs.reference("a", ["h"], T0);
    await w.day(T0);
    w.setClock(at(10));
    w.db.run("DELETE FROM libraries WHERE id = 'a'");
    expect(await w.refs.forget("a", at(10))).toBe(1);
    expect((await w.day(at(10 + GRACE_DAYS - 1))).deleted).toBe(0);
    expect((await w.day(at(10 + GRACE_DAYS))).deleted).toBe(1);
  });

  test("a stray row for a deleted library is forgotten, not a hold", async () => {
    const w = world();
    w.addLibrary("a", [], true);
    // A write landed after its library's rows went: an uncounted row with no library.
    await w.refs.reference("gone", ["h"], T0);
    await w.upload("h");
    await w.day(T0);
    // The next normal day recounts what is uncounted, and finds it gone; it holds nothing.
    expect((await w.day(at(1))).held).toBeUndefined();
    expect(w.db.query("SELECT * FROM blob_ref_libraries WHERE library = 'gone'").all()).toEqual([]);
    expect(w.db.query("SELECT * FROM blob_refs").all()).toEqual([]);
    expect(w.db.query("SELECT hash FROM blob_orphans").all()).toEqual([{ hash: "h" }]);
  });

  test("messages are idempotent: run twice, nothing extra is deleted or lost", async () => {
    const w = world();
    w.addLibrary("a", ["kept"], true);
    for (const h of ["kept", "o1", "o2"]) await w.upload(h);
    await w.refs.reference("a", ["kept"], T0);
    await w.cron(T0);
    // Every message delivered twice.
    w.queued.push(...w.queued.map((m) => ({ ...m })));
    expect(await w.drain()).toEqual([]);
    expect(await w.refs.counts()).toEqual({ stored: 3, referenced: 1, waiting: 2 });

    // Two crons the same day (a retried cron): the second finds nothing left to delete.
    expect((await w.day(at(GRACE_DAYS))).deleted).toBe(2);
    expect((await w.day(at(GRACE_DAYS))).deleted).toBe(0);
    expect(w.calls.deleted.sort()).toEqual(["blobs/o1", "blobs/o2"]);
    expect([...w.objects.keys()]).toEqual(["blobs/kept"]);
    // A claimed orphan cannot be claimed again.
    expect(await w.refs.claim(["o1"], at(GRACE_DAYS).toISOString())).toEqual([]);
  });

  test("a blob referenced after its orphan row was read is not claimed", async () => {
    const w = world();
    w.addLibrary("a", [], true);
    await w.upload("h");
    const cutoff = at(GRACE_DAYS).toISOString();
    expect(await w.refs.expired(cutoff, 10)).toEqual(["h"]);
    await w.refs.reference("a", ["h"], at(GRACE_DAYS));
    expect(await w.refs.claim(["h"], cutoff)).toEqual([]);
  });

  test("the listing resumes where it stalled, and the drift scan marks what was missed", async () => {
    const w = world();
    w.addLibrary("a", [], true);
    for (let i = 0; i < 2500; i++) w.objects.set(`blobs/b${i}`, at(-1));
    await w.cron(T0);
    // The first listing page lands; the next is lost.
    const list = w.queued.find((m) => m.kind === "list") as SweepMessage;
    w.queued.length = 0;
    await handleSweepMessage(list, {
      refs: w.refs,
      queue: { send: async () => {}, sendBatch: async () => {} },
      libraryHashes: async () => [],
      bucket: {
        list: async () => ({
          objects: [...w.objects.keys()]
            .sort()
            .slice(0, 1000)
            .map((key) => ({ key, uploaded: at(-1) })),
          truncated: true,
          cursor: "1000",
        }),
      },
      now: () => T0,
    });
    expect((await w.refs.counts()).stored).toBe(1000);
    // A day later it is still at that cursor: the cron sends it again.
    const r = await w.cron(at(1));
    expect(r.attention).toContain("Blob listing (one-time backfill) stalled; started again.");
    expect(await w.drain()).toEqual([]);
    expect(await w.refs.state("listing")).toMatchObject({ value: "done" });
    expect((await w.refs.counts()).stored).toBe(2500);

    // Drift: a stored blob whose orphan row went missing is found by the scan on a full day.
    w.db.run("DELETE FROM blob_orphans WHERE hash = 'b7'");
    await w.day(at(FULL_RECOUNT_DAYS + 1));
    expect(w.db.query("SELECT 1 FROM blob_orphans WHERE hash = 'b7'").all()).toHaveLength(1);
  });

  // TEMPRA-165: the render Worker caches diagrams in the same bucket under renders/.
  test("diagram renders under renders/ are never listed, counted or deleted", async () => {
    const w = world();
    w.addLibrary("a", [], true);
    await w.upload("old");
    const renders = [`renders/${"a".repeat(64)}/pele-1.6.0/light-x/w0.svg`, "renders/b/w0.png"];
    for (const k of renders) w.objects.set(k, at(-100));
    for (const d of [0, 1, 32, FULL_RECOUNT_DAYS + 1, FULL_RECOUNT_DAYS * 2 + 40])
      await w.day(at(d));
    expect(w.objects.has("blobs/old")).toBe(false);
    for (const k of renders) expect(w.objects.has(k)).toBe(true);
    expect(w.calls.deleted.every((k) => k.startsWith("blobs/"))).toBe(true);
    expect((await w.refs.counts()).stored).toBe(0);
  });

  test("the digest's numbers come from D1 and its library checks still run", async () => {
    const w = world();
    w.addLibrary("a", ["h"], true);
    await w.upload("h");
    await w.upload("o");
    await w.refs.reference("a", ["h"], T0);
    const r = await w.day(T0);
    expect(r).toMatchObject({ libraries: 1, stored: 2, referenced: 1, orphaned: 1, deleted: 0 });
    expect(digestText(r)).toContain(
      "Libraries 1. Blobs stored 2, referenced 1, waiting 1, deleted 0 (deletion held). Recounted every library.",
    );
    // The digest asked no library: the sweep's only calls were the recounts.
    expect(w.calls.hashes).toBe(1);
    expect(digestText(await w.day(at(1)))).toContain(
      "Libraries 1. Blobs stored 2, referenced 1, waiting 1, deleted 0. Recounted libraries not yet counted or restored.",
    );
  });

  test("the digest flags stale exports, overdue maintenance and full libraries", async () => {
    const { d1, db } = bunD1();
    db.run(
      "INSERT INTO users (id, email, actor, handle, created) VALUES ('u', 'u@x', 'human:owner', 'owner', '')",
    );
    // What each library's own pass reported (TEMPRA-92); the digest reads only these rows.
    const report = async (
      id: string,
      o: { lag?: number; last?: string; bytes?: number; next?: string } = {},
    ) => {
      db.run(
        "INSERT INTO libraries (id, slug, owner, visibility, created, do_id) VALUES (?, ?, 'u', 'private', '', ?)",
        [id, id, id],
      );
      const row = healthRow({
        export: { lag: o.lag ?? 0, last_run: o.last ?? "2026-10-01T03:00:00Z" },
        bytes: o.bytes ?? 1000,
        limitBytes: 100 * 1048576,
        counts: null,
        nextRun: o.next ?? "2026-10-02T03:00:00Z",
        now: at(-1),
      });
      await writeHealth(d1, id, row, at(-1), o.bytes ?? 1000);
    };
    await report("ok");
    await report("stale", {
      lag: 4,
      last: "2026-09-25T03:00:00Z",
      next: "2026-09-26T03:00:00Z",
    });
    await report("full", { bytes: 90 * 1048576 });
    const r = await sweep({
      refs: d1BlobRefs(d1),
      queue: { send: async () => {}, sendBatch: async () => {} },
      bucket: { delete: async () => {} },
      health: (t) => healthDigest(d1, t),
      now: T0,
    });
    // The library's own report recorded its storage for the account quota (TEMPRA-232).
    expect(db.query("SELECT do_id, storage_bytes FROM libraries ORDER BY do_id").all()).toEqual([
      { do_id: "full", storage_bytes: 90 * 1048576 },
      { do_id: "ok", storage_bytes: 1000 },
      { do_id: "stale", storage_bytes: 1000 },
    ]);
    expect(r.libraries).toBe(3);
    expect(r.attention.filter((a) => !a.startsWith("Blob sweep held"))).toEqual([
      "owner/full: 90 MB of 100 MB",
      "owner/stale: last export 2026-09-25T03:00:00Z, 4 events behind",
      "owner/stale: daily maintenance overdue since 2026-09-26T03:00:00Z",
    ]);
  });

  test("only sweep messages are handled", () => {
    expect(isSweepMessage({ kind: "recount", library: "a" })).toBe(true);
    expect(isSweepMessage({ kind: "other" })).toBe(false);
    expect(isSweepMessage("x")).toBe(false);
  });
});

describe("blob references on the write path (TEMPRA-91)", () => {
  test("an upload is recorded as stored, its attach as a reference, a delete forgets them", async () => {
    const { req, db, app } = setup();
    const bytes = new Uint8Array([9, 8, 7]);
    const r = await req("/files/refs/data.bin", { method: "PUT", body: bytes });
    expect(r.status).toBe(200);
    const { hash } = (await r.json()) as { hash: string };
    expect(db.query("SELECT hash FROM blobs_stored").all()).toEqual([{ hash }]);
    expect(db.query("SELECT hash, library FROM blob_refs").all()).toEqual([
      { hash, library: "lib-1" },
    ]);
    // Referenced: no orphan row.
    expect(db.query("SELECT * FROM blob_orphans").all()).toEqual([]);

    // A new library is counted from the start.
    const created = await app.request("/api/v1/libraries", {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: "http://localhost" },
      body: JSON.stringify({ slug: "second" }),
    });
    expect(created.status).toBeLessThan(300);
    const counted = db
      .query(
        "SELECT s.counted FROM blob_ref_libraries s JOIN libraries l ON l.do_id = s.library WHERE l.slug = 'second'",
      )
      .get() as { counted: string | null } | null;
    expect(counted?.counted).toBeString();
  });

  test("a write whose references cannot be recorded is refused, not committed", async () => {
    const { req, db } = setup();
    const up = await req("/files/a.bin", { method: "PUT", body: new Uint8Array([1]) });
    expect(up.status).toBe(200);
    db.run(
      "CREATE TRIGGER refs_down BEFORE INSERT ON blob_refs BEGIN SELECT RAISE(ABORT, 'D1 down'); END",
    );
    const r = await req("/files/b.bin", { method: "PUT", body: new Uint8Array([2]) });
    expect(r.status).toBe(503);
    expect((await req("/files/b.bin")).status).toBe(404);
  });
});

describe("which writes touch D1 (TEMPRA-91)", () => {
  test("text writes and attachments the library already holds make no D1 call", async () => {
    const { db, store } = setup();
    const { callStore } = await import("../src/client");
    const { memoryBlobs } = await import("./harness");
    const blobs = memoryBlobs();
    const calls: string[][] = [];
    const references = async (h: string[]) => {
      calls.push(h);
    };
    const ctx = { actor: "claude-code/test", request_id: "r1" };
    const doc = "---\ntype: Note\ntitle: T\ndescription: D.\n---\n# T\n\nText.\n";
    await callStore(store(), blobs, "apply", [ctx, [{ op: "write", path: "a.md", content: doc }]], {
      references,
    });
    expect(calls).toEqual([]);

    const { sha256Hex } = await import("../src/format/hash");
    const h1 = sha256Hex(new Uint8Array([1]));
    await blobs.put(h1, new Uint8Array([1]), null);
    const attach = (path: string) => ({
      op: "attach",
      path,
      blob: { hash: h1, size: 1, media: null },
    });
    let r = await callStore(
      store(),
      blobs,
      "apply",
      [{ ...ctx, request_id: "r2" }, [attach("x.bin")]],
      {
        references,
      },
    );
    expect(r).toMatchObject({ ok: true });
    expect(calls).toEqual([[h1]]);
    // The same bytes again, at another path: already held, no D1 call.
    r = await callStore(
      store(),
      blobs,
      "apply",
      [{ ...ctx, request_id: "r3" }, [attach("y.bin")]],
      {
        references,
      },
    );
    expect(r.ok).toBe(true);
    expect(calls).toEqual([[h1]]);
    expect(db).toBeDefined();
  });
});

/**
 * Nightly exports name attachments by hash instead of copying their bytes (TEMPRA-83; tempra-dev:
 * v2/exports), so the sweep must never delete bytes a retained export lists. A library attaches a
 * blob, exports it, is restored to before the attach (its references drop, the blob becomes an
 * orphan), and then lives through 80 days of daily sweeps and maintenance passes on the alarm's
 * schedule, its first pass after the restore as late as the heartbeat allows.
 */
describe("exports and the sweep (TEMPRA-83)", () => {
  test("a retained export's bytes outlive it", async () => {
    const w = world();
    const H = "e".repeat(64);
    const clock = { t: T0.getTime() };
    let db = new Database(":memory:");
    let store = new LibraryStore(bunSqlHandle(db), { now: () => new Date(clock.t) });
    const exports = memoryBucket();
    const ctx = () => ({ actor: "claude-code/test", request_id: crypto.randomUUID() });
    const pass = async (t: number) => {
      clock.t = t;
      await runMaintenance({ store, bucket: exports, libraryId: "a", now: new Date(t) });
      return nextMaintenance(new Date(t), "a", store.maintenanceDue(new Date(t))).getTime();
    };
    /** Every hash a folder in R2 lists, by folder. */
    const listed = () => {
      const out = new Map<string, string[]>();
      for (const [k, v] of exports.objects) {
        if (!k.endsWith("/attachments.json")) continue;
        const list = JSON.parse(new TextDecoder().decode(v)) as { hash: string }[];
        out.set(
          k,
          list.map((a) => a.hash),
        );
      }
      return out;
    };
    const check = (when: string) => {
      for (const [folder, hashes] of listed()) {
        for (const h of hashes) {
          if (!w.objects.has(`blobs/${h}`)) {
            throw new Error(`${when}: ${folder} lists ${h}, deleted`);
          }
        }
      }
    };

    w.addLibrary("a", [], true);
    store.apply(ctx(), [{ op: "write", path: "a.md", content: "---\ntype: Note\n---\nA\n" }]);
    await pass(T0.getTime());
    const restorePoint = db.serialize();

    // Day 1: an attachment, recorded as the write path records it, and exported.
    w.setClock(at(1));
    await w.upload(H);
    await w.refs.reference("a", [H], at(1));
    store.apply(ctx(), [{ op: "attach", path: "x.png", blob: { hash: H, size: 3, media: null } }]);
    w.libs.set("a", [H]);
    await w.day(at(1));
    await pass(at(1).getTime() + 3_600_000);
    expect([...listed().values()].flat()).toContain(H);

    // Day 2: restored to before the attach; the recount carrying the restore's token drops H.
    w.setClock(at(2));
    await w.refs.pend("a", "restore-1");
    db = Database.deserialize(restorePoint);
    store = new LibraryStore(bunSqlHandle(db), { now: () => new Date(clock.t) });
    w.libs.set("a", []);
    w.queued.push({ kind: "recount", library: "a", token: "restore-1" });
    await w.drain();
    expect(w.db.query("SELECT hash FROM blob_orphans").all()).toEqual([{ hash: H }]);

    // The restored library's first pass comes as late as the heartbeat allows.
    let next = at(2).getTime() + MAX_SLEEP_DAYS * DAY;
    for (let d = 2; d <= 80; d++) {
      while (next < at(d).getTime()) next = await pass(next);
      await w.day(at(d));
      check(`day ${d}, after the sweep`);
      while (next < at(d + 1).getTime()) {
        next = await pass(next);
        check(`day ${d}, after the pass`);
      }
    }
    // The blob went in the end, and no folder lists it any more.
    expect(w.calls.deleted).toContain(`blobs/${H}`);
    expect([...listed().values()].flat()).not.toContain(H);
  });
});
