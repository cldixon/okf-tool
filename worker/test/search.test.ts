import { describe, expect, test } from "bun:test";
import { LibraryStore, searchMatch } from "../src/store/store";
import { library, md } from "./changes";
import { bunSqlHandle } from "./sqlite";

/** A library with a few pages to search (TEMPRA-17). */
function pages() {
  const lib = library();
  lib.store.apply(lib.ctx(), [
    {
      op: "write",
      path: "design-system.md",
      content: md("Design system", "Tokens for React and Svelte apps.\n"),
    },
    {
      op: "write",
      path: "comments.md",
      content: md("Comments", "A comment is a thread on a page.\n"),
    },
    {
      op: "write",
      path: "editor.md",
      content: md("Editor", "The editor was removed; people comment instead.\n"),
    },
    { op: "write", path: "misc.md", content: md("Misc", "Nothing about editing here at all.\n") },
  ]);
  return lib;
}

const paths = (r: { results: { path: string }[] }) => r.results.map((x) => x.path);

describe("search (TEMPRA-17)", () => {
  test("a query's words become an OR of quoted terms; phrases and prefixes keep their meaning", () => {
    expect(searchMatch("editor comments react")).toBe('"editor" OR "comments" OR "react"');
    expect(searchMatch('"design system" tokens')).toBe('"design system" OR "tokens"');
    expect(searchMatch("edit*")).toBe('"edit"*');
    // FTS5's own operators and stray quotes are plain words.
    expect(searchMatch('AND NOT a"b')).toBe('"AND" OR "NOT" OR "ab"');
    expect(searchMatch('   "" * ')).toBeNull();
  });

  test("a page matches with any of the words, not only all of them", () => {
    const lib = pages();
    // `react` is only in design-system.md and `editor` only in editor.md: before, this found none.
    expect(paths(lib.store.search("editor comments react")).sort()).toEqual([
      "comments.md",
      "design-system.md",
      "editor.md",
    ]);
    expect(paths(lib.store.search("react nothingmatches"))).toEqual(["design-system.md"]);
  });

  test("more matching words rank higher, and a title outranks the body", () => {
    const lib = pages();
    // editor.md has both words; comments.md has only one.
    expect(paths(lib.store.search("editor comment"))[0]).toBe("editor.md");
    // `comments` is comments.md's title and only body text elsewhere.
    expect(paths(lib.store.search("comments"))[0]).toBe("comments.md");
  });

  test("words are stemmed: comments finds comment, editing finds edit", () => {
    const lib = pages();
    expect(paths(lib.store.search("commenting")).sort()).toEqual(["comments.md", "editor.md"]);
    expect(paths(lib.store.search("edits"))).toContain("misc.md");
    // A quoted phrase is stemmed too, word by word.
    expect(paths(lib.store.search('"design systems"'))).toEqual(["design-system.md"]);
  });

  test("a library from before gets its search stemmed once, rows and rowids intact", () => {
    const lib = pages();
    // Back to the unstemmed index a library from before has.
    lib.db.run("CREATE VIRTUAL TABLE fts_old USING fts5(page_id UNINDEXED, title, body, tags)");
    lib.db.run(
      "INSERT INTO fts_old (page_id, title, body, tags) SELECT page_id, title, body, tags FROM fts",
    );
    lib.db.run("DROP TABLE fts");
    lib.db.run("ALTER TABLE fts_old RENAME TO fts");
    lib.db.run("DELETE FROM fts_rows");
    lib.db.run("INSERT INTO fts_rows (page_id, fts_rowid) SELECT page_id, rowid FROM fts");
    // A library from before has no marker that its search is stemmed (TEMPRA-293).
    lib.db.run("DELETE FROM meta WHERE key = 'fts_stemmed'");
    // Unstemmed, "commenting" matches nothing (opening a store would upgrade it, so ask SQL).
    const before = lib.db
      .query("SELECT COUNT(*) AS n FROM fts WHERE fts MATCH 'commenting'")
      .get() as {
      n: number;
    };
    expect(before.n).toBe(0);

    const reopened = lib.fresh();
    const def = lib.db.query("SELECT sql FROM sqlite_master WHERE name = 'fts'").get() as {
      sql: string;
    };
    expect(def.sql).toContain("porter");
    expect(paths(reopened.search("commenting")).sort()).toEqual(["comments.md", "editor.md"]);
    const unmapped = lib.db
      .query("SELECT COUNT(*) AS n FROM fts WHERE rowid NOT IN (SELECT fts_rowid FROM fts_rows)")
      .get() as { n: number };
    expect(unmapped.n).toBe(0);
    // A write after the upgrade replaces its row, not adds one.
    const v = reopened.read("misc.md");
    reopened.apply(lib.ctx(), [
      {
        op: "write",
        path: "misc.md",
        content: md("Misc", "Now about stemming.\n"),
        if_match: v.kind === "page" ? v.hash : null,
      },
    ]);
    const n = lib.db.query("SELECT COUNT(*) AS n FROM fts").get() as { n: number };
    expect(n.n).toBe(4);
    expect(paths(reopened.search("stemmed"))).toEqual(["misc.md"]);
    // Opening again does nothing more.
    expect(paths(lib.fresh().search("stemmed"))).toEqual(["misc.md"]);
  });

  test("an upgrade that fails leaves the library open, its search unstemmed but working", () => {
    const lib = pages();
    lib.db.run("CREATE VIRTUAL TABLE fts_old USING fts5(page_id UNINDEXED, title, body, tags)");
    lib.db.run(
      "INSERT INTO fts_old (page_id, title, body, tags) SELECT page_id, title, body, tags FROM fts",
    );
    lib.db.run("DROP TABLE fts");
    lib.db.run("ALTER TABLE fts_old RENAME TO fts");
    lib.db.run("DELETE FROM fts_rows");
    lib.db.run("INSERT INTO fts_rows (page_id, fts_rowid) SELECT page_id, rowid FROM fts");
    // A handle on which the rename fails, as a platform might refuse it.
    const sql = bunSqlHandle(lib.db);
    const failing = {
      ...sql,
      script: (q: string) => {
        if (q.includes("RENAME TO fts")) throw new Error("no rename here");
        sql.script(q);
      },
    };
    const store = new LibraryStore(failing, {});
    expect(paths(store.search("comments"))).toContain("comments.md");
    const def = lib.db.query("SELECT sql FROM sqlite_master WHERE name = 'fts'").get() as {
      sql: string;
    };
    expect(def.sql).not.toContain("porter");
    // Nothing half done: no stray table, every row still mapped.
    expect(
      lib.db.query("SELECT name FROM sqlite_master WHERE name = 'fts_stemmed'").get(),
    ).toBeNull();
    const unmapped = lib.db
      .query("SELECT COUNT(*) AS n FROM fts WHERE rowid NOT IN (SELECT fts_rowid FROM fts_rows)")
      .get() as { n: number };
    expect(unmapped.n).toBe(0);
  });
});
