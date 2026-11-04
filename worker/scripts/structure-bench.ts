/**
 * Times the structure and health processes on a synthetic library (TEMPRA-64, TEMPRA-66):
 * `bun scripts/structure-bench.ts [pages]` writes that many pages (default 5000) under
 * bun:sqlite in 50 directories, some with no description, some with a long one, some linked to
 * by nothing, then times a full run, a run with nothing new (skipped by its cursor), a run after
 * one write, one write's own refresh (in a directory and at the root), the work queue's structure
 * items and the health summary.
 */
import { LibraryStore } from "../src/store/store";
import { bunSqlHandle } from "../test/sqlite";

const n = Number(process.argv[2] ?? 5000);
const store = new LibraryStore(bunSqlHandle(), {
  now: () => new Date("2026-10-01T00:00:00Z"),
  pageCap: n + 10,
});

const ms = <T>(f: () => T) => {
  const t = performance.now();
  const out = f();
  return [Math.round((performance.now() - t) * 10) / 10, out] as const;
};

const page = (j: number, extra = "") => {
  const description =
    j % 17 === 0
      ? ""
      : j % 23 === 0
        ? `description: ${"Long. ".repeat(40)}\n`
        : `description: Page ${j}.\n`;
  // Every third page links on; the rest are reached only from their neighbours or not at all.
  const link = j % 3 === 0 ? ` See [next](/d${(j + 1) % 50}/c${j + 1}.md).` : "";
  return `---\ntype: Metric\ntitle: C${j}\n${description}status: stable\n---\nBody of ${j}.${link}${extra}\n`;
};

const [write] = ms(() => {
  for (let i = 0; i < n; i += 100) {
    const ops = [];
    for (let j = i; j < Math.min(i + 100, n); j++) {
      ops.push({ op: "write" as const, path: `d${j % 50}/c${j}.md`, content: page(j) });
    }
    store.apply({ actor: "bench/1", request_id: crypto.randomUUID() }, ops);
  }
});
const hash = (path: string) => {
  const v = store.read(path);
  return v.kind === "page" ? v.hash : "";
};
const one = (path: string, j: number) => {
  const [t] = ms(() =>
    store.apply({ actor: "bench/1", request_id: crypto.randomUUID() }, [
      { op: "write", path, content: page(j, " Edited."), if_match: hash(path) },
    ]),
  );
  return t;
};
const [first, r1] = ms(() => store.maintainStructure());
const [idle, r2] = ms(() => store.maintainStructure());
const writeInDir = one("d7/c7.md", 7);
store.apply({ actor: "bench/1", request_id: crypto.randomUUID() }, [
  { op: "write", path: "top.md", content: page(n + 1) },
]);
const writeAtRoot = one("top.md", n + 1);
const [after, r3] = ms(() => store.maintainStructure());
const [work, w] = ms(() => store.work({ kind: "structure", limit: 500 }));
const [health, h] = ms(() => store.maintainHealth());
console.log(
  JSON.stringify(
    {
      pages: n,
      write_ms: write,
      full_run_ms: first,
      full_run: { pages: r1.pages, directories: r1.directories, codes: r1.codes },
      unchanged_run_ms: idle,
      unchanged_skipped: r2.skipped,
      run_after_a_write_ms: after,
      run_after_a_write_became: r3.became.length,
      one_write_in_a_directory_ms: writeInDir,
      one_write_at_the_root_ms: writeAtRoot,
      work_structure_ms: work,
      work_structure_items: w.total,
      health_ms: health,
      health: h.counts,
    },
    null,
    2,
  ),
);
