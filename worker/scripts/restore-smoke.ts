/**
 * Point-in-time restore against a deployed Worker (wrangler dev has no PITR). Use a throwaway
 * library: it writes probe files, restores to before the second write, checks it is gone, undoes
 * the restore and checks it is back.
 *
 *   bun run scripts/restore-smoke.ts --url https://okf-service.example.workers.dev \
 *     --library scratch --token <human: token for that library>
 */
import { parseArgs } from "node:util";

const { values } = parseArgs({
  options: { url: { type: "string" }, library: { type: "string" }, token: { type: "string" } },
});
if (!values.url || !values.library || !values.token) {
  console.error("Usage: --url <worker> --library <slug> --token <human: token>");
  process.exit(2);
}
const lib = `${values.url.replace(/\/$/, "")}/api/v1/libraries/${values.library}`;
const auth = { Authorization: `Bearer ${values.token}` };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function put(path: string, body: string) {
  const r = await fetch(`${lib}/files/${path}`, {
    method: "PUT",
    headers: { ...auth, "Content-Type": "text/markdown" },
    body: `---\ntype: Note\ntitle: Probe\ndescription: Restore smoke probe.\n---\n${body}\n`,
  });
  if (!r.ok) throw new Error(`PUT ${path}: ${r.status} ${await r.text()}`);
}

/** The file's body, null when it does not exist; retries while the library restarts. */
async function body(path: string): Promise<string | null> {
  for (let i = 0; i < 30; i++) {
    const r = await fetch(`${lib}/files/${path}`, { headers: auth });
    if (r.status === 404) return null;
    if (r.ok) return (await r.text()).split("---\n").at(-1)?.trim() ?? "";
    await sleep(1000);
  }
  throw new Error(`GET ${path}: library did not come back`);
}

async function restore(payload: { to: string } | { undo: string }) {
  const r = await fetch(`${lib}/restore`, {
    method: "POST",
    headers: { ...auth, "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  const json = (await r.json()) as Record<string, unknown>;
  if (r.status !== 201)
    throw new Error(`restore ${JSON.stringify(payload)}: ${r.status} ${JSON.stringify(json)}`);
  return json;
}

async function expectState(label: string, probe: string, after: string | null) {
  for (let i = 0; i < 30; i++) {
    const [p, a] = [await body("probe.md"), await body("after.md")];
    if (p === probe && a === after) return console.log(`PASS ${label}`);
    await sleep(1000);
  }
  throw new Error(
    `${label}: probe.md=${await body("probe.md")} after.md=${await body("after.md")}`,
  );
}

await put("probe.md", "before");
await sleep(5000);
const to = new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
await sleep(5000);
await put("probe.md", "after");
await put("after.md", "written after the restore point");
await expectState("writes landed", "after", "written after the restore point");

const r = await restore({ to });
console.log(`restored to ${to}: id ${r.id}, pre-restore export ${r.export}`);
await expectState("restore removed the later writes", "before", null);

const u = await restore({ undo: String(r.id) });
console.log(`undo: id ${u.id}, pre-restore export ${u.export}`);
await expectState("undo brought them back", "after", "written after the restore point");

const list = (await (await fetch(`${lib}/restores`, { headers: auth })).json()) as {
  restores: { id: string }[];
};
if (list.restores.length < 2) throw new Error(`restores listed: ${list.restores.length}`);
console.log(`PASS ${list.restores.length} restores listed`);
