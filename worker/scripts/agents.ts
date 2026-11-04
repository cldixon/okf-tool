/**
 * `bun run agents`: scripted agents (no model behind them) working on one library over MCP,
 * several at once, each with its own token and actor; every call timed, and every write's
 * arrival on the change feed measured. For testing the app with agents at work (watch the
 * printed page while `--pace` slows them to human speed) and for measuring it under load.
 *
 *   bun run agents --url http://localhost:8787 --seed 3                       local, mints tokens
 *   bun run agents --url <base> --library owner/slug --token T1 --token T2     any deployment
 *        [--scenario edit-race|live|load|costs …] [--pace 2000] [--rounds 5] [--keep] [--patient] [--json]
 *
 * Every call's answer says what it cost the library (rows read and written, the search index's
 * share, DO time; TEMPRA-228), reported per tool and per Library DO call. `costs` (only by name)
 * makes each kind of call once a round to measure them.
 *
 * Every agent of a library writes as its owner's account, so together they share its write
 * limit (60 a minute): a load run past it reports the calls refused, or with --patient waits
 * them out and retries, as a well-behaved agent would.
 *
 * `bun run preview agents --pr N` runs it against PR N's preview. Scenarios are in
 * scripts/agents/scenarios.ts; each works under `_agents/<run>/` and deletes its files after.
 */
import { parseArgs } from "node:util";
import {
  Agent,
  type CallRecord,
  type CallResult,
  type CostSummary,
  FeedWatch,
  meanCost,
  sleep,
  summarize,
} from "./agents/runner";
import { cleanUp, SCENARIOS, type ScenarioContext } from "./agents/scenarios";

export interface RunOptions {
  url: string;
  owner: string;
  slug: string;
  /** One bearer token per agent; the first also watches the feed. */
  tokens: string[];
  /** Scenario names; all of them when empty. */
  scenarios?: string[];
  /** Milliseconds between steps (0: full speed). */
  pace?: number;
  /** Rounds per agent (live) or pages per agent (load). */
  rounds?: number;
  /** Leave the scenario's files in place. */
  keep?: boolean;
  /** Wait out rate limits and retry, instead of failing the call. */
  patient?: boolean;
  log?: (line: string) => void;
}

export interface Report {
  ok: boolean;
  url: string;
  library: string;
  agents: number;
  durationMs: number;
  scenarios: { name: string; ok: boolean; failed: string[]; checks: number }[];
  /** Latency of each MCP tool, in ms. */
  /** Latency of each MCP tool, in ms; `refused` counts tool errors (some expected, like a
   * stale `if_match`), `limited` calls refused by a rate limit. */
  tools: Record<string, ReturnType<typeof summarize> & { refused: number; limited: number }>;
  /** From a write's start to its event arriving on the feed, in ms. */
  feed: ReturnType<typeof summarize> & { missing: number };
  /**
   * What each tool call cost its library's object on average (TEMPRA-228): rows read and
   * written, the search index's and the read flush's share, time waiting on the object.
   */
  costs: Record<string, CostSummary>;
  /** The same per Library DO call, by operation (`write`, `edit`, `read`, `batch`, …). */
  ops: Record<string, CostSummary>;
  writesPerSecond: number;
}

export async function runAgents(opts: RunOptions): Promise<Report> {
  const log = opts.log ?? console.log;
  const started = performance.now();
  const calls: CallRecord[] = [];
  const agents = opts.tokens.map(
    (token, i) =>
      new Agent(
        { token, name: `agent-${i + 1}` },
        opts.url,
        `${opts.owner}/${opts.slug}`,
        (r) => calls.push(r),
        started,
        opts.patient,
      ),
  );
  await Promise.all(agents.map((a) => a.connect()));
  const feed = new FeedWatch(opts.url, opts.owner, opts.slug, opts.tokens[0] ?? "");
  await feed.open();

  const writes: { seq: number; startedAt: number }[] = [];
  const results: Report["scenarios"] = [];
  const wanted = opts.scenarios?.length
    ? opts.scenarios
    : SCENARIOS.filter((s) => !s.onlyByName).map((s) => s.name);
  for (const name of wanted) {
    const scenario = SCENARIOS.find((s) => s.name === name);
    if (!scenario)
      throw new Error(`No scenario ${name}; there are ${SCENARIOS.map((s) => s.name).join(", ")}.`);
    if (agents.length < scenario.minAgents) {
      throw new Error(`${name} needs ${scenario.minAgents} agents; there are ${agents.length}.`);
    }
    const failed: string[] = [];
    let checks = 0;
    const ctx: ScenarioContext = {
      agents,
      feed,
      dir: `_agents/${name}-${Date.now()}`,
      pace: async () => {
        await sleep(opts.pace ?? 0);
      },
      rounds: opts.rounds ?? 3,
      files: new Set(),
      wrote: (r: CallResult) => {
        if (r.ok && r.seq !== null) writes.push({ seq: r.seq, startedAt: r.startedAt });
      },
      check: (ok, what) => {
        checks++;
        if (!ok) failed.push(what);
        log(`  ${ok ? "ok  " : "FAIL"} ${what}`);
      },
      log: (line) => log(`  ${line}`),
      page: (path) =>
        `${opts.url}/${opts.owner}/${opts.slug}/${path.split("/").map(encodeURIComponent).join("/")}`,
    };
    log(`${name}: ${scenario.description}`);
    try {
      await scenario.run(ctx);
    } catch (e) {
      failed.push(`threw: ${String(e)}`);
      log(`  FAIL threw: ${String(e)}`);
    }
    if (!opts.keep) {
      const n = await cleanUp(agents[0] as Agent, ctx.files);
      log(`  cleaned up ${n} file${n === 1 ? "" : "s"} under ${ctx.dir}/`);
    }
    results.push({ name, ok: failed.length === 0, failed, checks });
  }

  // Every write should have reached the feed.
  await Promise.all(writes.map((w) => feed.waitFor(w.seq, 5000)));
  const delivery: number[] = [];
  let missing = 0;
  for (const w of writes) {
    const at = feed.arrived.get(w.seq);
    if (at === undefined) missing++;
    else delivery.push(at - w.startedAt);
  }
  feed.close();
  await Promise.all(agents.map((a) => a.close()));

  const durationMs = performance.now() - started;
  const tools: Report["tools"] = {};
  for (const tool of new Set(calls.map((c) => c.tool))) {
    const mine = calls.filter((c) => c.tool === tool);
    tools[tool] = {
      // Latency of the calls that reached the tool; rate-limited ones are counted apart.
      ...summarize(mine.filter((c) => !c.limited).map((c) => c.ms)),
      refused: mine.filter((c) => !c.ok && !c.limited).length,
      limited: mine.filter((c) => c.limited).length,
    };
  }
  const costs: Report["costs"] = {};
  for (const tool of Object.keys(tools)) {
    const mine = calls.flatMap((c) => (c.tool === tool && c.cost ? [c.cost] : []));
    if (mine.length) costs[tool] = meanCost(mine);
  }
  const doCalls = calls.flatMap((c) => c.cost?.ops ?? []);
  const ops: Report["ops"] = {};
  for (const op of new Set(doCalls.map((o) => o.op))) {
    ops[op] = meanCost(doCalls.filter((o) => o.op === op));
  }
  return {
    ok: results.every((r) => r.ok) && missing === 0,
    url: opts.url,
    library: `${opts.owner}/${opts.slug}`,
    agents: agents.length,
    durationMs: Math.round(durationMs),
    scenarios: results,
    tools,
    feed: { ...summarize(delivery), missing },
    writesPerSecond: Math.round((writes.length / (durationMs / 1000)) * 10) / 10,
    costs,
    ops,
  };
}

/** A cost table's rows: per call, means. */
function costLines(title: string, rows: Record<string, CostSummary>): string[] {
  const entries = Object.entries(rows);
  if (entries.length === 0) return [];
  const n = (v: number, w: number) => String(v).padStart(w);
  return [
    `  ${title.padEnd(10)}  n  rows read  rows written  of them fts  read flush  DO ms`,
    ...entries.map(
      ([t, c]) =>
        `  ${t.padEnd(10)} ${n(c.n, 3)} ${n(c.rowsRead, 10)} ${n(c.rowsWritten, 13)} ${n(c.ftsRowsWritten, 12)} ${n(c.readFlushRowsWritten, 11)} ${n(c.doMs, 6)}`,
    ),
  ];
}

/** The report as a few lines of text. */
export function formatReport(r: Report): string {
  const lines = [
    `${r.ok ? "PASS" : "FAIL"} ${r.agents} agents on ${r.library} in ${(r.durationMs / 1000).toFixed(1)} s, ${r.writesPerSecond} writes/s`,
    ...r.scenarios.map((s) => {
      const failed =
        s.failed.slice(0, 3).join("; ") +
        (s.failed.length > 3 ? ` and ${s.failed.length - 3} more` : "");
      const counts = `${s.checks} checks${s.failed.length ? `, ${s.failed.length} failed` : ""}`;
      return `  ${s.ok ? "ok  " : "FAIL"} ${s.name} (${counts})${s.failed.length ? `: ${failed}` : ""}`;
    }),
    "  tool         n    p50 ms   p95 ms   max ms  refused  rate-limited",
    ...Object.entries(r.tools).map(
      ([t, s]) =>
        `  ${t.padEnd(10)} ${String(s.n).padStart(3)} ${String(s.p50).padStart(8)} ${String(s.p95).padStart(8)} ${String(s.max).padStart(8)}  ${String(s.refused).padStart(7)}  ${s.limited}`,
    ),
    `  feed       ${String(r.feed.n).padStart(3)} ${String(r.feed.p50).padStart(8)} ${String(r.feed.p95).padStart(8)} ${String(r.feed.max).padStart(8)}  ${r.feed.missing} missing  (write start → event on the feed)`,
    // What each call cost its library (TEMPRA-228), per tool call and per Library DO call.
    ...costLines("tool cost", r.costs),
    ...costLines("DO op", r.ops),
  ];
  return lines.join("\n");
}

if (import.meta.main) {
  const { values } = parseArgs({
    options: {
      url: { type: "string" },
      library: { type: "string" },
      token: { type: "string", multiple: true },
      seed: { type: "string" },
      scenario: { type: "string", multiple: true },
      pace: { type: "string" },
      rounds: { type: "string" },
      keep: { type: "boolean" },
      patient: { type: "boolean" },
      json: { type: "boolean" },
    },
  });
  if (!values.url) {
    console.error(
      "usage: bun run agents --url <base> (--seed N | --library owner/slug --token T …) [--scenario …] [--pace ms] [--rounds n] [--keep] [--patient] [--json]",
    );
    process.exit(2);
  }
  let owner = "";
  let slug = "";
  let tokens = values.token ?? [];
  if (values.seed) {
    // Local cf dev: tokens for the library `agents`, one actor per agent, in .wrangler/state.
    const { seed } = await import("./seed");
    const seeded = [];
    for (let i = 1; i <= Number(values.seed); i++) {
      seeded.push(
        await seed({
          slug: values.library?.split("/")[1] ?? "agents",
          actor: `claude-code/agent-${i}`,
        }),
      );
    }
    owner = seeded[0]?.owner ?? "";
    slug = seeded[0]?.slug ?? "";
    tokens = seeded.map((s) => s.token);
  } else {
    [owner = "", slug = ""] = (values.library ?? "").split("/");
  }
  if (!owner || !slug || tokens.length === 0) {
    console.error("Pass --seed N, or --library owner/slug and at least one --token.");
    process.exit(2);
  }
  const report = await runAgents({
    url: values.url,
    owner,
    slug,
    tokens,
    scenarios: values.scenario,
    pace: Number(values.pace ?? 0),
    rounds: values.rounds ? Number(values.rounds) : undefined,
    keep: values.keep,
    patient: values.patient,
    log: values.json ? () => {} : console.log,
  });
  console.log(values.json ? JSON.stringify(report, null, 2) : formatReport(report));
  process.exit(report.ok ? 0 : 1);
}
