import { describe, expect, test } from "bun:test";
import { nextRun, runMaintenance } from "../src/maintain";
import { LibraryStore } from "../src/store/store";
import { readTar } from "../src/util/tar";
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
    const blobs = memoryBlobs();
    store.apply(ctx(), [{ op: "write", path: "a.md", content: md("A\n") }]);
    const run = () =>
      runMaintenance({ store, blobs, bucket, libraryId: "lib-x", now: new Date(clock.t) });

    const first = await run();
    expect(first.export).toEqual({ key: "exports/lib-x/2026-09-30/", seq: 1, files: 3 });
    const tar = readTar(bucket.objects.get("exports/lib-x/2026-09-30/bundle.tar") as Uint8Array);
    expect(tar.map((f) => f.path).sort()).toEqual(["a.md", "index.md", "log.md"]);
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

  test("retention deletes old exports but always keeps the newest", async () => {
    const bucket = memoryBucket();
    for (const d of ["2026-06-01", "2026-08-01", "2026-09-29"]) {
      await bucket.put(`exports/lib-x/${d}/bundle.tar`, "x");
      await bucket.put(`exports/lib-x/${d}/manifest.json`, "{}");
    }
    await bucket.put("exports/other/2026-01-01/bundle.tar", "x");
    const clock = { t: Date.parse("2026-09-30T03:00:00Z") };
    const store = newStore(clock);
    const res = await runMaintenance({
      store,
      blobs: memoryBlobs(),
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
      blobs: memoryBlobs(),
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
    expect(computed.kind === "concept" && computed.markdown).toContain("usage_count: 2");

    clock.t += 40 * 86_400_000;
    expect(usage()).toBe(0);
    await runMaintenance({
      store,
      blobs: memoryBlobs(),
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
    if (v.kind !== "concept") throw new Error();
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

  test("the next run is 03:00 UTC plus a per-library offset, always in the future", () => {
    const a = nextRun(new Date("2026-09-30T01:00:00Z"), "lib-a");
    expect(a.toISOString().slice(0, 13)).toBe("2026-09-30T03");
    const b = nextRun(new Date("2026-09-30T05:00:00Z"), "lib-a");
    expect(b.toISOString().slice(0, 13)).toBe("2026-10-01T03");
    expect(b.getUTCMinutes()).toBe(a.getUTCMinutes());
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
      blobs: s.blobs,
      bucket: s.bucket,
      libraryId: "lib-1",
      now: new Date(),
    });
    const home = await (await s.app.request("/app/libraries/demo/")).text();
    expect(home).toContain("1 events in 1 requests");
    expect(home).toContain("last nightly export");
    const transfer = await (await s.app.request("/app/libraries/demo/transfer")).text();
    const date = new Date().toISOString().slice(0, 10);
    expect(transfer).toContain(`/app/libraries/demo/exports/${date}/bundle.tar`);
    const tar = await s.app.request(`/app/libraries/demo/exports/${date}/bundle.tar`);
    expect(tar.headers.get("Content-Disposition")).toContain(`demo-${date}-bundle.tar`);
    expect(readTar(new Uint8Array(await tar.arrayBuffer())).map((f) => f.path)).toContain("a.md");
    expect((await s.app.request(`/app/libraries/demo/exports/${date}/secrets.txt`)).status).toBe(
      404,
    );
    expect((await s.app.request("/app/libraries/demo/exports/..%2F..%2Fx/bundle.tar")).status).toBe(
      404,
    );
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
    const post = () =>
      s.app.request("/app/libraries/demo/maintain", {
        method: "POST",
        headers: { Origin: "http://localhost" },
      });
    const first = await (await post()).text();
    expect(first).toContain("Exported to R2 at <code>exports/lib-1/");
    expect(await (await post()).text()).toContain("Nothing changed since the last export");
    const forged = await s.app.request("/app/libraries/demo/maintain", {
      method: "POST",
      headers: { Origin: "https://evil.example" },
    });
    expect(forged.status).toBe(403);
  });
});
