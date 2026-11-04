/**
 * Times a library's hot paths on a large synthetic library (TEMPRA-86, TEMPRA-87):
 * `bun scripts/scale-bench.ts [db file] [pages] [events]` builds (once, into the file when
 * given; default in memory) a library of 5,000 pages in 50 directories and about 50,000 ledger
 * events (writes by several people's agents, anchored links, stale_after dates, comment threads),
 * then times log.md, summary(), stats(), contributors(), a one-page write and a page read,
 * each as the median of several runs. A read is timed twice: right after a write (the head moved)
 * and again with nothing written in between.
 */
import { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import { LibraryStore } from "../src/store/store";
import { bunSqlHandle } from "../test/sqlite";

const file = process.argv[2];
const n = Number(process.argv[3] ?? 5000);
const target = Number(process.argv[4] ?? 50_000);
const now = new Date("2026-10-01T00:00:00Z");
const built = file !== undefined && existsSync(file);
const db = new Database(file ?? ":memory:");
const open = () => new LibraryStore(bunSqlHandle(db), { now: () => now });

const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  return Math.round((s[Math.floor(s.length / 2)] ?? 0) * 100) / 100;
};
const time = (f: () => unknown, runs = 7) => {
  const out: number[] = [];
  for (let i = 0; i < runs; i++) {
    const t = performance.now();
    f();
    out.push(performance.now() - t);
  }
  return median(out);
};

const people = ["p1", "p2", "p3", "p4"];
const ctx = (i: number) => ({
  actor: `agent/${i % 4}`,
  request_id: crypto.randomUUID(),
  by: { person: people[i % 4] as string, agent: i % 3 === 0 ? undefined : `a${i % 3}` },
  note: `change ${i}`,
});

const page = (j: number, rev = 0) => {
  // Every 10th page has a stale_after: some past, some within 14 days, most far ahead.
  const stale =
    j % 10 === 0
      ? `stale_after: ${j % 30 === 0 ? "2026-09-01" : j % 20 === 0 ? "2026-10-08" : "2027-06-01"}T00:00:00Z\n`
      : "";
  // Every third links on; every fifth names a heading, half of which the target lacks.
  const to = `/d${(j + 1) % 50}/c${j + 1}.md`;
  const link =
    j % 5 === 0
      ? ` See [next](${to}#${j % 10 === 0 ? "missing" : "details"}).`
      : j % 3 === 0
        ? ` See [next](${to}).`
        : "";
  return `---\ntype: ${j % 4 === 0 ? "Metric" : "Table"}\ntitle: C${j}\ndescription: Page ${j}.\n${stale}status: stable\n---\n# C${j}\n\nBody of ${j}, revision ${rev}.${link}\n\n## Details\n\nMore.\n`;
};

if (!built) {
  const store = open();
  const t = performance.now();
  let i = 0;
  for (let k = 0; k < n; k += 100) {
    const ops = [];
    for (let j = k; j < Math.min(k + 100, n); j++) {
      ops.push({ op: "write" as const, path: `d${j % 50}/c${j}.md`, content: page(j) });
    }
    store.apply(ctx(i++), ops);
  }
  for (let j = 0; j < n; j += 50) {
    store.comment(ctx(i++), { kind: "open", path: `d${j % 50}/c${j}.md`, body: `Question ${j}` });
  }
  // Edits, 25 pages a request, until the ledger reaches the target.
  let rev = 1;
  let j = 0;
  while (store.headSeq() < target) {
    const ops = [];
    for (let m = 0; m < 25; m++, j = (j + 7) % n) {
      const path = `d${j % 50}/c${j}.md`;
      const v = store.read(path);
      if (v.kind !== "page") throw new Error(path);
      ops.push({ op: "write" as const, path, content: page(j, rev), if_match: v.hash });
    }
    store.apply(ctx(i++), ops);
    if (j < 7) rev++;
  }
  store.maintainStaleness();
  store.maintainStructure();
  store.maintainHealth();
  console.error(
    `built ${n} pages, ${store.headSeq()} events in ${Math.round(performance.now() - t)} ms`,
  );
}

// Opening may migrate a library built by an earlier version; timed once.
const t0 = performance.now();
const store = open();
const open_ms = Math.round(performance.now() - t0);

let rev = 1000;
const write = () => {
  const path = "d7/c7.md";
  const v = store.read(path);
  if (v.kind !== "page") throw new Error(path);
  store.apply(ctx(rev), [{ op: "write", path, content: page(7, rev++), if_match: v.hash }]);
};
const writeOnly = () => {
  const v = store.read("d7/c7.md");
  if (v.kind !== "page") throw new Error("d7/c7.md");
  const t = performance.now();
  store.apply(ctx(rev), [
    { op: "write", path: "d7/c7.md", content: page(7, rev++), if_match: v.hash },
  ]);
  return performance.now() - t;
};
const afterWrite = (f: () => unknown) => {
  const out: number[] = [];
  for (let i = 0; i < 7; i++) {
    write();
    const t = performance.now();
    f();
    out.push(performance.now() - t);
  }
  return median(out);
};
const some = Math.floor(n / 2) + 12;
const read = () => store.read(`d${some % 50}/c${some}.md`);

const results = {
  pages: store.stats().pages,
  events: store.headSeq(),
  open_ms,
  write_ms: median(Array.from({ length: 15 }, writeOnly)),
  read_after_write_ms: afterWrite(read),
  read_ms: time(read, 15),
  summary_after_write_ms: afterWrite(() => store.summary()),
  summary_ms: time(() => store.summary()),
  log_md_ms: time(() => store.read("log.md"), 3),
  stats_ms: time(() => store.stats()),
  contributors_ms: time(() => store.contributors()),
  work_ms: time(() => store.work()),
};
console.log(JSON.stringify(results, null, 2));
