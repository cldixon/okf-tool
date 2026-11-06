import { describe, expect, test } from "bun:test";
import { library, md } from "./changes";

// TEMPRA-293: a write rewrites only the index rows that changed. Production's edits wrote about
// 80 rows each because every one deleted and reinserted the page's sources, links and tags, and
// refreshed the lint of every page linking to it. Rowids show which rows were left alone.

const SOURCES = `sources:
  - id: a
    title: A
    resource: https://example.com/a
  - id: b
    title: B
    resource: https://example.com/b
  - id: c
    title: C
    resource: /other.md
tags: [one, two]
`;

const BODY = "See [other](/other.md) and [x](/x.md#top).[^a][^b]\n\n[^a]: A.\n\n[^b]: B.\n";

function setup() {
  const lib = library();
  lib.store.apply(lib.ctx(), [
    { op: "write", path: "other.md", content: md("Other", "Back to [page](/page.md).\n") },
    { op: "write", path: "page.md", content: md("Page", BODY, SOURCES) },
  ]);
  return lib;
}

type Rows = { rid: number; [k: string]: unknown }[];
const rows = (lib: ReturnType<typeof library>, table: string, key: string, path: string) =>
  lib.db
    .query(
      `SELECT t.rowid AS rid, t.* FROM ${table} t JOIN paths p ON p.page_id = t.${key}
       WHERE p.path = ? ORDER BY t.rowid`,
    )
    .all(path) as Rows;
const rids = (r: Rows) => r.map((x) => x.rid);
const strip = (r: Rows) => r.map(({ rid: _, ...rest }) => rest);

function edit(lib: ReturnType<typeof library>, path: string, old: string, next: string) {
  const v = lib.fresh().read(path);
  if (v.kind !== "page") throw new Error("not a page");
  return lib.store.apply(lib.ctx(), [
    { op: "write", path, content: v.markdown.replace(old, next), if_match: v.hash },
  ]);
}

describe("a write rewrites only the index rows that changed (TEMPRA-293)", () => {
  test("an edit of the text keeps every source, link and tag row as it was", () => {
    const lib = setup();
    const before = ["sources", "links", "tags"].map((t) =>
      rows(lib, t, t === "links" ? "from_id" : "page_id", "page.md"),
    );
    edit(lib, "page.md", "See [other]", "Do see [other]");
    const after = ["sources", "links", "tags"].map((t) =>
      rows(lib, t, t === "links" ? "from_id" : "page_id", "page.md"),
    );
    for (const [i, b] of before.entries()) {
      expect(rids(after[i] ?? [])).toEqual(rids(b));
      expect(strip(after[i] ?? [])).toEqual(strip(b));
    }
  });

  test("what did change is replaced, and the rows match a page written afresh", () => {
    const lib = setup();
    const kept = rows(lib, "sources", "page_id", "page.md").find((r) => r.id === "a")?.rid;
    // Drop source b and its footnote, add d, change a tag, add and drop a link.
    const v = lib.fresh().read("page.md");
    if (v.kind !== "page") throw new Error("not a page");
    const next = v.markdown
      .replace(/ {2}- id: b\n {4}title: B\n {4}resource: https:\/\/example\.com\/b\n/, "")
      .replace(
        "    resource: /other.md\n",
        "    resource: /other.md\n  - id: d\n    title: D\n    resource: https://example.com/d\n",
      )
      .replace("tags: [one, two]", "tags: [one, three]")
      .replace("[^a][^b]", "[^a][^d] Also [new](/new.md).")
      .replace("[^b]: B.", "[^d]: D.");
    lib.store.apply(lib.ctx(), [{ op: "write", path: "page.md", content: next, if_match: v.hash }]);

    const sources = rows(lib, "sources", "page_id", "page.md");
    expect(sources.map((s) => s.id).sort()).toEqual(["a", "c", "d"]);
    expect(sources.find((s) => s.id === "a")?.rid).toBe(kept ?? -1);
    expect(sources.find((s) => s.id === "d")?.cited).toBe(1);
    expect(
      rows(lib, "tags", "page_id", "page.md")
        .map((t) => t.tag)
        .sort(),
    ).toEqual(["one", "three"]);
    expect(
      rows(lib, "links", "from_id", "page.md")
        .map((l) => l.to_path)
        .sort(),
    ).toEqual(["new.md", "other.md", "other.md", "x.md"]);

    // The same page written into a fresh library indexes to the same rows, order and its
    // page ids (random per library) aside.
    const twin = library();
    twin.store.apply(twin.ctx(), [
      { op: "write", path: "other.md", content: md("Other", "Back to [page](/page.md).\n") },
      { op: "write", path: "page.md", content: next },
    ]);
    for (const [t, key] of [
      ["sources", "page_id"],
      ["links", "from_id"],
      ["tags", "page_id"],
    ] as const) {
      const norm = (r: Rows) =>
        strip(r)
          .map(({ page_id: _p, from_id: _f, to_id: _t, internal_id: _i, ...x }) =>
            JSON.stringify(x),
          )
          .sort();
      expect(norm(rows(lib, t, key, "page.md"))).toEqual(norm(rows(twin, t, key, "page.md")));
    }
  });

  test("an edit at the same path leaves the pages linking to it alone", () => {
    const lib = setup();
    const lint = () =>
      lib.db
        .query("SELECT c.lint FROM pages c JOIN paths p ON p.page_id = c.page_id WHERE p.path = ?")
        .get("other.md") as { lint: string };
    const before = lint();
    const changes = () => (lib.db.query("SELECT total_changes() AS n").get() as { n: number }).n;
    edit(lib, "page.md", "See [other]", "Do see [other]");
    const n1 = changes();
    // other.md links to page.md; its lint and flags are untouched, and still right.
    expect(lint()).toEqual(before);
    edit(lib, "page.md", "Do see [other]", "See [other]");
    expect(changes()).toBeGreaterThan(n1);
    expect(lint()).toEqual(before);
  });

  test("a page made at a path others already link to still mends their links", () => {
    const lib = setup();
    // page.md links to /x.md, which does not exist yet: broken.
    const broken = () =>
      lib.db
        .query(
          "SELECT f.detail FROM flags f JOIN paths p ON p.page_id = f.page_id WHERE p.path = ? AND f.kind = 'broken_link'",
        )
        .get("page.md") as { detail: string } | null;
    expect(broken()?.detail).toContain("x.md");
    lib.store.apply(lib.ctx(), [{ op: "write", path: "x.md", content: md("X", "# Top\n") }]);
    expect(broken()).toBeNull();
  });
});
