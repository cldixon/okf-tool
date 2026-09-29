/**
 * `bun run gate`: the Phase 1 gate against `wrangler dev` (spec: Phase 1 in detail, Gate).
 *
 * Starts the Worker with fresh local D1, R2 and DO state, seeds one library and write token per
 * sample bundle, imports each bundle as a tarball, exports it, and compares: same parsed
 * frontmatter (generated and verified included) and bodies, byte-identical attachments,
 * synthesized index.md and log.md ignored. Exits non-zero on any mismatch.
 *
 *   bun run gate [--port 8799] [--keep]
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { readTar, writeTar } from "../src/util/tar";
import { compareBundle } from "../test/compare";
import { BUNDLES, loadBundle } from "../test/fixtures";
import { seed } from "./seed";

const WORKER_DIR = new URL("..", import.meta.url).pathname;

const { values } = parseArgs({
  options: { port: { type: "string" }, keep: { type: "boolean" } },
});
const port = Number(values.port ?? 8799);
const base = `http://127.0.0.1:${port}`;
const state = mkdtempSync(join(tmpdir(), "okf-gate-"));

console.log(`state: ${state}`);
const tokens = BUNDLES.map((b) => ({
  bundle: b,
  ...seed({ slug: b.replace(/_/g, "-"), persistTo: state }),
}));

const dev = Bun.spawn(
  ["bunx", "wrangler", "dev", "--port", String(port), "--ip", "127.0.0.1", "--persist-to", state],
  {
    cwd: WORKER_DIR,
    env: { ...process.env, WRANGLER_SEND_METRICS: "false", CI: "1" },
    stdout: "pipe",
    stderr: "pipe",
  },
);

async function waitForHealth() {
  for (let i = 0; i < 120; i++) {
    try {
      const r = await fetch(`${base}/healthz`);
      if (r.ok) return;
    } catch {}
    await Bun.sleep(500);
  }
  throw new Error("wrangler dev did not become healthy");
}

let failed = false;
try {
  await waitForHealth();
  for (const t of tokens) {
    const headers = { Authorization: `Bearer ${t.token}` };
    const lib = `${base}/api/v1/libraries/${t.slug}`;
    const original = loadBundle(t.bundle);
    const imp = await fetch(`${lib}/import?source=fixtures/${t.bundle}`, {
      method: "POST",
      headers: { ...headers, "Content-Type": "application/x-tar" },
      body: writeTar(original),
    });
    if (!imp.ok) throw new Error(`import ${t.bundle}: ${imp.status} ${await imp.text()}`);
    const res = (await imp.json()) as { files: number; seq: number; warnings: unknown[] };

    const exp = await fetch(`${lib}/export`, { headers });
    if (!exp.ok) throw new Error(`export ${t.bundle}: ${exp.status} ${await exp.text()}`);
    const exported = new Map(
      readTar(new Uint8Array(await exp.arrayBuffer())).map((f) => [f.path, f.bytes]),
    );
    const problems = compareBundle(original, exported);
    const concepts = original.filter(
      (f) => f.path.endsWith(".md") && !/(^|\/)(index|log)\.md$/.test(f.path),
    ).length;
    const attachments = original.filter((f) => !f.path.endsWith(".md")).length;
    const status = problems.length === 0 ? "PASS" : "FAIL";
    console.log(
      `${status} ${t.bundle}: ${concepts} concepts, ${attachments} attachments, ${res.seq} events, ${res.warnings.length} files with lint`,
    );
    for (const p of problems) console.log(`  - ${p}`);
    if (problems.length > 0) failed = true;
  }
} catch (e) {
  failed = true;
  console.error(e);
  console.error((await new Response(dev.stderr).text()).slice(-4000));
} finally {
  dev.kill();
  await dev.exited;
  if (!values.keep) rmSync(state, { recursive: true, force: true });
}
console.log(failed ? "Gate FAILED" : "Gate passed");
process.exit(failed ? 1 : 0);
