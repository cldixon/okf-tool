import { describe, expect, test } from "bun:test";
import { d1Orphans, digestText, GRACE_DAYS, type Inventory, sweep } from "../src/sweep";
import { bunD1 } from "./d1";
import { memoryBucket } from "./harness";

const DAY = 86_400_000;
const T0 = new Date("2026-10-01T04:30:00Z");

const inv = (hashes: string[], over: Partial<Inventory> = {}): Inventory => ({
  hashes,
  bytes: 1000,
  stats: {
    seq: 3,
    maintainers: { export: { lag: 0, last_run: "2026-10-01T03:00:00Z" } },
    next_run: "2026-10-02T03:00:00Z",
  },
  ...over,
});

function world() {
  const bucket = memoryBucket();
  const { d1 } = bunD1();
  const libs = new Map<string, Inventory | Error>();
  const deps = (now: Date) => ({
    libraries: async () => [...libs.keys()].map((id) => ({ id, path: `owner/${id}` })),
    inventory: async (id: string) => {
      const v = libs.get(id);
      if (v instanceof Error) throw v;
      return v as Inventory;
    },
    bucket: {
      list: (o: { prefix: string }) => bucket.list(o),
      delete: (keys: string[]) => bucket.delete(keys),
    },
    orphans: d1Orphans(d1),
    storageLimitBytes: 100 * 1048576,
    now,
  });
  return { bucket, libs, deps };
}

describe("daily blob sweep (v2 spec: A3)", () => {
  test("a blob nobody references goes after 31 days unreferenced, not before", async () => {
    const w = world();
    for (const h of ["kept", "shared", "orphan"]) await w.bucket.put(`blobs/${h}`, "x");
    w.libs.set("a", inv(["kept", "shared"]));
    w.libs.set("b", inv(["shared"]));

    const first = await sweep(w.deps(T0));
    expect(first).toMatchObject({
      libraries: 2,
      stored: 3,
      referenced: 2,
      orphaned: 1,
      deleted: 0,
    });

    const almost = await sweep(w.deps(new Date(T0.getTime() + (GRACE_DAYS - 1) * DAY)));
    expect(almost.deleted).toBe(0);
    expect(w.bucket.objects.has("blobs/orphan")).toBe(true);

    const due = await sweep(w.deps(new Date(T0.getTime() + GRACE_DAYS * DAY)));
    expect(due.deleted).toBe(1);
    expect([...w.bucket.objects.keys()].sort()).toEqual(["blobs/kept", "blobs/shared"]);
  });

  test("referenced again in time (an undo, a re-upload): the clock resets", async () => {
    const w = world();
    await w.bucket.put("blobs/h", "x");
    w.libs.set("a", inv([]));
    await sweep(w.deps(T0));
    w.libs.set("a", inv(["h"]));
    await sweep(w.deps(new Date(T0.getTime() + 10 * DAY)));
    w.libs.set("a", inv([]));
    await sweep(w.deps(new Date(T0.getTime() + 20 * DAY)));
    const r = await sweep(w.deps(new Date(T0.getTime() + 40 * DAY)));
    expect(r.deleted).toBe(0);
    expect(w.bucket.objects.has("blobs/h")).toBe(true);
  });

  test("if any library fails to answer, nothing is deleted", async () => {
    const w = world();
    await w.bucket.put("blobs/h", "x");
    w.libs.set("a", inv([]));
    await sweep(w.deps(T0));
    w.libs.set("b", new Error("overloaded"));
    const r = await sweep(w.deps(new Date(T0.getTime() + 40 * DAY)));
    expect(r.deleted).toBe(0);
    expect(r.skipped).toBe("1 of 2 libraries did not answer");
    expect(w.bucket.objects.has("blobs/h")).toBe(true);
    expect(digestText(r)).toContain("owner/b: did not answer (overloaded)");
  });

  test("the digest flags stale exports, overdue maintenance and full libraries", async () => {
    const w = world();
    w.libs.set("ok", inv([]));
    w.libs.set(
      "stale",
      inv([], {
        stats: {
          seq: 9,
          maintainers: { export: { lag: 4, last_run: "2026-09-25T03:00:00Z" } },
          next_run: "2026-09-26T03:00:00Z",
        },
      }),
    );
    w.libs.set("full", inv([], { bytes: 90 * 1048576 }));
    const r = await sweep(w.deps(T0));
    expect(r.attention).toEqual([
      "owner/stale: last export 2026-09-25T03:00:00Z, 4 events behind",
      "owner/stale: daily maintenance overdue since 2026-09-26T03:00:00Z",
      "owner/full: 90 MB of 100 MB",
    ]);
  });
});
