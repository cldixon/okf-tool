/**
 * Times the staleness process on a synthetic library (TEMPRA-63): `bun scripts/staleness-bench.ts
 * [pages]` writes that many pages (default 5000) under bun:sqlite, a third of them with a
 * stale_after spread over the next and last 60 days, then times a first run (every flag new), a
 * steady run a day later, and the reads that use the flags.
 */
import { LibraryStore } from "../src/store/store";
import { bunSqlHandle } from "../test/sqlite";

const n = Number(process.argv[2] ?? 5000);
const day = 86_400_000;
const clock = { t: Date.parse("2026-10-01T00:00:00Z") };
const store = new LibraryStore(bunSqlHandle(), {
  now: () => new Date(clock.t),
  pageCap: n + 10,
});

const ms = <T>(f: () => T) => {
  const t = performance.now();
  const out = f();
  return [Math.round((performance.now() - t) * 10) / 10, out] as const;
};

const [write] = ms(() => {
  for (let i = 0; i < n; i += 100) {
    const ops = [];
    for (let j = i; j < Math.min(i + 100, n); j++) {
      const dated = j % 3 === 0;
      const at = new Date(clock.t + ((j % 120) - 60) * day).toISOString().replace(/\.\d+Z$/, "Z");
      ops.push({
        op: "write" as const,
        path: `d${j % 50}/c${j}.md`,
        content: `---\ntype: Metric\ntitle: C${j}\ndescription: Page ${j}.\nstatus: stable\n${dated ? `stale_after: ${at}\n` : ""}---\nBody of ${j}, see [next](/d${(j + 1) % 50}/c${j + 1}.md).\n`,
      });
    }
    store.apply({ actor: "bench/1", request_id: crypto.randomUUID() }, ops);
  }
});
clock.t += 30 * day; // dates written in the future have come due since
const [first, r1] = ms(() => store.maintainStaleness());
clock.t += day;
const [steady, r2] = ms(() => store.maintainStaleness());
const [work] = ms(() => store.work({ kind: "stale" }));
const [soon] = ms(() => store.work({ kind: "stale_soon" }));
const [outline] = ms(() => store.outline());
console.log(
  JSON.stringify(
    {
      pages: n,
      write_ms: write,
      first_run_ms: first,
      first_run: {
        stale: r1.stale,
        stale_soon: r1.stale_soon,
        became_stale: r1.became.stale.length,
      },
      steady_run_ms: steady,
      steady_run: {
        stale: r2.stale,
        stale_soon: r2.stale_soon,
        became_stale: r2.became.stale.length,
      },
      work_stale_ms: work,
      work_stale_soon_ms: soon,
      outline_ms: outline,
    },
    null,
    2,
  ),
);
