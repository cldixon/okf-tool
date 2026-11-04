import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { nightlyBundle } from "../src/export-bundle";
import { sha256Hex } from "../src/format/hash";
import { runMaintenance } from "../src/maintain";
import { LibraryStore } from "../src/store/store";
import { readTar, writeTar } from "../src/util/tar";
import { memoryBlobs, memoryBucket, setup } from "./harness";
import { bunSqlHandle } from "./sqlite";

const ctx = (actor = "claude-code/test") => ({ actor, request_id: crypto.randomUUID() });
const md = (body: string, extra = "") => `---\ntype: Note\n${extra}---\n${body}`;

function newStore(clock: { t: number }) {
  return new LibraryStore(bunSqlHandle(), { now: () => new Date(clock.t) });
}

describe("daily maintainers (spec: Tier 3)", () => {
  test("nightly export: bundle, ledger and manifest, only when the ledger moved", async () => {
    const clock = { t: Date.parse("2026-09-30T03:05:00Z") };
    const store = newStore(clock);
    const bucket = memoryBucket();
    store.apply(ctx(), [{ op: "write", path: "a.md", content: md("A\n") }]);
    const run = () => runMaintenance({ store, bucket, libraryId: "lib-x", now: new Date(clock.t) });

    const first = await run();
    expect(first.export).toEqual({ key: "exports/lib-x/2026-09-30/", seq: 1, files: 1 });
    const tar = readTar(bucket.objects.get("exports/lib-x/2026-09-30/bundle.tar") as Uint8Array);
    expect(tar.map((f) => f.path).sort()).toEqual(["a.md"]);
    const ledger = new TextDecoder()
      .decode(bucket.objects.get("exports/lib-x/2026-09-30/ledger.jsonl"))
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l) as { t: string });
    expect(ledger.map((l) => l.t)).toEqual(["blob", "event"]);
    expect(store.stats().maintainers.export).toMatchObject({ cursor: 1, lag: 0 });

    // Nothing changed: no second export.
    expect((await run()).export).toEqual({ skipped: "unchanged" });

    // A day later with a change: a new folder.
    clock.t += 86_400_000;
    store.apply(ctx(), [{ op: "write", path: "b.md", content: md("B\n") }]);
    expect(store.stats().maintainers.export.lag).toBe(1);
    expect((await run()).export).toMatchObject({ key: "exports/lib-x/2026-10-01/", seq: 2 });
  });

  test("a folder names attachments by hash; its download streams their bytes in (TEMPRA-83)", async () => {
    const clock = { t: Date.parse("2026-09-30T03:05:00Z") };
    const store = newStore(clock);
    const bucket = memoryBucket();
    const blobs = memoryBlobs();
    const bytes = new TextEncoder().encode("a,b\n1,2\n");
    const hash = sha256Hex(bytes);
    await blobs.put(hash, bytes, "text/csv");
    const long = `data/${"a-long-name-".repeat(10)}.csv`;
    store.apply(ctx(), [
      { op: "write", path: "a.md", content: md("A\n") },
      { op: "attach", path: "data/x.csv", blob: { hash, size: bytes.length, media: "text/csv" } },
      { op: "attach", path: long, blob: { hash, size: bytes.length, media: "text/csv" } },
    ]);
    const res = await runMaintenance({ store, bucket, libraryId: "lib-x", now: new Date(clock.t) });
    const folder = "exports/lib-x/2026-09-30/";
    // a.md and two attachments: a nightly export is the plain format, with no index.md or log.md.
    expect(res.export).toEqual({ key: folder, seq: 3, files: 3 });
    const stored = readTar(bucket.objects.get(`${folder}bundle.tar`) as Uint8Array);
    expect(stored.map((f) => f.path).sort()).toEqual(["a.md"]);
    const text = (k: string) => new TextDecoder().decode(bucket.objects.get(`${folder}${k}`));
    expect(JSON.parse(text("attachments.json"))).toEqual([
      { path: long, hash, size: bytes.length, media: "text/csv" },
      { path: "data/x.csv", hash, size: bytes.length, media: "text/csv" },
    ]);
    expect(JSON.parse(text("manifest.json"))).toMatchObject({
      seq: 3,
      files: 3,
      attachments: 1 + 1,
      format: 2,
    });
    // No export object holds the attachment's bytes.
    for (const [k, v] of bucket.objects) {
      if (k.endsWith(".json")) continue;
      expect(readTar(v).some((f) => f.path.endsWith(".csv"))).toBe(false);
    }

    // The download is the whole bundle, the bytes streamed from blob storage.
    const download = async () => {
      const body = await nightlyBundle(folder, (k) => bucket.get(k), blobs);
      return readTar(new Uint8Array(await new Response(body as BodyInit).arrayBuffer()));
    };
    const whole = await download();
    expect(whole.map((f) => f.path).sort()).toEqual(
      ["a.md", "data/x.csv", long].sort(),
    );
    expect(whole.find((f) => f.path === long)?.bytes).toEqual(bytes);
    expect(whole.find((f) => f.path === "data/x.csv")?.bytes).toEqual(bytes);

    // Overwritten halfway from the old format (bytes inside the tar): not added twice.
    const old = writeTar([...stored, { path: "data/x.csv", bytes }]);
    await bucket.put(`${folder}bundle.tar`, old);
    expect((await download()).filter((f) => f.path === "data/x.csv")).toHaveLength(1);

    // A folder from before TEMPRA-83 (no attachments.json) is served as stored.
    await bucket.put("exports/lib-x/2026-09-01/bundle.tar", old);
    expect(await nightlyBundle("exports/lib-x/2026-09-01/", (k) => bucket.get(k), blobs)).toEqual(
      old,
    );
    expect(await nightlyBundle("exports/lib-x/2026-08-01/", (k) => bucket.get(k), blobs)).toBe(
      null,
    );

    // Bytes gone: the download fails rather than giving a short bundle.
    await bucket.put(`${folder}bundle.tar`, writeTar(stored));
    blobs.map.delete(hash);
    await expect(download()).rejects.toThrow("missing");
  });

  test("after a restore the next pass exports again, though the ledger did not move (TEMPRA-83)", async () => {
    const clock = { t: Date.parse("2026-09-30T03:05:00Z") };
    let db = new Database(":memory:");
    let store = new LibraryStore(bunSqlHandle(db), { now: () => new Date(clock.t) });
    const bucket = memoryBucket();
    const run = () => runMaintenance({ store, bucket, libraryId: "lib-x", now: new Date(clock.t) });
    store.apply(ctx(), [{ op: "write", path: "a.md", content: md("A\n") }]);
    expect((await run()).export).toMatchObject({ seq: 1 });
    const restorePoint = db.serialize();

    // Later the same day: an attachment, and Export now overwrites the day's folder.
    clock.t += 3_600_000;
    store.apply(ctx(), [
      { op: "attach", path: "x.png", blob: { hash: "f".repeat(64), size: 3, media: null } },
    ]);
    expect((await run()).export).toMatchObject({ seq: 2 });
    const folder = "exports/lib-x/2026-09-30/";
    const lists = () =>
      JSON.parse(new TextDecoder().decode(bucket.objects.get(`${folder}attachments.json`)));
    expect(lists()).toHaveLength(1);

    // Restored to before it: the meta says seq 1 was exported, and the head is seq 1.
    db = Database.deserialize(restorePoint);
    store = new LibraryStore(bunSqlHandle(db), { now: () => new Date(clock.t) });
    expect(store.headSeq()).toBe(1);
    clock.t += 3_600_000;
    // The newest folder is not this library's last export, so it is written again.
    expect((await run()).export).toMatchObject({ key: folder, seq: 1 });
    expect(lists()).toEqual([]);
    expect((await run()).export).toEqual({ skipped: "unchanged" });
  });

  test("a library restored to empty replaces a newer folder with an empty bundle", async () => {
    const clock = { t: Date.parse("2026-09-30T03:05:00Z") };
    const store = newStore(clock);
    const bucket = memoryBucket();
    await bucket.put("exports/lib-x/2026-09-29/attachments.json", '[{"path":"x.png"}]');
    await bucket.put(
      "exports/lib-x/2026-09-29/manifest.json",
      '{"created":"2026-09-29T00:00:00Z"}',
    );
    const res = await runMaintenance({ store, bucket, libraryId: "lib-x", now: new Date(clock.t) });
    expect(res.export).toMatchObject({ key: "exports/lib-x/2026-09-30/", seq: 0 });
    const tar = readTar(bucket.objects.get("exports/lib-x/2026-09-30/bundle.tar") as Uint8Array);
    expect(tar.map((f) => f.path).sort()).toEqual([]);
  });

  test("retention deletes old exports but always keeps the newest", async () => {
    const bucket = memoryBucket();
    const created = "2026-09-29T03:00:00Z";
    for (const d of ["2026-06-01", "2026-08-01", "2026-09-29"]) {
      await bucket.put(`exports/lib-x/${d}/bundle.tar`, "x");
      await bucket.put(`exports/lib-x/${d}/manifest.json`, JSON.stringify({ created }));
    }
    await bucket.put("exports/other/2026-01-01/bundle.tar", "x");
    const clock = { t: Date.parse("2026-09-30T03:00:00Z") };
    const store = newStore(clock);
    // The newest folder is the export this library last wrote, so nothing is exported again.
    store.setMaintenance({ export_seq: "0", export_at: created });
    const res = await runMaintenance({
      store,
      bucket,
      libraryId: "lib-x",
      now: new Date(clock.t),
      retentionDays: 30,
    });
    expect(res.deleted).toEqual(["exports/lib-x/2026-06-01/", "exports/lib-x/2026-08-01/"]);
    expect([...bucket.objects.keys()].sort()).toEqual([
      "exports/lib-x/2026-09-29/bundle.tar",
      "exports/lib-x/2026-09-29/manifest.json",
      "exports/other/2026-01-01/bundle.tar",
    ]);

    // Even far past the window, the newest export stays.
    const later = await runMaintenance({
      store,
      bucket,
      libraryId: "lib-x",
      now: new Date(clock.t + 365 * 86_400_000),
    });
    expect(later.deleted).toEqual([]);
  });

  test("usage: reads of the current version are counted and pruned after the window", async () => {
    const clock = { t: Date.parse("2026-09-01T12:00:00Z") };
    const store = newStore(clock);
    store.apply(ctx(), [
      { op: "write", path: "p.md", content: md("Policy\n") },
      {
        op: "write",
        path: "m.md",
        content: md("Uses it.[^p]\n\n[^p]: p\n", "sources:\n  - { id: p, resource: /p.md }\n"),
      },
    ]);
    store.read("p.md");
    store.read("p.md");
    store.read("p.md", { at: 1 }); // an earlier version: not counted
    const usage = () =>
      (store.sources("m.md").sources[0]?.internal as { usage_count: number } | undefined)
        ?.usage_count;
    expect(usage()).toBe(2);
    const computed = store.read("p.md", { computed: true });
    // Counted before this read is recorded.
    expect(computed.kind === "page" && computed.markdown).toContain("usage_count: 2");

    clock.t += 40 * 86_400_000;
    expect(usage()).toBe(0);
    await runMaintenance({
      store,
      bucket: memoryBucket(),
      libraryId: "lib-x",
      now: new Date(clock.t),
    });
    expect(store.stats().maintainers.usage.last_run).not.toBeNull();
  });

  test("stale items come from stale_after and clear as soon as it moves", () => {
    const clock = { t: Date.parse("2026-09-30T00:00:00Z") };
    const store = newStore(clock);
    store.apply(ctx(), [
      { op: "write", path: "s.md", content: md("x\n", "stale_after: 2026-09-01T00:00:00Z\n") },
    ]);
    expect(store.work({ kind: "stale" }).items.map((i) => i.path)).toEqual(["s.md"]);
    const v = store.read("s.md");
    if (v.kind !== "page") throw new Error();
    store.apply(ctx(), [
      {
        op: "write",
        path: "s.md",
        content: md("x\n", "stale_after: 2027-01-01T00:00:00Z\n"),
        if_match: v.hash,
      },
    ]);
    expect(store.work({ kind: "stale" }).items).toEqual([]);
  });

  test("staleness: a page passing stale_after between two runs is flagged after the second", () => {
    const clock = { t: Date.parse("2026-09-01T00:00:00Z") };
    const store = newStore(clock);
    store.apply(ctx(), [
      { op: "write", path: "s.md", content: md("x\n", "stale_after: 2026-10-01T00:00:00Z\n") },
      { op: "write", path: "far.md", content: md("x\n", "stale_after: 2027-06-01T00:00:00Z\n") },
      { op: "write", path: "none.md", content: md("x\n") },
    ]);
    const paths = (kind: string) => store.work({ kind }).items.map((i) => i.path);
    const run = () => store.maintainStaleness();

    expect(run()).toEqual({ stale: 0, stale_soon: 0, became: { stale: [], stale_soon: [] } });
    expect(paths("stale_soon")).toEqual([]);

    // Twenty days on, s.md is within 14 days of its date: stale soon, not yet in the queue.
    clock.t += 20 * 86_400_000;
    expect(run()).toEqual({ stale: 0, stale_soon: 1, became: { stale: [], stale_soon: ["s.md"] } });
    expect(paths("stale_soon")).toEqual(["s.md"]);
    expect(paths("stale")).toEqual([]);
    const queued = () => store.work().items.filter((i) => i.kind.startsWith("stale"));
    expect(queued()).toEqual([]);
    // 4: lint on each (no description), and the root's one structure item (descriptions, orphans).
    expect(store.summary()).toMatchObject({ open_work: 4, stale_soon: 1 });
    expect(store.outline().files.find((f) => f.path === "s.md")).toMatchObject({
      stale: "stale_soon",
    });
    const view = store.read("s.md");
    expect(view.kind === "page" && [view.stale, view.stale_soon]).toEqual([false, true]);
    // A second run the same day changes nothing.
    expect(run().became).toEqual({ stale: [], stale_soon: [] });

    // Past the date: stale at once from the stored flag, and recorded as such by the next run.
    clock.t += 11 * 86_400_000;
    expect(paths("stale")).toEqual(["s.md"]);
    expect(run()).toEqual({ stale: 1, stale_soon: 0, became: { stale: ["s.md"], stale_soon: [] } });
    expect(paths("stale_soon")).toEqual([]);
    expect(queued().map((i) => i.path)).toEqual(["s.md"]);
    expect(store.stats().maintainers.staleness).toMatchObject({
      kind: "process",
      stale: 1,
      stale_soon: 0,
      lag: 0,
    });
  });

  test("staleness: only a new stale_after resets the clock", () => {
    const clock = { t: Date.parse("2026-09-30T00:00:00Z") };
    const store = newStore(clock);
    store.apply(ctx(), [
      { op: "write", path: "s.md", content: md("x\n", "stale_after: 2026-09-01T00:00:00Z\n") },
    ]);
    const stale = () => store.work({ kind: "stale" }).items.map((i) => i.path);
    const hash = () => {
      const v = store.read("s.md");
      if (v.kind !== "page") throw new Error();
      return v.hash;
    };
    const write = (content: string) =>
      store.apply(ctx(), [{ op: "write", path: "s.md", content, if_match: hash() }]);
    expect(stale()).toEqual(["s.md"]);

    // A small edit that leaves stale_after alone: still stale.
    write(md("x, fixed\n", "stale_after: 2026-09-01T00:00:00Z\n"));
    expect(stale()).toEqual(["s.md"]);

    // A date within the window: stale soon from the write itself, no run needed.
    write(md("x, fixed\n", "stale_after: 2026-10-05T00:00:00Z\n"));
    expect(stale()).toEqual([]);
    expect(store.work({ kind: "stale_soon" }).items.map((i) => i.path)).toEqual(["s.md"]);

    // Moved well forward, then removed: nothing flagged either way.
    write(md("x, fixed\n", "stale_after: 2027-03-01T00:00:00Z\n"));
    expect(store.work({ kind: "stale_soon" }).items).toEqual([]);
    clock.t = Date.parse("2027-04-01T00:00:00Z");
    expect(stale()).toEqual([]); // not flagged until the process runs
    expect(store.maintainStaleness().became.stale).toEqual(["s.md"]);
    write(md("x, fixed\n"));
    expect(stale()).toEqual([]);
    expect(store.maintainStaleness()).toMatchObject({ stale: 0, stale_soon: 0 });
  });

  test("staleness: the run reads only indexes, however large the library", () => {
    const db = new Database(":memory:");
    const handle = bunSqlHandle(db);
    const seen: string[] = [];
    const store = new LibraryStore(
      {
        ...handle,
        all: (q, ...p) => {
          seen.push(q);
          return handle.all(q, ...p);
        },
      },
      { now: () => new Date("2026-09-30T00:00:00Z") },
    );
    store.apply(ctx(), [
      { op: "write", path: "a.md", content: md("A\n") },
      { op: "write", path: "b.md", content: md("B\n") },
    ]);
    seen.length = 0;
    expect(store.maintainStaleness()).toMatchObject({ stale: 0, stale_soon: 0 });
    const reads = seen.filter((q) => /^\s*SELECT/i.test(q) && /pages|flags/.test(q));
    expect(reads.length).toBe(2);
    for (const q of reads) {
      const plan = db
        .query(`EXPLAIN QUERY PLAN ${q}`)
        .all(...(q.includes("?") ? [0] : []))
        .map((r) => (r as { detail: string }).detail);
      expect(plan.filter((d) => /^SCAN (c|pages|flags)\b/.test(d))).toEqual([]);
    }
  });

  test("staleness: a library from before the process gets the column, its index and a first run", () => {
    const db = new Database(":memory:");
    const clock = { t: Date.parse("2026-09-30T00:00:00Z") };
    const first = new LibraryStore(bunSqlHandle(db), { now: () => new Date(clock.t) });
    first.apply(ctx(), [
      { op: "write", path: "s.md", content: md("x\n", "stale_after: 2026-09-01T00:00:00Z\n") },
    ]);
    // As it was stored before TEMPRA-63: no stale_ms, no flags for staleness.
    db.run("DROP INDEX pages_stale");
    db.run("ALTER TABLE pages DROP COLUMN stale_ms");
    db.run("DELETE FROM flags WHERE kind IN ('stale', 'stale_soon')");
    db.run("DELETE FROM meta WHERE key = 'stale_ms'");

    const reopened = new LibraryStore(bunSqlHandle(db), { now: () => new Date(clock.t) });
    expect(reopened.work({ kind: "stale" }).items.map((i) => i.path)).toEqual(["s.md"]);
    expect(reopened.stats().maintainers.staleness.last_run).toBe("2026-09-30T00:00:00Z");
  });
});

describe("stats, healthz and nightly exports in the UI and API", () => {
  test("GET /stats, GET /healthz, the library page and the export list", async () => {
    const s = setup();
    await s.req("/files/a.md", {
      method: "PUT",
      headers: { "Content-Type": "text/markdown" },
      body: md("A\n"),
    });
    const stats = (await (await s.req("/stats")).json()) as { seq: number; events: number };
    expect(stats).toMatchObject({ seq: 1, events: 1 });
    const health = await s.app.request("/healthz");
    expect(await health.json()).toMatchObject({ ok: true });

    await runMaintenance({
      store: s.store(),
      bucket: s.bucket,
      libraryId: "lib-1",
      now: new Date(),
    });
    // The library's home page reads these from /stats.
    const after = (await (await s.app.request("/api/v1/libraries/owner/demo/stats")).json()) as {
      events: number;
      maintainers: { export: { last_run: string | null } };
    };
    expect(after.events).toBe(1);
    expect(after.maintainers.export.last_run).not.toBeNull();
    expect((await s.app.request("/owner/demo/-/transfer")).status).toBe(200);
    const date = new Date().toISOString().slice(0, 10);
    // The Import & export page lists the nightly exports from the API.
    const list = (await (await s.app.request("/api/v1/libraries/owner/demo/exports")).json()) as {
      exports: { date: string; seq: number | null; files: number | null }[];
    };
    expect(list.exports).toEqual([{ date, seq: 1, files: 1 }]);
    // People only, like restore: an agent's token cannot list them.
    expect((await s.req("/exports")).status).toBe(403);
    expect((await s.req("/exports", { token: "human" })).status).toBe(200);
    const stranger = await s.stranger();
    expect((await stranger.app.request("/api/v1/libraries/owner/demo/exports")).status).toBe(404);
    const tar = await s.app.request(`/owner/demo/-/exports/${date}/bundle.tar`);
    expect(tar.headers.get("Content-Disposition")).toContain(`demo-${date}-bundle.tar`);
    expect(readTar(new Uint8Array(await tar.arrayBuffer())).map((f) => f.path)).toContain("a.md");
    expect((await s.app.request(`/owner/demo/-/exports/${date}/secrets.txt`)).status).toBe(404);
    expect((await s.app.request("/owner/demo/-/exports/..%2F..%2Fx/bundle.tar")).status).toBe(404);
  });
});

describe("Export now", () => {
  test("runs the maintainers once from the Import & export page", async () => {
    const s = setup();
    await s.req("/files/a.md", {
      method: "PUT",
      headers: { "Content-Type": "text/markdown" },
      body: md("A\n"),
    });
    const post = (origin = "http://localhost") =>
      s.app.request("/api/v1/libraries/owner/demo/maintain", {
        method: "POST",
        headers: { Origin: origin },
      });
    expect((await post("https://evil.example")).status).toBe(403);
    expect(s.bucket.objects.size).toBe(0);
    const first = await post();
    expect(first.status).toBe(200);
    const date = new Date().toISOString().slice(0, 10);
    expect((await first.json()) as object).toEqual({ export: `exports/lib-1/${date}/` });
    // Nothing changed since the last export: none made.
    expect((await (await post()).json()) as object).toEqual({ export: null });
    // An agent's token may not run it; a stranger does not see the library.
    expect((await s.req("/maintain", { method: "POST" })).status).toBe(403);
    const stranger = await s.stranger();
    const theirs = await stranger.app.request("/api/v1/libraries/owner/demo/maintain", {
      method: "POST",
      headers: { Origin: "http://localhost" },
    });
    expect(theirs.status).toBe(404);
  });
});
