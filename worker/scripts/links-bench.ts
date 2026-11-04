/**
 * Times the link-health process on a synthetic library (TEMPRA-65): `bun scripts/links-bench.ts
 * [pages]` writes that many pages (default 5000) under bun:sqlite in 50 directories, each
 * linking to the next, every tenth citing a source in the library and every hundredth linking to
 * a page that is not there, then times a full walk with the whole library as its budget, one
 * pass of the default budget, a run with nothing new (skipped by its cursor) and a run after one
 * write.
 */
import { LINK_BUDGET, LibraryStore } from "../src/store/store";
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
  const cites = j % 10 === 0;
  const sources = cites
    ? `sources:\n  - id: s\n    title: Next\n    resource: /d${(j + 1) % 50}/c${j + 1}.md\n`
    : "";
  const gone = j % 100 === 0 ? " And [gone](/gone.md)." : "";
  const footnote = cites ? "[^s]\n\n[^s]: The next one." : "";
  return `---\ntype: Metric\ntitle: C${j}\ndescription: Page ${j}.\nstatus: stable\n${sources}---\nBody of ${j}, see [next](/d${(j + 1) % 50}/c${j + 1}.md).${gone}${extra}${footnote}\n`;
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
const [full, r1] = ms(() => store.maintainLinks(n + 10));
// A new version of the checks: the walk again, one default budget at a time.
store.setMaintenance({ links_version: "0" });
const [pass, r2] = ms(() => store.maintainLinks());
let passes = 1;
while (store.maintainLinks().pending) passes++;
const [idle, r3] = ms(() => store.maintainLinks());
const hash = (path: string) => {
  const v = store.read(path);
  return v.kind === "page" ? v.hash : "";
};
store.apply({ actor: "bench/1", request_id: crypto.randomUUID() }, [
  { op: "write", path: "d7/c7.md", content: page(7, " Edited."), if_match: hash("d7/c7.md") },
]);
const [after, r4] = ms(() => store.maintainLinks());
console.log(
  JSON.stringify(
    {
      pages: n,
      write_ms: write,
      full_walk_ms: full,
      full_walk: { checked: r1.checked, repaired: r1.repaired.length, broken_link: r1.broken_link },
      budget: LINK_BUDGET,
      one_budgeted_pass_ms: pass,
      one_budgeted_pass_checked: r2.checked,
      passes_for_a_walk: passes + 1,
      unchanged_run_ms: idle,
      unchanged_skipped: r3.skipped,
      run_after_a_write_ms: after,
      run_after_a_write_checked: r4.checked,
    },
    null,
    2,
  ),
);
