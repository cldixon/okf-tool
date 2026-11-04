import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { sha256Hex } from "../src/format/hash";
import { FOOTNOTE_CODES, sameLint, sameTargets } from "../src/format/link-health";
import { nextMaintenance, runMaintenance, slotAtOrAfter } from "../src/maintain";
import { type ImportFile, LibraryStore } from "../src/store/store";
import { BUNDLES, loadBundle, text } from "./fixtures";
import { memoryBucket } from "./harness";
import { bunSqlHandle } from "./sqlite";

const ctx = (actor = "claude-code/test") => ({ actor, request_id: crypto.randomUUID() });
const T0 = Date.parse("2026-10-01T00:00:00Z");
const md = (title: string, body: string, sources = "") =>
  `---\ntype: Metric\nstatus: stable\ntitle: ${title}\ndescription: About ${title}.\n${sources}---\n${body}`;

function newStore() {
  const db = new Database(":memory:");
  return { db, s: new LibraryStore(bunSqlHandle(db), { now: () => new Date(T0) }) };
}

function importBundle(s: LibraryStore, b: string) {
  const files: ImportFile[] = loadBundle(b).map((f) =>
    f.path.endsWith(".md")
      ? { path: f.path, markdown: text(f.bytes) }
      : { path: f.path, blob: { hash: sha256Hex(f.bytes), size: f.bytes.length, media: null } },
  );
  s.import(ctx("human:importer"), files, `fixtures/${b}`);
}

/** The queue's link and lint items: what agents are asked to fix. */
const linkWork = (s: LibraryStore) =>
  s
    .work({ limit: 500 })
    .items.filter((i) => i.kind === "broken_link" || i.kind === "lint")
    .map((i) => `${i.kind} ${i.path}: ${i.detail}`)
    .sort();

/** Each page's stored lint and the flags the link checks own, as the write path left them. */
const linkState = (db: Database) => ({
  flags: db
    .query(
      "SELECT page_id, kind, since_seq, detail FROM flags WHERE kind IN ('broken_link', 'lint') ORDER BY page_id, kind",
    )
    .all(),
  lint: (
    db.query("SELECT page_id, lint FROM pages ORDER BY page_id").all() as {
      page_id: string;
      lint: string;
    }[]
  ).map((r) => ({
    id: r.page_id,
    lint: (JSON.parse(r.lint) as { code: string; message: string }[])
      .map((l) => `${l.code}: ${l.message}`)
      .sort(),
  })),
});

const hashOf = (s: LibraryStore, path: string) => {
  const r = s.read(path);
  return r.kind === "page" ? r.hash : "";
};

describe("link-health checks (TEMPRA-65)", () => {
  test("footnote codes, and comparisons that ignore order and duplicates", () => {
    expect([...FOOTNOTE_CODES].sort()).toEqual(["footnote_undefined", "footnote_unmatched"]);
    expect(sameTargets(["a.md", "a.md"], ["a.md"])).toBe(true);
    expect(sameTargets(["a.md"], ["b.md"])).toBe(false);
    expect(sameTargets([], [])).toBe(true);
    const x = { code: "x", message: "1" };
    const y = { code: "y", message: "2" };
    expect(sameLint([x, y], [y, x])).toBe(true);
    expect(sameLint([x], [y])).toBe(false);
  });
});

describe("the link-health process (TEMPRA-65)", () => {
  test("on Google's sample bundles the pass agrees with the write path: nothing to repair", () => {
    for (const b of BUNDLES) {
      const { s, db } = newStore();
      importBundle(s, b);
      const before = { work: linkWork(s), state: linkState(db) };
      const run = s.maintainLinks();
      expect({ b, repaired: run.repaired }).toEqual({ b, repaired: [] });
      expect(run.pending).toBe(false);
      expect(run.checked).toBe(s.summary().pages);
      expect({ work: linkWork(s), state: linkState(db) }).toEqual(before);
      // Nothing written since: the next run is skipped by its cursor.
      expect(s.maintainLinks()).toMatchObject({ skipped: true, checked: 0, repaired: [] });
    }
  });

  test("flags and lint that drifted are put back as the write path left them", () => {
    for (const b of BUNDLES) {
      const { s, db } = newStore();
      importBundle(s, b);
      // A link that breaks, a source that points nowhere and a dangling footnote, by writes.
      s.apply(ctx(), [
        {
          op: "write",
          path: "zz/a.md",
          content: md(
            "Alpha",
            "See [gone](/zz/gone.md) and [b](/zz/b.md).[^s]\n\n[^s]: A source.\n\n[^t]: Not cited.\n",
            "sources:\n  - id: s\n    title: Spec\n    resource: /zz/missing-source.md\n",
          ),
        },
        { op: "write", path: "zz/b.md", content: md("Beta", "Body [^nope].\n") },
      ]);
      s.maintainLinks();
      const want = { work: linkWork(s), state: linkState(db) };
      expect(want.work.join("\n")).toContain("links to missing /zz/gone.md, /zz/missing-source.md");
      expect(want.work.join("\n")).toContain("Footnote [^nope] has no matching");

      // Drift no write explains: flags lost, the links index pointing nowhere, lint stripped.
      // (The rest of the lint, such as a definition never cited, is the write path's alone.)
      const owned = /^(broken_link|footnote_unmatched|footnote_undefined)$/;
      const strip = (json: string) =>
        JSON.stringify((JSON.parse(json) as { code: string }[]).filter((l) => !owned.test(l.code)));
      db.run("DELETE FROM flags WHERE kind = 'broken_link'");
      for (const t of ["pages", "flags"]) {
        const col = t === "pages" ? "lint" : "detail";
        const where = t === "flags" ? " WHERE kind = 'lint'" : "";
        for (const r of db.query(`SELECT rowid, ${col} AS v FROM ${t}${where}`).all() as {
          rowid: number;
          v: string;
        }[]) {
          db.run(`UPDATE ${t} SET ${col} = ? WHERE rowid = ?`, [strip(r.v), r.rowid]);
        }
      }
      db.run("DELETE FROM flags WHERE kind = 'lint' AND detail = '[]'");
      db.run("UPDATE links SET to_id = NULL");
      expect(linkWork(s)).not.toEqual(want.work);

      // A new version of the checks walks the whole library again.
      db.run("UPDATE meta SET value = '0' WHERE key = 'maint:links_version'");
      const run = s.maintainLinks();
      expect(run.checked).toBe(s.summary().pages);
      expect(run.repaired.length).toBeGreaterThan(0);
      expect(run.broken_link).toBe(1);
      expect(run.footnote).toBeGreaterThanOrEqual(1);
      const after = linkState(db);
      expect(linkWork(s)).toEqual(want.work);
      expect(after.flags).toEqual(want.state.flags);
      // Stored lint: the link checks' own codes are back; other lint is the write path's.
      const own = (l: { id: string; lint: string[] }[]) =>
        l.map((c) => ({
          id: c.id,
          lint: c.lint.filter((x) =>
            /^(broken_link|footnote_unmatched|footnote_undefined):/.test(x),
          ),
        }));
      expect(own(after.lint)).toEqual(own(want.state.lint));
      // And it rests: run again, nothing to repair.
      db.run("UPDATE meta SET value = '0' WHERE key = 'maint:links_version'");
      expect(s.maintainLinks().repaired).toEqual([]);
    }
  });

  test("checks what changed since its cursor and the pages that link to it", () => {
    const { s, db } = newStore();
    s.apply(ctx(), [
      { op: "write", path: "a.md", content: md("A", "Hi.\n") },
      { op: "write", path: "b.md", content: md("B", "[a](/a.md)\n") },
      { op: "write", path: "c.md", content: md("C", "Alone.\n") },
      {
        op: "write",
        path: "d.md",
        content: md(
          "D",
          "Cites.[^s]\n\n[^s]: A.\n",
          "sources:\n  - id: s\n    title: A\n    resource: /a.md\n",
        ),
      },
    ]);
    expect(s.maintainLinks().checked).toBe(4);
    s.apply(ctx(), [{ op: "delete", path: "a.md", if_match: hashOf(s, "a.md") }]);
    // The write path flagged both at once; the pass checks them again and agrees.
    expect(linkWork(s)).toEqual([
      "broken_link b.md: links to missing /a.md",
      "broken_link d.md: links to missing /a.md",
    ]);
    // Lost between the write and the pass: the pass finds it from the stored tree.
    db.run(
      "DELETE FROM flags WHERE kind = 'broken_link' AND page_id = (SELECT page_id FROM paths WHERE path = 'd.md')",
    );
    const run = s.maintainLinks();
    expect(run).toMatchObject({ skipped: false, checked: 2, repaired: ["d.md"], broken_link: 2 });
    expect(linkWork(s)).toEqual([
      "broken_link b.md: links to missing /a.md",
      "broken_link d.md: links to missing /a.md",
    ]);
    // A move: the page that moved and what links to it are checked.
    s.apply(ctx(), [{ op: "write", path: "a.md", content: md("A", "Back.\n") }]);
    expect(linkWork(s)).toEqual([]);
    s.apply(ctx(), [{ op: "move", path: "a.md", to: "x/a.md" }]);
    const moved = s.maintainLinks();
    expect(moved).toMatchObject({ checked: 3, repaired: [], broken_link: 0 });
    expect(linkWork(s)).toEqual([]);
    // Nothing written since: skipped (c.md, never touched, was checked once only).
    expect(s.maintainLinks().skipped).toBe(true);
  });

  test("a walk over a large library is budgeted, resumes, and wakes the next slot", () => {
    const { s } = newStore();
    const ops = [];
    for (let i = 0; i < 25; i++) {
      ops.push({
        op: "write" as const,
        path: `d/c${String(i).padStart(2, "0")}.md`,
        content: md(`C${i}`, `[next](/d/c${String(i + 1).padStart(2, "0")}.md)\n`),
      });
    }
    s.apply(ctx(), ops);
    const first = s.maintainLinks(10);
    expect(first).toMatchObject({ checked: 10, pending: true, broken_link: 1 });
    expect(s.maintenanceDue(new Date(T0)).processPending).toBe(true);
    expect(s.stats().maintainers.links).toMatchObject({ kind: "process", pending: true, lag: 0 });
    // The next slot, not the heartbeat a week away.
    const due = s.maintenanceDue(new Date(T0));
    const next = nextMaintenance(new Date(T0), "lib-w", { ...due, exportPending: false });
    expect(next.getTime()).toBe(slotAtOrAfter(T0 + 1, "lib-w").getTime());
    // Changes since the cursor go first, then the walk carries on where it stopped.
    s.apply(ctx(), [
      {
        op: "write",
        path: "d/c00.md",
        content: md("C0", "Edited.\n"),
        if_match: hashOf(s, "d/c00.md"),
      },
    ]);
    expect(s.maintainLinks(10)).toMatchObject({ checked: 10, pending: true });
    expect(s.maintainLinks(10)).toMatchObject({ checked: 6, pending: false });
    expect(s.maintenanceDue(new Date(T0)).processPending).toBe(false);
    expect(s.maintainLinks(10).skipped).toBe(true);
    // More changes than one pass checks: a walk from the start instead.
    const edits = [];
    for (let i = 0; i < 12; i++) {
      const p = `d/c${String(i).padStart(2, "0")}.md`;
      edits.push({
        op: "write" as const,
        path: p,
        content: md(`C${i}`, "Edited again.\n"),
        if_match: hashOf(s, p),
      });
    }
    s.apply(ctx(), edits);
    expect(s.maintainLinks(10)).toMatchObject({ checked: 10, pending: true });
  });

  test("the daily pass runs it after structure and before health, and /stats lists it", async () => {
    const { s } = newStore();
    s.apply(ctx(), [{ op: "write", path: "a.md", content: md("A", "[gone](/gone.md)\n") }]);
    expect(s.stats().maintainers.links).toMatchObject({ last_run: null, cursor: 0, lag: 1 });
    const res = await runMaintenance({
      store: s,
      bucket: memoryBucket(),
      libraryId: "lib-l",
      now: new Date(T0),
    });
    expect(res.links).toEqual({
      skipped: false,
      checked: 1,
      repaired: [],
      broken_link: 1,
      footnote: 0,
      pending: false,
    });
    expect(res.health.counts.broken_link).toBe(1);
    expect(s.stats().maintainers.links).toEqual({
      kind: "process",
      cursor: 1,
      lag: 0,
      last_run: "2026-10-01T00:00:00Z",
      pending: false,
      checked: 1,
      repaired: 0,
      broken_link: 1,
      footnote: 0,
    });
  });
});
