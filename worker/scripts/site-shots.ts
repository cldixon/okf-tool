/**
 * `bun run site-shots`: the landing page's screenshots of the app (TEMPRA-226), made again in one
 * step whenever the look changes.
 *
 * Starts the Worker under `cf dev` on fresh local state (a throwaway project in
 * worker/.site-shots/, as the gate does), seeds one library from the bundle beside this script
 * (scripts/site-shots/: a checkout team's notes), opens a comment thread on a page with a chart and
 * has an agent answer it, then drives Chromium (playwright-core; CHROME_PATH picks the binary) and
 * saves each shot light and dark, at 1x and 2x:
 *
 *   concept-{light,dark}[@2x].png   a concept page with a figure, the Comments panel beside it
 *                                   and the thread open (the person's question, the agent's answer)
 *   presence-{light,dark}[@2x].png  the workspace while an agent reads two pages: their rows
 *                                   shimmer in the tree (the band held mid-row for the still)
 *
 * into site/public/shots/ (or --out), which the landing page serves as they are.
 *
 *   bun run site-shots [--out <dir>] [--port 8798] [--keep]
 */
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join, relative, resolve } from "node:path";
import { parseArgs } from "node:util";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { chromium, type Page } from "playwright-core";
import { writeTar } from "../src/util/tar";
import { WORKER_DIR } from "./cf";
import { localFetch as fetch } from "./local-fetch";
import { seed } from "./seed";

const { values } = parseArgs({
  options: { out: { type: "string" }, port: { type: "string" }, keep: { type: "boolean" } },
});
const port = Number(values.port ?? 8798);
const base = `http://127.0.0.1:${port}`;
const out = resolve(values.out ?? join(WORKER_DIR, "../site/public/shots"));
mkdirSync(out, { recursive: true });

/** The library in the shots: its owner's handle, its name and the bundle it is seeded from. */
const HANDLE = "sam";
const EMAIL = "sam@localhost";
const SLUG = "checkout";
const BUNDLE = join(import.meta.dir, "site-shots");
/** The page the concept shot shows, and the words its comment is on. */
const CONCEPT = "metrics/checkout-latency.md";
const QUOTE = "p95 rose from 410 ms to 640 ms";
const QUESTION = "Is this the retry change, or something else that shipped that week?";
const ANSWER =
  "It is the retry change. The rise starts with the release that raised the retry budget to three tries, and retried card checks account for about 230 ms at p95. Nothing else that week touched checkout.";
/** The page left open for the presence shot, and the two pages the agent reads. */
const OPEN = "decisions/retry-budget.md";
const READS = ["metrics/checkout-latency.md", "research/card-declines.md"];
/** The window the shots are taken at: wide enough for the Comments panel beside the text. */
const VIEWPORT = { width: 1440, height: 900 };

/** Every file of the bundle, paths relative to its root. */
function loadBundle(root: string): { path: string; bytes: Uint8Array }[] {
  const files: { path: string; bytes: Uint8Array }[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir).sort()) {
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) walk(full);
      else files.push({ path: relative(root, full), bytes: new Uint8Array(readFileSync(full)) });
    }
  };
  walk(root);
  return files;
}

/** A Chromium: CHROME_PATH, the container's Playwright build, or Chrome. */
function chromiumPath(): string | null {
  const candidates = [
    process.env.CHROME_PATH,
    "/opt/pw-browsers/chromium",
    "/usr/bin/google-chrome",
    "/usr/bin/chromium",
  ];
  return candidates.find((p): p is string => !!p && existsSync(p)) ?? null;
}

const executablePath = chromiumPath();
if (!executablePath) {
  console.error("No Chromium found; set CHROME_PATH.");
  process.exit(1);
}

// cf dev keeps its state beside cloudflare.config.ts, so it runs from a throwaway project: the
// config files copied, src/, migrations/ and node_modules/ linked, and sign-in links shown on the
// page (DEV_SIGNIN=1, loopback only) instead of mailed.
mkdirSync(join(WORKER_DIR, ".site-shots"), { recursive: true });
const project = mkdtempSync(join(WORKER_DIR, ".site-shots", "run-"));
for (const f of ["cloudflare.config.ts", "wrangler.config.ts", "package.json", "tsconfig.json"]) {
  copyFileSync(join(WORKER_DIR, f), join(project, f));
}
for (const d of ["src", "migrations", "node_modules"]) {
  symlinkSync(join(WORKER_DIR, d), join(project, d));
}
writeFileSync(join(project, ".dev.vars"), "DEV_SIGNIN=1\nSIGNUP=open\nAGENT_MODEL=fake\n");
const state = join(project, ".wrangler/state");

const seeded = await seed({
  slug: SLUG,
  human: `human:${HANDLE}`,
  email: EMAIL,
  actor: "claude-code/site-shots",
  persistTo: state,
});
const { owner, token } = seeded;
const api = `${base}/api/v1/libraries/${owner}/${SLUG}`;
const bearer = { Authorization: `Bearer ${token}` };

const dev = Bun.spawn(["bunx", "cf", "dev", "--port", String(port)], {
  detached: true,
  cwd: project,
  env: { ...process.env, CF_SEND_TELEMETRY: "false", CI: "1" },
  stdout: "pipe",
  stderr: "pipe",
});
let devLog = "";
const drain = async (stream: ReadableStream<Uint8Array>) => {
  const decoder = new TextDecoder();
  for await (const chunk of stream) devLog = (devLog + decoder.decode(chunk)).slice(-32_768);
};
void Promise.all([drain(dev.stdout), drain(dev.stderr)]).catch(() => {});
const stopDev = () => {
  try {
    process.kill(-dev.pid, "SIGKILL");
  } catch {
    // Already gone.
  }
};

async function waitForHealth() {
  for (let i = 0; i < 120; i++) {
    try {
      if ((await fetch(`${base}/healthz`)).ok) return;
    } catch {}
    await Bun.sleep(500);
  }
  throw new Error("cf dev did not become healthy");
}

/** An MCP client as the seeded agent, for its comment and its reads. */
async function agent() {
  const client = new Client({ name: "site-shots", version: "1.0.0" });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(`${base}/mcp`), {
      fetch,
      requestInit: { headers: bearer },
    }),
  );
  const call = async (name: string, args: Record<string, unknown>) => {
    const r = await client.callTool({ name, arguments: { library: `${owner}/${SLUG}`, ...args } });
    if (r.isError) throw new Error(`${name}: ${JSON.stringify(r.content).slice(0, 300)}`);
    return r;
  };
  return { client, call };
}

/** Each shot light and dark, at 2x and at 1x (CSS pixels). */
async function shoot(page: Page, name: string, ready: () => Promise<void>) {
  for (const scheme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme: scheme, reducedMotion: "no-preference" });
    await ready();
    // The pointer out of the way, so no hover shows.
    await page.mouse.move(VIEWPORT.width - 2, VIEWPORT.height - 2);
    await page.waitForTimeout(400);
    await page.screenshot({ path: join(out, `${name}-${scheme}@2x.png`), scale: "device" });
    await page.screenshot({ path: join(out, `${name}-${scheme}.png`), scale: "css" });
    console.log(`  ${name}-${scheme}.png, ${name}-${scheme}@2x.png`);
  }
}

let failed = false;
try {
  await waitForHealth();

  // The library, imported as a bundle by the agent.
  const imp = await fetch(`${api}/import?source=site-shots`, {
    method: "POST",
    headers: { ...bearer, "Content-Type": "application/x-tar" },
    body: writeTar(loadBundle(BUNDLE)),
  });
  if (!imp.ok) throw new Error(`import: ${imp.status} ${await imp.text()}`);
  const imported = (await imp.json()) as { files: number; warnings: unknown[] };
  // The bundle is ours: it should be as clean as the pages we would want agents to write.
  if (imported.warnings.length > 0) {
    throw new Error(`lint on import: ${JSON.stringify(imported.warnings).slice(0, 1000)}`);
  }
  console.log(`seeded ${owner}/${SLUG}: ${imported.files} files`);

  const browser = await chromium.launch({ executablePath, timeout: 30_000 });
  const context = await browser.newContext({ viewport: VIEWPORT, deviceScaleFactor: 2 });
  const page = await context.newPage();
  const problems: string[] = [];
  page.on("pageerror", (e) => problems.push(`page error: ${e.message}`));
  page.on("console", (m) => {
    if (m.type() === "error") problems.push(`console: ${m.text()}`);
  });

  // Signed in as the library's owner by a dev magic link.
  await page.goto(`${base}/sign-in?next=${encodeURIComponent(`/${owner}/${SLUG}/`)}`);
  await page.locator('input[name="email"]').fill(EMAIL);
  await page.getByRole("button", { name: "Email me a link" }).click();
  const link = await page.locator('a[href*="/sign-in/link?t="]').first().getAttribute("href");
  await page.goto(new URL(link ?? "", base).href);
  await page.getByRole("button", { name: "Continue" }).click();
  await page.waitForURL(`${base}/${owner}/${SLUG}/`, { timeout: 15_000 });

  const main = page.locator("main.ws-main");
  const sidebar = page.locator("section.ws-sidebar");
  const lib = `${base}/${owner}/${SLUG}`;
  // Every folder open in the tree.
  await page.evaluate(`localStorage.removeItem("tempra:tree-closed:${owner}/${SLUG}")`);

  // The person asks on the quote; the agent answers in the thread.
  const asked = await page.evaluate(
    async ([url, path, quote, body]) => {
      const r = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({ path, body, anchor: { quote } }),
      });
      return { status: r.status, body: await r.text() };
    },
    [`/api/v1/libraries/${owner}/${SLUG}/comments`, CONCEPT, QUOTE, QUESTION] as const,
  );
  if (asked.status !== 201) throw new Error(`the comment: ${asked.status} ${asked.body}`);
  const thread = (JSON.parse(asked.body) as { thread: { id: string } }).thread.id;
  const { client, call } = await agent();
  await call("comment", { action: "reply", thread, body: ANSWER });

  // 1. The concept: its chart drawn, the Comments panel beside the text, the thread open.
  const enc = (p: string) => p.split("/").map(encodeURIComponent).join("/");
  await page.goto(`${lib}/${enc(CONCEPT)}?panel=comments`);
  await main.locator(".body .prose").waitFor({ timeout: 15_000 });
  await main.locator(".body figure.diagram .diagram-svg svg").waitFor({ timeout: 20_000 });
  const comments = page.locator("aside#panel-comments.concept-panel");
  await comments.waitFor({ timeout: 10_000 });
  const collapsed = comments.locator(`button.thread.collapsed[id="panel-thread-${thread}"]`);
  if (await collapsed.count()) await collapsed.click();
  const open = comments.locator(`section.thread.open[id="panel-thread-${thread}"]`);
  await open.waitFor({ timeout: 10_000 });
  await open.getByText(ANSWER.slice(0, 40)).waitFor({ timeout: 10_000 });
  await shoot(page, "concept", async () => {
    await open.waitFor({ timeout: 5000 });
    // The chart is drawn again for the colour scheme.
    await main.locator(".body figure.diagram .diagram-svg svg").waitFor({ timeout: 10_000 });
  });

  // 2. Presence: a page open, the agent reads two others and their rows shimmer in the tree.
  await page.goto(`${lib}/${enc(OPEN)}`);
  await main.locator(".body .prose").waitFor({ timeout: 15_000 });
  for (const p of READS) await sidebar.locator(`a[data-path="${p}"]`).waitFor({ timeout: 10_000 });
  // The earlier reads fade first (8 s after an agent's last read).
  await sidebar
    .locator(".tree-row.presence")
    .first()
    .waitFor({ state: "detached", timeout: 20_000 });
  const holdBand = (hold: boolean) =>
    page.evaluate(
      `document.getAnimations().filter((a) => a.animationName === "tempra-shimmer").forEach((a) => { if (${hold}) { a.pause(); a.currentTime = 1000; } else a.play(); })`,
    );
  await shoot(page, "presence", async () => {
    await holdBand(false);
    for (const path of READS) await call("read", { path });
    for (const path of READS) {
      await sidebar
        .locator(`a.presence[data-path="${path}"][data-presence="reading"]`)
        .waitFor({ timeout: 5000 });
    }
    await holdBand(true);
  });
  await client.close();
  await browser.close();

  if (problems.length > 0) {
    failed = true;
    console.log("FAIL: the app reported problems while the shots were taken:");
    for (const p of problems) console.log(`  - ${p}`);
  } else {
    console.log(`PASS: shots in ${out}`);
  }
} catch (e) {
  failed = true;
  console.log(`FAIL: ${e instanceof Error ? (e.stack ?? e.message) : String(e)}`);
  console.log(`cf dev, last output:\n${devLog.slice(-4000)}`);
} finally {
  stopDev();
  if (!values.keep) rmSync(project, { recursive: true, force: true });
}
process.exit(failed ? 1 : 0);
