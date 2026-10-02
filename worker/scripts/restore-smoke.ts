/**
 * Point-in-time restore against a deployed Worker (local dev has no PITR). Use a throwaway
 * library that is a few minutes old (a new one has no recoverable history for a minute or two).
 * It writes marker A, waits, picks the restore point, waits, writes marker B, waits again (history
 * trails live writes by about a minute), restores and checks B is gone and A stayed, then undoes
 * and checks B is back. Takes about five minutes.
 *
 *   bun run scripts/restore-smoke.ts --url https://okf-service.example.workers.dev \
 *     --library dev/scratch --token <human: token for that library>
 */
import { parseArgs } from "node:util";

const { values } = parseArgs({
  options: {
    url: { type: "string" },
    library: { type: "string" },
    token: { type: "string" },
    gap: { type: "string" },
  },
});
if (!values.url || !values.library || !values.token) {
  console.error(
    "Usage: --url <worker> --library <owner>/<slug> --token <human: token> [--gap seconds]",
  );
  process.exit(2);
}
const lib = `${values.url.replace(/\/$/, "")}/api/v1/libraries/${values.library}`;
const auth = { Authorization: `Bearer ${values.token}` };
const gap = Number(values.gap ?? 90) * 1000;
const run = Date.now().toString(36);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function put(name: string) {
  const r = await fetch(`${lib}/files/smoke/${run}-${name}.md`, {
    method: "PUT",
    headers: { ...auth, "Content-Type": "text/markdown" },
    body: `---\ntype: Note\ntitle: Marker ${name}\ndescription: Restore smoke marker.\n---\n${name}\n`,
  });
  if (!r.ok) throw new Error(`PUT marker ${name}: ${r.status} ${await r.text()}`);
}

/** Whether a marker exists, retrying while the library restarts. */
async function exists(name: string): Promise<boolean> {
  for (let i = 0; i < 30; i++) {
    const r = await fetch(`${lib}/files/smoke/${run}-${name}.md`, { headers: auth });
    if (r.status === 404) return false;
    if (r.ok) return true;
    await sleep(1000);
  }
  throw new Error(`GET marker ${name}: library did not come back`);
}

async function head(): Promise<number> {
  const r = await fetch(`${lib}/requests?limit=1`, { headers: auth });
  const json = (await r.json()) as { requests: { events: { seq: number }[] }[] };
  return json.requests[0]?.events.at(-1)?.seq ?? 0;
}

async function restore(payload: { to: string } | { undo: string }) {
  const r = await fetch(`${lib}/restore`, {
    method: "POST",
    headers: { ...auth, "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  const json = (await r.json()) as Record<string, unknown>;
  if (r.status !== 201) {
    throw new Error(`restore ${JSON.stringify(payload)}: ${r.status} ${JSON.stringify(json)}`);
  }
  return json;
}

async function expectState(label: string, a: boolean, b: boolean, seq: number) {
  for (let i = 0; i < 30; i++) {
    if ((await exists("a")) === a && (await exists("b")) === b && (await head()) === seq) {
      return console.log(`PASS ${label}`);
    }
    await sleep(1000);
  }
  throw new Error(`${label}: a=${await exists("a")} b=${await exists("b")} head=${await head()}`);
}

await put("a");
const seqA = await head();
await sleep(gap);
const to = new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
await sleep(gap);
await put("b");
const seqB = await head();
await expectState("markers written", true, true, seqB);
await sleep(gap);

const r = await restore({ to });
console.log(`restored to ${to}: id ${r.id}, pre-restore export ${r.export}`);
await expectState("restore removed marker B and kept marker A", true, false, seqA);

const u = await restore({ undo: String(r.id) });
console.log(`undo: id ${u.id}, pre-restore export ${u.export}`);
await expectState("undo brought marker B back", true, true, seqB);
