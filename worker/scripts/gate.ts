/**
 * `bun run gate`: the Phase 1 gate against `wrangler dev` (spec: Phase 1 in detail, Gate), plus
 * the MCP smoke flow on a fresh, empty library.
 *
 * Starts the Worker with fresh local D1, R2 and DO state, seeds one library and write token per
 * sample bundle, imports each bundle as a tarball, exports it, and compares: same parsed
 * frontmatter (generated and verified included) and bodies, byte-identical attachments,
 * synthesized index.md and log.md ignored. Then renders every concept and directory of each bundle
 * in the built-in UI (signed in with the dev Access identity). Exits non-zero on any mismatch.
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
import { mcpSmoke } from "./mcp-smoke";
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
const mcpToken = seed({ slug: "mcp", actor: "claude-code/gate", persistTo: state }).token;

const dev = Bun.spawn(
  [
    "bunx",
    "wrangler",
    "dev",
    "--port",
    String(port),
    "--ip",
    "127.0.0.1",
    "--persist-to",
    state,
    // The dev Access identity, honored only on loopback when no Access team is configured.
    "--var",
    "DEV_ACCESS_EMAIL:gate@localhost",
  ],
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

/** Fetches the library page, every directory page and every concept page of a library. */
async function uiPages(slug: string, paths: string[]): Promise<string[]> {
  const enc = (p: string) => p.split("/").map(encodeURIComponent).join("/");
  const lib = `${base}/app/libraries/${slug}`;
  const concepts = paths.filter((p) => p.endsWith(".md") && !/(^|\/)(index|log)\.md$/.test(p));
  const dirs = new Set<string>();
  for (const p of paths) {
    const parts = p.split("/").slice(0, -1);
    for (let i = 1; i <= parts.length; i++) dirs.add(parts.slice(0, i).join("/"));
  }
  const urls = [
    `${lib}/`,
    `${lib}/ledger`,
    ...[...dirs].map((d) => `${lib}/tree/${enc(d)}/`),
    ...concepts.map((p) => `${lib}/files/${enc(p)}`),
  ];
  const problems: string[] = [];
  for (const url of urls) {
    const r = await fetch(url);
    const html = await r.text();
    if (r.status !== 200 || !html.includes("</main>")) {
      problems.push(`${url.slice(base.length)}: ${r.status} ${html.slice(0, 200)}`);
    }
  }
  return problems;
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

    const uiProblems = await uiPages(
      t.slug,
      original.map((f) => f.path),
    );
    console.log(`${uiProblems.length === 0 ? "PASS" : "FAIL"} ${t.bundle}: UI pages render`);
    for (const p of uiProblems) console.log(`  - ${p}`);
    if (uiProblems.length > 0) failed = true;
  }
  const mcpOk = await mcpSmoke({ url: base, token: mcpToken });
  console.log(`${mcpOk ? "PASS" : "FAIL"} MCP smoke on an empty library`);
  if (!mcpOk) failed = true;
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
