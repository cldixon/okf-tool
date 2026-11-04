import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import type { SqlHandle } from "../src/store/sql";
import { LibraryStore } from "../src/store/store";
import { changes, DAY, library, md } from "./changes";
import { bunSqlHandle } from "./sqlite";

/**
 * TEMPRA-87: a write costs what it changes, not a listing of every file; a page read does not
 * write. Checked by the statements the store sends, and against a fresh store's answers.
 */

/** bun:sqlite that records every statement sent to it. */
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
/** A statement that reads every row of `paths`: no WHERE, or one not on an indexed column. */
const listsPaths = (q: string) =>
  /\bFROM paths\b(?![\s\S]*\bWHERE\b)/i.test(q.replace(/\s+/g, " "));
/** The statement that loads the head snapshot: every file's row. */
const loadsHead = (q: string) =>
  q.replace(/\s+/g, " ").trim() === "SELECT path, page_id, hash, kind, last_seq AS seq FROM paths";
const ctx = () => ({ actor: "claude-code/test", request_id: crypto.randomUUID() });

describe("a write costs what it changes (TEMPRA-87)", () => {
  test("no statement of a write lists every file", () => {
    const { sql, sent } = recorded();
    const store = new LibraryStore(sql, { now: () => new Date("2026-10-01T00:00:00Z") });
    const ops = Array.from({ length: 30 }, (_, i) => ({
      op: "write" as const,
      path: `d${i % 3}/c${i}.md`,
      content: md(
        `T ${i}`,
        `# C${i}\n\n## Details\n\nSee [next](/d${(i + 1) % 3}/c${i + 1}.md#details).\n`,
      ),
    }));
    store.apply(ctx(), ops);
    store.read("d0/c0.md");
    sent.length = 0;
    const cur = store.read("d1/c1.md");
    sent.length = 0;
    store.apply(ctx(), [
      {
        op: "write",
        path: "d1/c1.md",
        content: md("T 1", "# C1\n\nSee [two](/d2/c2.md#nope) and [gone](/d2/gone.md).\n"),
        if_match: cur.kind === "page" ? cur.hash : null,
      },
    ]);
    expect(sent.filter(listsPaths)).toEqual([]);
    // Nor do the reads after it: the head is kept up to date in memory, not listed again.
    sent.length = 0;
    const after = store.read("d1/c1.md");
    store.summary();
    store.work();
    expect(sent.filter(loadsHead)).toEqual([]);
    const codes = after.kind === "page" ? after.lint.map((l) => l.code) : [];
    expect(codes).toContain("broken_link");
    expect(codes).toContain("missing_heading");
  });

  test("the head kept in memory reads as a fresh store's, after every kind of change", () => {
    const lib = library();
    for (const step of changes(lib)) {
      const fresh = lib.fresh();
      expect({ step, outline: lib.store.outline() }).toEqual({ step, outline: fresh.outline() });
      expect({ step, tree: lib.store.tree() }).toEqual({ step, tree: fresh.tree() });
      for (const f of fresh.outline().files) {
        expect({ step, file: lib.store.read(f.path) }).toEqual({
          step,
          file: fresh.read(f.path),
        });
      }
      expect({ step, work: lib.store.work({ limit: 500 }) }).toEqual({
        step,
        work: fresh.work({ limit: 500 }),
      });
    }
  });
});

describe("search rows found by rowid (TEMPRA-87)", () => {
  const rows = (db: Database) => ({
    fts: (db.query("SELECT COUNT(*) AS n FROM fts").get() as { n: number }).n,
    mapped: (db.query("SELECT COUNT(*) AS n FROM fts_rows").get() as { n: number }).n,
    unmapped: (
      db
        .query("SELECT COUNT(*) AS n FROM fts WHERE rowid NOT IN (SELECT fts_rowid FROM fts_rows)")
        .get() as { n: number }
    ).n,
    pages: (db.query("SELECT COUNT(*) AS n FROM paths WHERE kind = 'page'").get() as { n: number })
      .n,
  });

  test("one search row per page, replaced in place, after every kind of change", () => {
    const lib = library();
    for (const step of changes(lib)) {
      const r = rows(lib.db);
      expect({ step, ...r }).toEqual({
        step,
        fts: r.pages,
        mapped: r.pages,
        unmapped: 0,
        pages: r.pages,
      });
      for (const q of ["Details", "one", "missing", "Back"]) {
        expect({ step, q, hits: lib.store.search(q) }).toEqual({
          step,
          q,
          hits: lib.fresh().search(q),
        });
      }
    }
  });

  test("a library from before gets the rowids its search rows have", () => {
    const lib = library();
    for (const _ of changes(lib)) {
      // Every change.
    }
    const before = lib.store.search("Details");
    lib.db.run("DROP TABLE fts_rows");
    lib.db.run("DELETE FROM meta WHERE key = 'fts_rows'");
    const reopened = lib.fresh();
    expect(rows(lib.db).unmapped).toBe(0);
    expect(reopened.search("Details")).toEqual(before);
    const v = reopened.read("a/two.md");
    reopened.apply(lib.ctx(), [
      {
        op: "write",
        path: "a/two.md",
        content: md("T two", "# Two\n\nRewritten.\n"),
        if_match: v.kind === "page" ? v.hash : null,
      },
    ]);
    const r = rows(lib.db);
    expect(r).toEqual({ fts: r.pages, mapped: r.pages, unmapped: 0, pages: r.pages });
    expect(reopened.search("Rewritten").results.map((h) => h.path)).toEqual(["a/two.md"]);
  });
});

describe("a page read does not write (TEMPRA-87)", () => {
  test("reads are counted in memory, and usage_count is the same", () => {
    const { db, sql, sent } = recorded();
    const clock = { t: Date.parse("2026-10-01T00:00:00Z") };
    const store = new LibraryStore(sql, { now: () => new Date(clock.t) });
    store.apply(ctx(), [
      { op: "write", path: "p.md", content: md("T p", "Policy.\n") },
      {
        op: "write",
        path: "m.md",
        content: `---\ntype: Note\nsources:\n  - { id: p, resource: /p.md }\n---\nUses it.[^p]\n\n[^p]: p\n`,
      },
    ]);
    sent.length = 0;
    for (let i = 0; i < 5; i++) store.read("p.md");
    store.read("p.md", { at: 1 });
    expect(writes(sent)).toEqual([]);
    const logged = () =>
      (db.query("SELECT COALESCE(SUM(reads), 0) AS n FROM access_log").get() as { n: number }).n;
    expect(logged()).toBe(0);
    expect(store.pendingReads()).toBe(5);
    const usage = () =>
      (store.sources("m.md").sources[0]?.internal as { usage_count: number } | undefined)
        ?.usage_count;
    expect(usage()).toBe(5);
    const computed = store.read("p.md", { computed: true });
    expect(computed.kind === "page" && computed.markdown).toContain("usage_count: 5");

    // Flushed by the next write, then counted the same.
    store.apply(ctx(), [{ op: "write", path: "x.md", content: md("T x", "x\n") }]);
    expect(store.pendingReads()).toBe(0);
    expect(logged()).toBe(6);
    expect(usage()).toBe(6);

    // Flushed every 100 reads.
    for (let i = 0; i < 100; i++) store.read("p.md");
    expect(logged()).toBe(106);
    expect(store.pendingReads()).toBe(0);

    // Flushed on its own, as the alarm does, and before the usage pass drops old counts.
    store.read("p.md");
    store.flushReads();
    expect(logged()).toBe(107);
    store.read("p.md");
    clock.t += 40 * DAY;
    expect(usage()).toBe(0);
    store.pruneUsage();
    expect(logged()).toBe(0);
    expect(store.pendingReads()).toBe(0);
  });

  test("counts kept over midnight go to each day's row", () => {
    const db = new Database(":memory:");
    const clock = { t: Date.parse("2026-10-01T23:59:00Z") };
    const store = new LibraryStore(bunSqlHandle(db), { now: () => new Date(clock.t) });
    store.apply(ctx(), [
      { op: "write", path: "p.md", content: md("T p", "Policy.\n") },
      {
        op: "write",
        path: "m.md",
        content:
          "---\ntype: Note\nsources:\n  - { id: p, resource: /p.md }\n---\nUses it.[^p]\n\n[^p]: p\n",
      },
    ]);
    store.read("p.md");
    clock.t += 2 * 60_000;
    store.read("p.md");
    store.read("p.md");
    const usage = () =>
      (store.sources("m.md").sources[0]?.internal as { usage_count: number } | undefined)
        ?.usage_count;
    expect(usage()).toBe(3);
    expect(store.flushReads()).toBe(3);
    expect(db.query("SELECT day, reads FROM access_log ORDER BY day").all()).toEqual([
      { day: "2026-10-01", reads: 1 },
      { day: "2026-10-02", reads: 2 },
    ]);
    expect(usage()).toBe(3);
  });
});
