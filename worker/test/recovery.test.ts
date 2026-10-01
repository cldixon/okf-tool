import { describe, expect, test } from "bun:test";
import { runMaintenance } from "../src/maintain";
import { checkRestoreTime, prepareRestore } from "../src/recovery";
import { LibraryStore } from "../src/store/store";
import { readTar } from "../src/util/tar";
import { fakeRecovery, memoryBlobs, memoryBucket, setup } from "./harness";
import { bunSqlHandle } from "./sqlite";

type S = ReturnType<typeof setup>;
const LIB = "/app/libraries/demo";
const ORIGIN = "http://localhost";
const md = (body: string) => `---\ntype: Note\n---\n${body}`;
const ctx = () => ({ actor: "claude-code/test", request_id: crypto.randomUUID() });

async function put(s: S, path: string, content: string) {
  const r = await s.req(`/files/${path}`, {
    method: "PUT",
    headers: { "Content-Type": "text/markdown" },
    body: content,
  });
  expect(r.status).toBeLessThan(300);
}

function post(s: S, fields: Record<string, string>, origin = ORIGIN) {
  return s.app.request(`${LIB}/recovery`, {
    method: "POST",
    headers: { Origin: origin },
    body: new URLSearchParams(fields),
  });
}

const minutesAgo = (n: number) => new Date(Date.now() - n * 60_000).toISOString().slice(0, 19);

describe("point-in-time restore (spec: Backups and recovery)", () => {
  test("the requested time must be a past instant inside the 30-day window", () => {
    const now = new Date("2026-09-30T18:00:00Z");
    expect(checkRestoreTime("2026-09-30T17:00:00Z", now)).toEqual(new Date("2026-09-30T17:00:00Z"));
    expect(checkRestoreTime("2026-09-30T19:00:00+02:00", now)).toBeInstanceOf(Date);
    expect(checkRestoreTime("2026-09-30", now)).toContain("full ISO 8601 datetime");
    expect(checkRestoreTime("2026-09-30T19:00:00Z", now)).toContain("in the past");
    expect(checkRestoreTime("2026-08-01T00:00:00Z", now)).toContain("30 days");
  });

  test("a restore exports first, arms the bookmark and records itself in R2", async () => {
    const store = new LibraryStore(bunSqlHandle());
    const bucket = memoryBucket();
    const recovery = fakeRecovery();
    store.apply(ctx(), [{ op: "write", path: "a.md", content: md("A\n") }]);
    const now = new Date("2026-09-30T18:02:11Z");
    const out = await prepareRestore({
      store,
      blobs: memoryBlobs(),
      bucket,
      recovery,
      libraryId: "lib-x",
      target: { to: "2026-09-30T17:00:00Z" },
      actor: "human:owner",
      now,
    });
    expect(out).toMatchObject({
      ok: true,
      record: {
        id: "20260930T180211Z",
        kind: "restore",
        to: "2026-09-30T17:00:00Z",
        actor: "human:owner",
        seq_before: 1,
        export: "exports/lib-x/2026-09-30-pre-restore-180211/",
        bookmark: "bookmark@2026-09-30T17:00:00.000Z",
      },
    });
    expect(recovery.armed).toEqual(["bookmark@2026-09-30T17:00:00.000Z"]);
    const folder = "exports/lib-x/2026-09-30-pre-restore-180211/";
    const tar = readTar(bucket.objects.get(`${folder}bundle.tar`) as Uint8Array);
    expect(tar.map((f) => f.path)).toContain("a.md");
    expect(bucket.objects.has(`${folder}ledger.jsonl`)).toBe(true);
    const manifest = JSON.parse(
      new TextDecoder().decode(bucket.objects.get(`${folder}manifest.json`)),
    );
    expect(manifest).toMatchObject({ kind: "pre-restore", seq: 1 });
    expect(bucket.objects.has("restores/lib-x/20260930T180211Z.json")).toBe(true);

    // The nightly export still sorts after a same-day pre-restore folder, so it counts as newest.
    const nightly = await runMaintenance({
      store,
      blobs: memoryBlobs(),
      bucket,
      libraryId: "lib-x",
      now,
      retentionDays: 0,
    });
    expect(nightly.deleted).toEqual([]);
  });

  test("without point-in-time recovery, nothing is written", async () => {
    const store = new LibraryStore(bunSqlHandle());
    const bucket = memoryBucket();
    const out = await prepareRestore({
      store,
      blobs: memoryBlobs(),
      bucket,
      recovery: fakeRecovery({ unsupported: true }),
      libraryId: "lib-x",
      target: { to: new Date(Date.now() - 60_000).toISOString() },
      actor: "human:owner",
      now: new Date(),
    });
    expect(out).toMatchObject({ ok: false, status: 501, code: "no_pitr" });
    expect(bucket.objects.size).toBe(0);
  });

  test("the Recovery page: confirm by name, restore, list, undo", async () => {
    const s = setup();
    await put(s, "a.md", md("A\n"));
    const pageRes = await s.app.request(`${LIB}/recovery`);
    const html = await pageRes.text();
    expect(pageRes.status).toBe(200);
    expect(html).toContain("Restore this library to a point in time");
    expect(html).toContain("<strong>Recovery</strong>");
    expect(html).toContain("claude-code/test"); // recent requests help pick a time

    // Cross-origin posts are refused; a wrong name changes nothing.
    expect(
      (await post(s, { to: minutesAgo(5), confirm: "demo" }, "https://evil.example")).status,
    ).toBe(403);
    const wrong = await post(s, { to: minutesAgo(5), confirm: "dem" });
    expect(wrong.status).toBe(400);
    expect(await wrong.text()).toContain("Type the library&#39;s name, demo, to confirm.");
    expect(s.pitr.armed).toEqual([]);

    // A datetime-local value has no offset; the page treats it as UTC.
    const to = minutesAgo(5);
    const ok = await post(s, { to, confirm: "demo" });
    const okHtml = await ok.text();
    expect(ok.status).toBe(200);
    expect(okHtml).toContain(`Restored demo to ${to}Z.`);
    expect(s.pitr.armed).toEqual([`bookmark@${to}.000Z`]);
    expect(okHtml).toContain("Undo");
    const id = /name="undo" value="([^"]+)"/.exec(okHtml)?.[1] as string;
    expect(id).toMatch(/^\d{8}T\d{6}Z$/);

    // The pre-restore export downloads like a nightly one.
    const folder = /exports\/(\d{4}-\d{2}-\d{2}-pre-restore-\d{6})\/bundle\.tar/.exec(okHtml)?.[1];
    expect(folder).toBeDefined();
    const dl = await s.app.request(`${LIB}/exports/${folder}/bundle.tar`);
    expect(dl.status).toBe(200);
    const transfer = await (await s.app.request(`${LIB}/transfer`)).text();
    expect(transfer).toContain("before a restore");

    // A time outside the window is refused with the reason.
    const old = await post(s, { to: "2020-01-01T00:00", confirm: "demo" });
    expect(old.status).toBe(400);
    expect(await old.text()).toContain("30 days");

    // Undo arms the bookmark the restore returned.
    const undo = await post(s, { undo: id, confirm: "demo" });
    const undoHtml = await undo.text();
    expect(undo.status).toBe(200);
    expect(undoHtml).toContain("Undone: demo is back to how it was before that restore.");
    expect(s.pitr.armed[1]).toMatch(/^undo@/);
    expect(undoHtml).toContain("Undid the restore made");

    const missing = await post(s, { undo: "20200101T000000Z", confirm: "demo" });
    expect(missing.status).toBe(404);
  });
});
