/**
 * `bun run logs`: recent events for the deployed Worker from Workers Observability, through
 * `cf observability telemetry query`. One line per event, newest first: time, outcome, status,
 * and the request or Durable Object call. For a live stream, `cf` has no tail yet; run
 * `bunx wrangler tail <worker>` instead.
 *
 *   bun run logs [--minutes 30] [--limit 50] [--errors] [--worker okf-service] [--json]
 */
import { parseArgs } from "node:util";
import { cf, WORKER_NAME } from "./cf";

const { values } = parseArgs({
  options: {
    minutes: { type: "string" },
    limit: { type: "string" },
    errors: { type: "boolean" },
    worker: { type: "string" },
    json: { type: "boolean" },
  },
});
const to = Date.now();
const from = to - Number(values.minutes ?? 30) * 60_000;
const filters: { key: string; operation: string; type: string; value: string }[] = [
  {
    key: "$metadata.service",
    operation: "eq",
    type: "string",
    value: values.worker ?? WORKER_NAME,
  },
];
if (values.errors)
  filters.push({ key: "$metadata.error", operation: "exists", type: "string", value: "" });
const body = {
  queryId: "okf-logs",
  timeframe: { from, to },
  view: "events",
  limit: Number(values.limit ?? 50),
  parameters: { filters },
};
const out = JSON.parse(cf(["observability", "telemetry", "query", "--body", JSON.stringify(body)]));
const events: Record<string, Record<string, unknown>>[] = out?.events?.events ?? [];
if (values.json) {
  console.log(JSON.stringify(events, null, 2));
} else {
  for (const e of events) {
    const m = e.$metadata ?? {};
    const when = new Date(Number(m.startTime ?? e.timestamp ?? 0)).toISOString();
    const what = String(m.trigger ?? m.message ?? "");
    const error = m.error && m.error !== what ? String(m.error) : "";
    const parts = [when, m.error ? "ERROR" : "ok", m.statusCode ?? "", what, error];
    console.log(parts.filter((p) => p !== "").join("  "));
  }
  console.log(`${events.length} events in the last ${values.minutes ?? 30} minutes`);
}
