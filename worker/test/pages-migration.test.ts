import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { RETIRED_LINT, SCHEMA_VERSION } from "../src/store/schema";
import { LibraryStore } from "../src/store/store";
import { bunSqlHandle } from "./sqlite";

/**
 * A library stored in schema version 1 (concepts, `concept_id`), made by the store as it was
 * before the pages rename (tempra-dev: decisions/pages-not-okf): Google's acme_retail bundle
 * imported, two pages written (one moved), a thread on a quote with a reply, a thread on the
 * library, a person's verification, reads on two surfaces, and lint and structure flags,
 * including codes that are now retired.
 */
const V1 = join(import.meta.dir, "data/library-v1.sqlite");

const load = () => Database.deserialize(readFileSync(V1));
const count = (db: Database, sql: string) => (db.query(sql).get() as { n: number }).n;
const tableSql = (db: Database, name: string) =>
  (db.query("SELECT sql FROM sqlite_master WHERE name = ?").get(name) as { sql: string } | null)
    ?.sql ?? null;
const open = (db: Database) =>
  new LibraryStore(bunSqlHandle(db), { now: () => new Date("2026-10-07T00:00:00Z") });

describe("schema version 1 to 2: concepts become pages", () => {
  test("every row survives under its new name, and nothing names a concept", () => {
    const db = load();
    const before = {
      concepts: count(db, "SELECT COUNT(*) AS n FROM concepts"),
      paths: count(db, "SELECT COUNT(*) AS n FROM paths"),
      conceptPaths: count(db, "SELECT COUNT(*) AS n FROM paths WHERE kind = 'concept'"),
      events: count(db, "SELECT COUNT(*) AS n FROM events"),
      threads: count(db, "SELECT COUNT(*) AS n FROM threads"),
      comments: count(db, "SELECT COUNT(*) AS n FROM comments"),
      verifications: count(db, "SELECT COUNT(*) AS n FROM verifications"),
      fts: count(db, "SELECT COUNT(*) AS n FROM fts"),
      reads: count(db, "SELECT COUNT(*) AS n FROM access_log"),
      lastRead: count(db, "SELECT COUNT(*) AS n FROM last_read"),
      sources: count(db, "SELECT COUNT(*) AS n FROM sources"),
      tags: count(db, "SELECT COUNT(*) AS n FROM tags"),
      redirects: count(db, "SELECT COUNT(*) AS n FROM redirects"),
    };
    expect(before.conceptPaths).toBeGreaterThan(0);
    expect(before.threads).toBe(2);

    open(db);

    expect(
      (db.query("SELECT value FROM meta WHERE key = 'schema_version'").get() as { value: string })
        .value,
    ).toBe(String(SCHEMA_VERSION));
    expect(tableSql(db, "concepts")).toBeNull();
    const schema = (
      db.query("SELECT sql FROM sqlite_master WHERE sql IS NOT NULL").all() as {
        sql: string;
      }[]
    )
      .map((r) => r.sql)
      .join("\n");
    expect(schema).not.toMatch(/concept/i);
    expect(tableSql(db, "pages")).not.toMatch(/\btype\b/);

    expect(count(db, "SELECT COUNT(*) AS n FROM pages")).toBe(before.concepts);
    expect(count(db, "SELECT COUNT(*) AS n FROM paths")).toBe(before.paths);
    expect(count(db, "SELECT COUNT(*) AS n FROM paths WHERE kind = 'page'")).toBe(
      before.conceptPaths,
    );
    expect(count(db, "SELECT COUNT(*) AS n FROM events")).toBe(before.events);
    expect(count(db, "SELECT COUNT(*) AS n FROM threads")).toBe(before.threads);
    expect(count(db, "SELECT COUNT(*) AS n FROM comments")).toBe(before.comments);
    expect(count(db, "SELECT COUNT(*) AS n FROM verifications")).toBe(before.verifications);
    expect(count(db, "SELECT COUNT(*) AS n FROM fts")).toBe(before.fts);
    expect(count(db, "SELECT COUNT(*) AS n FROM fts_rows")).toBe(before.fts);
    expect(count(db, "SELECT COUNT(*) AS n FROM access_log")).toBe(before.reads);
    expect(count(db, "SELECT COUNT(*) AS n FROM last_read")).toBe(before.lastRead);
    expect(count(db, "SELECT COUNT(*) AS n FROM sources")).toBe(before.sources);
    expect(count(db, "SELECT COUNT(*) AS n FROM tags")).toBe(before.tags);
    expect(count(db, "SELECT COUNT(*) AS n FROM redirects")).toBe(before.redirects);
    // Every page row still belongs to a path, and every fts row to its page.
    expect(
      count(db, "SELECT COUNT(*) AS n FROM pages WHERE page_id NOT IN (SELECT page_id FROM paths)"),
    ).toBe(0);
    expect(
      count(
        db,
        "SELECT COUNT(*) AS n FROM fts_rows r JOIN fts f ON f.rowid = r.fts_rowid WHERE f.page_id <> r.page_id",
      ),
    ).toBe(0);
  });

  test("the library reads, searches and works as before", () => {
    const db = load();
    const s = open(db);

    const margin = s.read("notes/margin.md");
    expect(margin.kind).toBe("page");
    expect(margin.kind === "page" && margin.markdown).toContain("type: Metric");
    // A page's type is an ordinary field now: kept in its frontmatter.
    expect(s.read("notes/deep/only.md").kind).toBe("page");
    expect(s.outline().files.every((f) => f.kind === "page" || f.kind === "attachment")).toBe(true);
    expect(s.search("revenue minus cost").results.map((i) => i.path)).toContain("notes/margin.md");
    expect(s.search("margins").results.length).toBeGreaterThan(0);
    expect(s.history("notes/deep/only.md").events.length).toBeGreaterThan(1);

    const threads = s.comments({ status: "open" });
    expect(threads.threads.length).toBe(2);
    const onPage = threads.threads.find((t) => t.path === "notes/margin.md");
    expect(onPage?.located).toBeTruthy();
    expect(s.comments({ path: "" }).threads.length).toBe(1);

    // Retired lint is gone from what agents see and from the work queue; the rest stays.
    const lint = margin.kind === "page" ? margin.lint.map((l) => l.code) : [];
    expect(lint).toContain("footnote_unmatched");
    for (const code of lint) expect(RETIRED_LINT.has(code)).toBe(false);
    const details = s
      .work({ limit: 500 })
      .items.filter((i) => i.kind === "lint")
      .map((i) => i.detail)
      .join("\n");
    for (const code of RETIRED_LINT) expect(details).not.toContain(code);
    // Structure was checked again on open, by the checks as they are now.
    const structure = db
      .query("SELECT detail FROM flags WHERE kind = 'structure'")
      .all()
      .map((r) => (r as { detail: string }).detail)
      .join("\n");
    expect(structure).not.toContain("orphans");
    expect(structure).not.toContain("no_concepts");
    expect(structure).not.toContain("single_concept");
  });

  test("opening again changes nothing", () => {
    const db = load();
    open(db);
    const snapshot = () =>
      ["pages", "paths", "events", "flags", "threads", "fts_rows", "meta"].map((t) =>
        db.query(`SELECT * FROM ${t} ORDER BY rowid`).all(),
      );
    const first = JSON.stringify(snapshot());
    open(db);
    expect(JSON.stringify(snapshot())).toBe(first);
  });

  test("a new library starts at version 2 with no concept in its schema", () => {
    const db = new Database(":memory:");
    open(db);
    const schema = (
      db.query("SELECT sql FROM sqlite_master WHERE sql IS NOT NULL").all() as {
        sql: string;
      }[]
    )
      .map((r) => r.sql)
      .join("\n");
    expect(schema).not.toMatch(/concept/i);
    expect(
      (db.query("SELECT value FROM meta WHERE key = 'schema_version'").get() as { value: string })
        .value,
    ).toBe("2");
  });
});
