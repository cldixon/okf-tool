/**
 * `bun run gate`: the Phase 1 gate against `cf dev` (spec: Phase 1 in detail, Gate), plus
 * the MCP smoke flow on a fresh, empty library.
 *
 * Starts the Worker with fresh local D1, R2 and DO state, seeds one library and write token per
 * sample bundle, imports each bundle as a tarball, exports it, and compares: same parsed
 * frontmatter (generated and verified included) and bodies, byte-identical attachments,
 * synthesized index.md and log.md ignored. Then checks every page and directory of each bundle
 * is the app's page and renders through the API (signed in by a dev magic link), drives the app in
 * Chromium (playwright-core; CHROME_PATH picks the binary), runs the nightly export through the Durable
 * Object into local R2, signs up a second user who must not see the first one's libraries
 * (v2 spec: Phases and gates, A1), has a fresh account sign up, connect over OAuth and write
 * (A2), and has three scripted agents work on one library at once (scripts/agents.ts), every
 * write reaching the change feed. Exits non-zero on any mismatch.
 *
 *   bun run gate [--port 8799] [--keep]
 */
import {
  appendFileSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { deflateSync } from "node:zlib";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { type Browser, chromium, type Route } from "playwright-core";
import { SESSION_REQUESTS_PER_MINUTE } from "../cloudflare.config";
import { FEED_FULL, FEED_SOCKETS_PER_ACCOUNT, FEED_SOCKETS_PER_LIBRARY } from "../src/feed";
import { readTar, writeTar } from "../src/util/tar";
import { compareBundle } from "../test/compare";
import { BUNDLES, loadBundle } from "../test/fixtures";
import { formatReport, runAgents } from "./agents";
import { d1Sql, WORKER_DIR } from "./cf";
// Every request the gate makes opens its own connection, never one cf dev may be closing as
// idle (TEMPRA-186); its MCP clients are given the same fetch.
import { localFetch as fetch } from "./local-fetch";
import { mcpSmoke } from "./mcp-smoke";
import { seed } from "./seed";

/**
 * On GitHub Actions, each failure and its problems also become an error annotation, so the check's
 * page says what failed without opening the job's log.
 */
if (process.env.GITHUB_ACTIONS === "true") {
  const log = console.log.bind(console);
  console.log = (...args: unknown[]) => {
    log(...args);
    const line = args.map(String).join(" ");
    if (/^(FAIL| {2}- )/.test(line)) {
      const text = line.replace(/%/g, "%25").replace(/\r/g, "%0D").replace(/\n/g, "%0A");
      log(`::error title=gate::${text.slice(0, 2000)}`);
    }
  };
}

const { values } = parseArgs({
  options: { port: { type: "string" }, keep: { type: "boolean" } },
});
const port = Number(values.port ?? 8799);
const base = `http://127.0.0.1:${port}`;

/**
 * `cf dev` keeps local state in .wrangler/state beside cloudflare.config.ts and takes no state
 * directory, so the gate runs it from a throwaway project under worker/.gate/: the config files
 * copied, src/, migrations/ and node_modules/ linked, and a .dev.vars with DEV_SIGNIN=1 so
 * sign-in links are shown on the page (on loopback only) instead of mailed.
 */
mkdirSync(join(WORKER_DIR, ".gate"), { recursive: true });
const project = mkdtempSync(join(WORKER_DIR, ".gate", "run-"));
for (const f of ["cloudflare.config.ts", "wrangler.config.ts", "package.json", "tsconfig.json"]) {
  copyFileSync(join(WORKER_DIR, f), join(project, f));
}
for (const d of ["src", "migrations", "node_modules"]) {
  symlinkSync(join(WORKER_DIR, d), join(project, d));
}
writeFileSync(join(project, ".dev.vars"), "DEV_SIGNIN=1\nSIGNUP=open\nAGENT_MODEL=fake\n");
const state = join(project, ".wrangler/state");

console.log(`project: ${project}`);
const tokens: ({ bundle: string } & Awaited<ReturnType<typeof seed>>)[] = [];
for (const b of BUNDLES) {
  tokens.push({ bundle: b, ...(await seed({ slug: b.replace(/_/g, "-"), persistTo: state })) });
}
const mcpToken = (await seed({ slug: "mcp", actor: "claude-code/gate", persistTo: state })).token;
// Scripted agents (scripts/agents.ts): three tokens on one library, one actor each.
const agentTokens = [];
for (let i = 1; i <= 3; i++) {
  agentTokens.push(
    await seed({ slug: "agents", actor: `claude-code/agent-${i}`, persistTo: state }),
  );
}

// The managed agent on for the seeded account (TEMPRA-222), on the scripted stand-in model that
// the gate's .dev.vars names, before cf dev opens the database.
await d1Sql(`UPDATE users SET limits = '{"agent_daily_usd":5}' WHERE id = 'user_dev'`, {
  local: true,
  persistTo: state,
});

// Its own process group, so stopping it stops wrangler and workerd beneath it too (they share
// its stderr, which ends only when all of them have).
const dev = Bun.spawn(["bunx", "cf", "dev", "--port", String(port)], {
  detached: true,
  cwd: project,
  env: { ...process.env, CF_SEND_TELEMETRY: "false", CI: "1" },
  stdout: "pipe",
  stderr: "pipe",
});
/**
 * cf dev's output, read as it comes so a full pipe can never stall it: the last 64 KB of each
 * stream kept for a failure, and all of it in GATE_LOGS/cf-dev.log.
 */
const devTail = { stdout: "", stderr: "" };
async function drain(name: "stdout" | "stderr", stream: ReadableStream<Uint8Array>) {
  const decoder = new TextDecoder();
  for await (const chunk of stream) {
    const text = decoder.decode(chunk, { stream: true });
    devTail[name] = (devTail[name] + text).slice(-65_536);
    if (process.env.GATE_LOGS) appendFileSync(join(process.env.GATE_LOGS, "cf-dev.log"), text);
  }
}
const drained = Promise.all([drain("stdout", dev.stdout), drain("stderr", dev.stderr)]).catch(
  () => {},
);
function stopDev() {
  try {
    process.kill(-dev.pid, "SIGKILL");
  } catch {
    // Already gone.
  }
}

async function waitForHealth() {
  for (let i = 0; i < 120; i++) {
    try {
      const r = await fetch(`${base}/healthz`);
      if (r.ok) return;
    } catch {}
    await Bun.sleep(500);
  }
  throw new Error("cf dev did not become healthy");
}

/** Signs in by a dev magic link (DEV_SIGNIN=1 shows it on the page); returns the session cookie. */
async function signIn(email: string): Promise<string> {
  const asked = await fetch(`${base}/sign-in`, {
    method: "POST",
    headers: { Origin: base },
    body: new URLSearchParams({ email, next: "/" }),
  });
  const html = await asked.text();
  const t = /[?&]t=([0-9a-f]{64})/.exec(html.replace(/&#38;/g, "&"))?.[1];
  if (!t) throw new Error(`sign-in for ${email}: ${asked.status} ${html.slice(0, 300)}`);
  const done = await fetch(`${base}/sign-in/link`, {
    method: "POST",
    headers: { Origin: base },
    body: new URLSearchParams({ t, next: "/" }),
    redirect: "manual",
  });
  const cookie = done.headers.get("Set-Cookie")?.split(";")[0];
  if (done.status !== 303 || !cookie) throw new Error(`sign-in link for ${email}: ${done.status}`);
  return cookie;
}

/** The seeded user's session, set once the Worker is up. */
let devCookie = "";

/** A UI request as the seeded user; a redirect (e.g. to sign-in) is not followed. */
function ui(url: string, init: RequestInit = {}, cookie = devCookie) {
  const headers = new Headers(init.headers);
  headers.set("Cookie", cookie);
  return fetch(url, { ...init, headers, redirect: "manual" });
}

/** A JSON call to the REST API as a signed-in person (the app's own calls). */
function apiAs(cookie: string, path: string, method = "GET", body?: unknown) {
  return ui(
    `${base}${path}`,
    {
      method,
      headers: { Origin: base, Accept: "application/json", "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    },
    cookie,
  );
}

/**
 * Every page of a library is the app's shell at its URL (TEMPRA-9), and every file reads through
 * the API as the app reads it (GET …/files/{path} as JSON), as the signed-in person.
 */
async function uiPages(owner: string, slug: string, paths: string[]): Promise<string[]> {
  const enc = (p: string) => p.split("/").map(encodeURIComponent).join("/");
  const lib = `${base}/${owner}/${slug}`;
  const api = `${base}/api/v1/libraries/${owner}/${slug}`;
  const pagePaths = paths.filter((p) => p.endsWith(".md") && !/(^|\/)(index|log)\.md$/.test(p));
  const dirs = new Set<string>();
  for (const p of paths) {
    const parts = p.split("/").slice(0, -1);
    for (let i = 1; i <= parts.length; i++) dirs.add(parts.slice(0, i).join("/"));
  }
  const pages = [
    `${lib}/`,
    `${lib}/-/ledger`,
    ...["activity", "transfer", "recovery", "connect", "delete"].map((p) => `${lib}/-/${p}`),
    ...[...dirs].map((d) => `${lib}/${enc(d)}/`),
    ...pagePaths.map((p) => `${lib}/${enc(p)}`),
  ];
  const problems: string[] = [];
  // Needs you is retired, and the Inbox page with it (TEMPRA-116, TEMPRA-189): its URL lands on
  // the library's home, and `/inbox` on the library list.
  const needs = await ui(`${lib}/-/needs`);
  if (needs.status !== 308 || needs.headers.get("Location") !== `/${owner}/${slug}/`) {
    problems.push(`-/needs: ${needs.status} ${needs.headers.get("Location")}`);
  }
  const inboxPage = await ui(`${base}/inbox`);
  if (inboxPage.status !== 302 || inboxPage.headers.get("Location") !== "/") {
    problems.push(`/inbox: ${inboxPage.status} ${inboxPage.headers.get("Location")}`);
  }
  // For agents is retired (TEMPRA-144): its URL lands on the library's home.
  const work = await ui(`${lib}/-/work`);
  if (work.status !== 308 || work.headers.get("Location") !== `/${owner}/${slug}/`) {
    problems.push(`-/work: ${work.status} ${work.headers.get("Location")}`);
  }
  for (const url of pages) {
    const r = await ui(url);
    const html = await r.text();
    if (r.status !== 200 || !html.includes('<div id="root"></div>')) {
      problems.push(`${url.slice(base.length)}: ${r.status} ${html.slice(0, 200)}`);
    }
  }
  for (const p of [...pagePaths, "index.md", "log.md"]) {
    const r = await ui(`${api}/files/${enc(p)}`, { headers: { Accept: "application/json" } });
    const body = (await r.json().catch(() => null)) as { kind?: string } | null;
    if (r.status !== 200 || !body?.kind) {
      problems.push(`files ${p}: ${r.status} ${JSON.stringify(body).slice(0, 200)}`);
    }
  }
  return problems;
}

/** A Chromium for the browser step: CHROME_PATH, the container's Playwright build, or Chrome. */
function chromiumPath(): string | null {
  const candidates = [
    process.env.CHROME_PATH,
    "/opt/pw-browsers/chromium",
    "/usr/bin/google-chrome",
    "/usr/bin/chromium",
  ];
  return candidates.find((p): p is string => !!p && existsSync(p)) ?? null;
}

/** The longest one browser step may take before it is reported as hung. */
const STEP_MS = 90_000;

/** Resolves with `work`, or rejects once `ms` pass, naming what took too long. */
class NoAnswer extends Error {}

function within<T>(ms: number, what: string, work: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new NoAnswer(`${what}: no answer in ${ms / 1000} s`)), ms);
  });
  return Promise.race([work, late]).finally(() => clearTimeout(timer));
}

/**
 * GATE_LOGS=<dir>: what a failed run leaves for diagnosis (CI uploads it). cf dev's output
 * (cf-dev.log), and per browser N: Chrome's own log (chrome-N.log), a Playwright trace of its
 * actions, network and console (trace-N.zip, kept only when a step failed) and, when the browser
 * stops answering, the page's state at that moment (stuck-N.txt, also printed).
 */
const LOGS = process.env.GATE_LOGS;
let browsers = 0;
/** How long one Chrome launch may take; playwright's default is 180 s. */
const LAUNCH_TIMEOUT_MS = 30_000;

/** At most `n` characters of `s`, on one line. */
const clip = (s: string, n = 160) => s.replace(/\s+/g, " ").slice(0, n);

/** Chrome's processes (state, CPU, memory, what each waits in): a busy renderer or a blocked one. */
function chromeProcesses(exe: string): string[] {
  const ps = Bun.spawnSync(["ps", "-eo", "pid,ppid,stat,pcpu,rss,etime,wchan:24,args"]);
  const lines = ps.stdout.toString().split("\n");
  return [lines[0] ?? "", ...lines.filter((l) => l.includes(exe))].map((l) => clip(l, 200));
}

/**
 * Chromium with one page that records every failed response, console error and page error as a
 * problem; `step` runs a part of a check and records its failure without stopping the rest.
 */
async function openBrowser() {
  const executablePath = chromiumPath();
  if (!executablePath) return "no Chromium found; set CHROME_PATH";
  const n = ++browsers;
  /** Chrome's own log, written by Chrome: crashes, GPU, sandbox, IPC and network errors. */
  const chromeLog = LOGS ? join(LOGS, `chrome-${n}.log`) : null;
  const launch = () =>
    chromium.launch({
      executablePath,
      args: chromeLog ? ["--enable-logging", `--log-file=${chromeLog}`, "--v=0"] : [],
      timeout: LAUNCH_TIMEOUT_MS,
    });
  // Chrome now and then fails to start on CI runners (spawn ENOENT, then a launch that never
  // answers; run 38174138102). A launch that fails is tried once more: playwright gives each
  // launch a fresh profile dir of its own, and the first attempt's Chrome log stays as
  // chrome-N-failed.log. Only the launch is retried; a step that fails later fails the gate.
  let browser: Browser;
  try {
    browser = await launch();
  } catch (e) {
    if (chromeLog && existsSync(chromeLog))
      renameSync(chromeLog, chromeLog.replace(/\.log$/, "-failed.log"));
    if (process.env.GATE_TRACE)
      console.log(`  [browser ${n}] launch failed, trying once more: ${clip(String(e), 400)}`);
    browser = await launch();
  }
  if (process.env.GATE_TRACE)
    console.log(`  [browser ${n}] ${executablePath} ${browser.version()}`);
  const context = await browser.newContext();
  // Actions, network and console; no screenshots or DOM snapshots, so the timing the checks
  // depend on stays as it was.
  if (LOGS) await context.tracing.start({ screenshots: false, snapshots: false });
  const page = await context.newPage();
  const problems: string[] = [];
  /** The page's recent life, for when it stops answering. */
  const recent: string[] = [];
  const note = (line: string) => {
    recent.push(`${new Date().toISOString()} ${clip(line)}`);
    if (recent.length > 40) recent.shift();
  };
  const pending = new Map<object, { what: string; since: number }>();
  const sockets = new Map<object, { url: string; since: number }>();
  /**
   * When each request that counts against the browser session's limit was sent (TEMPRA-80):
   * pages, API calls and feed upgrades to the app; not the static files.
   */
  const counted: { at: number; what: string }[] = [];
  const countsAgainstSession = (url: string) => {
    const u = new URL(url);
    return u.origin === base && !/^\/(_app|_design)\/|^\/(favicon\.svg|healthz)$/.test(u.pathname);
  };
  // Failed requests are reported by URL below; the console only repeats them.
  page.on("console", (m) => {
    note(`console.${m.type()}: ${m.text()}`);
    if (m.type() === "error" && !m.text().startsWith("Failed to load resource")) {
      problems.push(`console: ${m.text()}`);
    }
  });
  page.on("request", (r) => {
    pending.set(r, { what: `${r.method()} ${r.url().replace(base, "")}`, since: Date.now() });
    if (countsAgainstSession(r.url())) {
      const path = new URL(r.url()).pathname.replace(/^\/api\/v1\/libraries\/[^/]+\/[^/]+/, "…");
      counted.push({
        at: Date.now(),
        what: `${r.method()} ${path.replace(/\/(files|page|sources|links|history|read|comments|media)\/.+/, "/$1/*")}`,
      });
    }
  });
  page.on("requestfinished", (r) => pending.delete(r));
  page.on("requestfailed", (r) => {
    pending.delete(r);
    note(`request failed: ${r.method()} ${r.url().replace(base, "")} ${r.failure()?.errorText}`);
  });
  page.on("websocket", (ws) => {
    sockets.set(ws, { url: ws.url(), since: Date.now() });
    counted.push({ at: Date.now(), what: "feed socket" });
    ws.on("close", () => sockets.delete(ws));
  });
  page.on("framenavigated", (f) => {
    if (f === page.mainFrame()) note(`navigated: ${f.url().replace(base, "")}`);
  });
  page.on("crash", () => note("the page crashed"));
  // Handled here, so Playwright no longer dismisses dialogs itself: dismissed as it would, noted.
  page.on("dialog", (d) => {
    note(`dialog ${d.type()}: ${d.message()}`);
    d.dismiss().catch(() => {});
  });
  /** Paths a step means to find missing (a Not found page): their 404s are not problems. */
  const missing = new Set<string>();
  const expect404 = (path: string) => missing.add(path);
  page.on("response", (r) => {
    const url = new URL(r.url());
    const path = url.pathname;
    const meant = [...missing].some(
      (m) =>
        path.replace(/^\/api\/v1\/libraries\/[^/]+\/[^/]+\/[a-z]+\//, "") === m ||
        url.searchParams.get("path") === m,
    );
    if (r.status() === 404 && meant) return;
    if (r.status() >= 400 && path !== "/favicon.ico") {
      problems.push(`${r.status()} ${path}`);
    }
  });
  page.on("pageerror", (e) => problems.push(`page error: ${e.message}`));

  /** What the browser and the page were doing when `what` got no answer; printed and kept. */
  const diagnose = async (what: string) => {
    const now = Date.now();
    const age = (since: number) => `${((now - since) / 1000).toFixed(1)} s`;
    // Whether the browser still answers outside the page tells a stuck renderer from a stuck
    // browser process (or a stuck connection to it).
    const targets = await within(
      10_000,
      "the browser's own CDP session",
      browser
        .newBrowserCDPSession()
        .then((s) => s.send("Target.getTargets"))
        .then((r) =>
          r.targetInfos.map((t) => `${t.type}${t.attached ? " attached" : ""} ${clip(t.url, 100)}`),
        ),
    ).catch((e) => [String(e)]);
    const lines = [
      `the browser stopped answering in "${what}" (browser ${n}, ${browser.version()})`,
      `page: ${page.url()}${page.isClosed() ? " (closed)" : ""}`,
      `requests in flight (${pending.size}):`,
      ...[...pending.values()].map((r) => `  ${r.what} for ${age(r.since)}`),
      `open WebSockets (${sockets.size}):`,
      ...[...sockets.values()].map((w) => `  ${w.url} for ${age(w.since)}`),
      "the browser's targets:",
      ...targets.map((t) => `  ${t}`),
      "Chrome's processes:",
      ...chromeProcesses(executablePath).map((l) => `  ${l}`),
      "the page's last events:",
      ...recent.map((l) => `  ${l}`),
    ];
    console.log(lines.map((l) => `  | ${l}`).join("\n"));
    if (LOGS) writeFileSync(join(LOGS, `stuck-${n}.txt`), `${lines.join("\n")}\n`);
  };

  let failures = 0;
  /** The step the browser stopped answering in; every later step is skipped, not waited out. */
  let stuck: string | null = null;
  const step = async (what: string, run: () => Promise<unknown>) => {
    if (stuck) {
      problems.push(`${what}: skipped, the browser stopped answering in "${stuck}"`);
      return;
    }
    const t0 = Date.now();
    if (process.env.GATE_TRACE) console.log(`  [step] ${what}`);
    try {
      // A step that hangs (a wait with no timeout of its own) fails by name rather than
      // silently using up the CI job's time.
      await within(STEP_MS, what, run());
    } catch (e) {
      failures++;
      problems.push(`${what}: ${String(e).split("\n")[0]}`);
      if (process.env.GATE_TRACE)
        console.log(`  [step failed after ${Date.now() - t0} ms] ${what}`);
      if (e instanceof NoAnswer) {
        stuck = what;
        await diagnose(what);
      }
      // GATE_SCREENSHOTS: what the page showed when the step failed (if it still answers).
      const shots = process.env.GATE_SCREENSHOTS;
      if (shots) {
        await within(
          10_000,
          "screenshot",
          page.screenshot({ path: `${shots}/failed-${n}-${failures}.png`, fullPage: true }),
        ).catch(() => {});
      }
    }
  };
  /**
   * Closes the browser, giving up after a while: on CI's Google Chrome a close has never
   * returned, after every check had run. A stuck close is diagnosed and reported, not waited on;
   * the gate exits explicitly and the runner reaps what is left. The trace is kept only when a
   * step failed.
   */
  const close = async () => {
    if (LOGS) {
      await within(
        20_000,
        "saving the trace",
        context.tracing.stop(failures > 0 ? { path: join(LOGS, `trace-${n}.zip`) } : {}),
      ).catch((e) => console.log(`  (note: ${String(e)})`));
    }
    try {
      await within(30_000, "closing the browser", browser.close());
    } catch (e) {
      console.log(`  (note: ${String(e)}; carrying on)`);
      if (!stuck) await diagnose("closing the browser");
    }
  };
  /**
   * Signs in the way a person does: the email form, then the (dev, on-page) link, or with
   * `byCode` the code typed on the page that asked, loosely (lower case; TEMPRA-188).
   */
  const signInAs = async (email: string, next: string, byCode = false) => {
    await page.goto(`${base}/sign-in?next=${encodeURIComponent(next)}`);
    await page.locator('input[name="email"]').fill(email);
    await page.getByRole("button", { name: "Continue" }).click();
    await page.getByRole("heading", { name: "Check your email" }).waitFor();
    if (byCode) {
      const code = (await page.locator("#dev-code").innerText()).trim();
      if (!/^[0-9A-Z]{8}$/.test(code)) throw new Error(`the dev code reads "${code}"`);
      await page.getByLabel("Code").fill(code.toLowerCase());
      await page.getByRole("button", { name: "Continue" }).click();
      await page.waitForURL((u) => !u.pathname.startsWith("/sign-in"), { timeout: 15_000 });
      return;
    }
    const link = await page.locator('a[href*="/sign-in/link?t="]').first().getAttribute("href");
    await page.goto(new URL(link ?? "", base).href);
    // The link's page names the address it is for (TEMPRA-287).
    await page.getByText(`Continue as ${email.toLowerCase()}`).waitFor();
    await page.getByRole("button", { name: "Continue" }).click();
  };
  /** The session cookie, for requests made beside the browser. */
  const cookie = async () =>
    (await context.cookies())
      .filter((c) => c.name.includes("session"))
      .map((c) => `${c.name}=${c.value}`)
      .join("; ");
  /**
   * The most counted requests in any 60 seconds so far (from `since`), when that minute began,
   * and what they were (the commonest first).
   */
  const busiestMinute = (since = 0) => {
    let peak = 0;
    let first = 0;
    for (let i = 0, j = 0; j < counted.length; j++) {
      if ((counted[j]?.at ?? 0) < since) {
        i = j + 1;
        continue;
      }
      while ((counted[j]?.at ?? 0) - (counted[i]?.at ?? 0) >= 60_000) i++;
      if (j - i + 1 > peak) {
        peak = j - i + 1;
        first = i;
      }
    }
    const kinds = new Map<string, number>();
    for (const c of counted.slice(first, first + peak)) {
      kinds.set(c.what, (kinds.get(c.what) ?? 0) + 1);
    }
    const what = [...kinds].sort((a, b) => b[1] - a[1]).map(([k, n]) => `${n} ${k}`);
    return { peak, from: counted[first]?.at ?? 0, what };
  };
  /** The counted requests sent from `from` (ms since the epoch) to `to`, by kind. */
  const requestsBetween = (from: number, to = Date.now()) =>
    counted.filter((c) => c.at >= from && c.at < to).map((c) => c.what);
  return {
    browser,
    context,
    page,
    problems,
    step,
    close,
    signInAs,
    cookie,
    busiestMinute,
    requestsBetween,
    expect404,
  };
}

/** A folder's name as the app shows it (app/src/urls.ts folderName): dashes as spaces, capitalised. */
function folderName(path: string): string {
  const name = (path.split("/").pop() ?? "").replace(/[-_]+/g, " ").trim();
  return name ? (name[0]?.toUpperCase() ?? "") + name.slice(1) : path;
}

/** `s` as a literal in a regular expression. */
const literal = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

/** A plain grey PNG, `width` by `height` (8-bit greyscale), for the gate's figures. */
function greyPng(width: number, height: number, shade: number): Uint8Array {
  return greyscalePng(width, height, () => shade);
}

/**
 * A busy greyscale PNG, like a screenshot in bytes: tiles of shades with a little noise, so it
 * compresses about as badly as one (1600 by 1000 is about a megabyte).
 */
function busyPng(width: number, height: number): Uint8Array {
  let seed = 11;
  const rand = () => {
    seed = (Math.imul(seed, 1103515245) + 12345) >>> 0;
    return seed >>> 24;
  };
  const tiles = Array.from({ length: Math.ceil(width / 24) * Math.ceil(height / 24) }, rand);
  const across = Math.ceil(width / 24);
  return greyscalePng(width, height, (x, y) => {
    const tile = tiles[Math.floor(y / 24) * across + Math.floor(x / 24)] ?? 0;
    return Math.max(0, Math.min(255, tile + (rand() % 24) - 12));
  });
}

function greyscalePng(
  width: number,
  height: number,
  shade: (x: number, y: number) => number,
): Uint8Array {
  const crc = (bytes: Uint8Array) => {
    let c = 0xffffffff;
    for (const b of bytes) c = (CRC_TABLE[(c ^ b) & 0xff] ?? 0) ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type: string, data: Uint8Array) => {
    const out = new Uint8Array(12 + data.length);
    const view = new DataView(out.buffer);
    view.setUint32(0, data.length);
    out.set(new TextEncoder().encode(type), 4);
    out.set(data, 8);
    view.setUint32(8 + data.length, crc(out.subarray(4, 8 + data.length)));
    return out;
  };
  const header = new Uint8Array(13);
  const h = new DataView(header.buffer);
  h.setUint32(0, width);
  h.setUint32(4, height);
  header.set([8, 0, 0, 0, 0], 8); // 8-bit greyscale, no interlace
  const raw = new Uint8Array(height * (width + 1));
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) raw[y * (width + 1) + 1 + x] = shade(x, y);
  }
  const parts = [
    new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", header),
    chunk("IDAT", new Uint8Array(deflateSync(raw))),
    chunk("IEND", new Uint8Array(0)),
  ];
  const png = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    png.set(p, at);
    at += p.length;
  }
  return png;
}

/**
 * The app in a real browser, signed in as the seeded user (layout take 4, TEMPRA-113 to 118):
 * the library's home (no sections, no housekeeping, nothing counted for the person), the workspace (the bar's
 * mark, library, switcher, search and page path, the tree, the foot's Activity and Settings, the
 * Settings page's sections in the library's frame, the quick switcher, the hidden sidebar; at
 * phone width the bar's mark and library, the drawer with the bar's parts at its head, the tree,
 * Activity and Settings, the home stacked, the Settings page's drawer, the library's own), a folder's address revealing it, Not found for a moved
 * path, an attachment's page, every page in the reader (drawn from the stored
 * tree, with no Edit, a footnote card on hover), the page's corner tools and its panels
 * (Comments and Page info, TEMPRA-283: opened from the corner row, closed by ×, Escape and the
 * same button, the contents back, `?panel=`), Copy page and its ⌄, the byline while an agent
 * edits, Page info's versions, checking a page (Mark as checked, the Checked line, review mode),
 * comments in the panel, a page on a phone (the corner row under the byline,
 * On this page, every panel as a bottom sheet), the Markdown view,
 * figures in the full-screen view, notifications (a reply waiting in the bell's panel, opened into
 * its thread; nothing for a checked page an agent edited), and
 * Activity with its two views (By page and
 * Every event), all drawn from the API; links move within the app without reloading the page, and
 * nothing is refused by the CSP or throws. GATE_SCREENSHOTS=<dir> saves screenshots of them.
 */
async function browserRenders(
  owner: string,
  slug: string,
  pagePaths: string[],
  token: string,
): Promise<string[]> {
  const b = await openBrowser();
  if (typeof b === "string") return [b];
  const { page, step, problems } = b;
  try {
    const enc = (p: string) => p.split("/").map(encodeURIComponent).join("/");
    const main = page.locator("main.ws-main");
    /** The top bar (take 4): over the page its path (TEMPRA-145) and its tools on the right. */
    const sheetBar = page.locator("header.ws-topbar");
    /**
     * A page's corner tools (TEMPRA-283): Comments, Page info and Copy page | ⌄, in the right
     * column's corner or under the byline (whichever is on screen).
     */
    const tool = (panel: "comments" | "info") =>
      main.locator(`.page-tools [data-panel="${panel}"]`).filter({ visible: true }).first();
    const copyButton = () =>
      main.locator(".page-tools .split-main").filter({ visible: true }).first();
    const copyMore = () =>
      main.locator(".page-tools .split-more").filter({ visible: true }).first();
    /** The page's panels: one at a time, in place of the contents. */
    const comments = page.locator("aside#panel-comments.page-aside");
    /** Page info (TEMPRA-283): History and Properties in one panel. */
    const infoPanel = page.locator("aside#panel-info.page-aside");
    const historyPanel = infoPanel;
    const properties = () => infoPanel;
    /** Page info, opened from its corner button unless it is open. */
    const openInfo = async () => {
      if ((await infoPanel.count()) === 0) await tool("info").click();
      await infoPanel.waitFor({ timeout: 10_000 });
    };
    /** Comments from the corner row. */
    const openComments = async () => {
      await tool("comments").click();
    };
    /** From the keyboard: Comments focused, Enter. */
    const openCommentsByKeys = async () => {
      await tool("comments").focus();
      await page.keyboard.press("Enter");
    };
    /** Someone else's write: the agent dot on Page info; Page info's Show it brings it in. */
    const newVersion = () => tool("info").locator(".icon-button-dot");
    const showNewVersion = async () => {
      const wasComments = (await comments.count()) > 0;
      await openInfo();
      const show = infoPanel.getByRole("button", { name: "Show it" });
      await show.click();
      await show.waitFor({ state: "detached", timeout: 10_000 });
      if (wasComments) {
        await openComments();
        await comments.waitFor({ timeout: 5000 });
      } else {
        await page.keyboard.press("Escape");
        await infoPanel.waitFor({ state: "detached", timeout: 5000 });
      }
    };
    /** The contents on the right, while no panel is open and there is room. */
    const contentsNav = main.locator("nav.page-contents");
    /** An item of the Copy page button's ⌄ (View Markdown); History and Properties are Page info. */
    const more = async (item: string) => {
      if (item === "History" || item === "Properties") return openInfo();
      await copyMore().click();
      await page.locator(".menu-list").getByRole("button", { name: item, exact: true }).click();
    };
    const byline = main.locator(".byline");
    /** Page info's top lines (TEMPRA-283): the newer version and the check. */
    const check = () => infoPanel.locator(".page-info-now");
    /** The quiet line under the byline once a person has checked the page. */
    const checkedLine = main.locator("p.doc-checked");
    /** A width with room for the contents (or a panel) beside the text. */
    const wide = () => page.setViewportSize({ width: 1600, height: 900 });
    const usual = () => page.setViewportSize({ width: 1280, height: 720 });

    await step("sign in", async () => {
      await b.signInAs("dev@localhost", `/${owner}/${slug}/`);
      await page.waitForURL(`${base}/${owner}/${slug}/`);
    });
    const shots = process.env.GATE_SCREENSHOTS;
    const home = async () => {
      await main
        .getByRole("heading", { level: 1, name: slug, exact: true })
        .waitFor({ timeout: 15_000 });
    };
    // The workspace (TEMPRA-19): the tree stays while files open in the main pane.
    const nested = pagePaths.find((c) => c.includes("/")) ?? pagePaths[0] ?? "";
    const folder = nested.split("/").slice(0, -1).join("/");
    const sidebar = page.locator("section.ws-sidebar");
    const lib = `${base}/${owner}/${slug}`;
    /**
     * At phone width (TEMPRA-140, TEMPRA-145): the top bar shows the Tempra mark and the
     * library's name (or "Tempra" off a library), never the page's name; the page's own title
     * names it.
     */
    const phoneNamed = async (name: string, place = slug) => {
      const exact = new RegExp(`^${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`);
      await main.locator("h1").filter({ hasText: exact }).first().waitFor({ timeout: 10_000 });
      const bar = sheetBar.locator(".ws-topbar-place");
      await bar
        .getByRole("link", { name: "Tempra", exact: true })
        .first()
        .waitFor({ timeout: 5000 });
      await bar.locator("a.brand-name", { hasText: place }).waitFor({ timeout: 5000 });
      // (The desktop's part of the bar is there too, hidden at this width.)
      const named = sheetBar.getByText(name, { exact: true }).filter({ visible: true });
      if (name !== place && (await named.count()) > 0) {
        throw new Error(`the phone's top bar names "${name}" above the page's own title`);
      }
    };
    /**
     * The phone's drawer, open (TEMPRA-141, TEMPRA-145): its head is the desktop's bar over the
     * sidebar (the mark, the library's name, its switcher, search) and ×; off a library the mark
     * and "Tempra".
     */
    const drawerHead = async (place: string, library = true) => {
      const head = sidebar.locator(".drawer-head");
      await head
        .getByRole("link", { name: "Tempra", exact: true })
        .first()
        .waitFor({ timeout: 5000 });
      const named = (await head.locator("a.brand-name").innerText()).trim();
      if (named !== place) throw new Error(`the drawer's head names "${named}", not "${place}"`);
      const switcher = head.getByRole("button", { name: "Switch library" });
      if ((await switcher.isVisible()) !== library) {
        throw new Error(`the drawer's head ${library ? "lacks" : "has"} the library switcher`);
      }
      await head.getByRole("button", { name: "Search", exact: true }).waitFor({ timeout: 5000 });
      await head.getByRole("button", { name: "Close menu" }).waitFor({ timeout: 5000 });
    };
    await step("the library's root is its home: no sections, no housekeeping", async () => {
      await home();
      // No sections: the tree beside it lists the folders (TEMPRA-138).
      await main.locator(".home-section").first().waitFor({ timeout: 15_000 });
      if ((await main.getByRole("heading", { level: 2, name: "Sections" }).count()) > 0) {
        throw new Error("the home still lists sections");
      }
      // No agents' housekeeping, though the work queue has some (TEMPRA-144): it is theirs. The
      // sample bundles leave none since the pages-not-okf checks, so an agent leaves a page
      // with a link to nowhere for the length of this step.
      const auth = { Authorization: `Bearer ${token}` };
      const chore = `${base}/api/v1/libraries/${owner}/${slug}/files/gate-chore.md`;
      const put = await fetch(chore, {
        method: "PUT",
        headers: { ...auth, "Content-Type": "text/markdown", "X-Note": "gate: a chore for agents" },
        body: "---\ntitle: Gate chore\ndescription: Links nowhere.\n---\nSee [gone](/gate-gone.md).\n",
      });
      if (!put.ok) throw new Error(`write gate-chore.md: ${put.status}`);
      await page.reload();
      await main.locator(".home-section").first().waitFor({ timeout: 15_000 });
      const work = (await (
        await fetch(`${base}/api/v1/libraries/${owner}/${slug}/work`, { headers: auth })
      ).json()) as { total: number };
      if (work.total === 0) throw new Error("the agents have nothing to do");
      if ((await main.getByText(/housekeeping|for agents/i).count()) > 0) {
        throw new Error("the home shows the agents' housekeeping");
      }
      if ((await page.locator(`a[href*="/-/work"]`).count()) > 0) {
        throw new Error("a link to the retired For agents page");
      }
      // Its old address lands here.
      await page.goto(`${base}/${owner}/${slug}/-/work?kind=lint`);
      await page.waitForURL(`${base}/${owner}/${slug}/`);
      const now = await fetch(chore, { headers: auth });
      await now.arrayBuffer();
      const gone = await fetch(chore, {
        method: "DELETE",
        headers: { ...auth, "If-Match": now.headers.get("ETag") ?? "", "X-Note": "gate: tidy" },
      });
      if (!gone.ok) throw new Error(`delete gate-chore.md: ${gone.status}`);
      await home();
      if (shots) await page.screenshot({ path: `${shots}/home.png` });
    });
    const bearer = { Authorization: `Bearer ${token}` };
    const libApi = `${base}/api/v1/libraries/${owner}/${slug}`;
    /** An agent deletes a file the gate wrote (a delete names the version it removes). */
    const agentDeletes = async (path: string) => {
      const now = await fetch(`${libApi}/files/${enc(path)}`, { headers: bearer });
      await now.arrayBuffer();
      const gone = await fetch(`${libApi}/files/${enc(path)}`, {
        method: "DELETE",
        headers: { ...bearer, "If-Match": now.headers.get("ETag") ?? "", "X-Note": "gate: tidy" },
      });
      if (!gone.ok) throw new Error(`delete ${path}: ${gone.status} ${await gone.text()}`);
    };
    await step("workspace: open a file from the tree, the sidebar stays", async () => {
      await sidebar.getByRole("navigation", { name: "Files" }).waitFor({ timeout: 15_000 });
      await sidebar.evaluate((el) => {
        (el as unknown as { dataset: Record<string, string> }).dataset.gate = "kept";
      });
      if (folder) {
        // Opening a folder is instant: the tree has the whole index, so no request is made.
        let asked = 0;
        const count = (r: { url(): string }) => {
          if (/\/(tree|outline)(\?|$)/.test(new URL(r.url()).pathname)) asked++;
        };
        page.on("request", count);
        // Folders read as names ("Computations"), with their count beside them. A folder is a
        // group, not a page (TEMPRA-138): its whole row opens and closes it, in place.
        const files = sidebar.getByRole("navigation", { name: "Files" });
        const row = files.locator(`button.tree-name[title="${folderName(folder)}"]`).first();
        // On first entry every folder is open, the library laid out (TEMPRA-146).
        const shut = await files.locator('button.tree-name[aria-expanded="false"]').count();
        if (shut > 0) throw new Error(`${shut} folder(s) start closed in the tree`);
        const at = page.url();
        const open = (await row.getAttribute("aria-expanded")) === "true";
        if (open) await row.click();
        await sidebar
          .locator(`a[data-path="${nested}"]`)
          .waitFor({ state: "detached", timeout: 1000 });
        await markStay();
        await row.click();
        await sidebar.locator(`a[data-path="${nested}"]`).waitFor({ timeout: 1000 });
        if ((await row.getAttribute("aria-expanded")) !== "true") {
          throw new Error("the folder's row does not say it is open");
        }
        if (page.url() !== at) throw new Error(`opening a folder moved the page to ${page.url()}`);
        if (!(await stayed())) throw new Error("opening a folder reloaded the page");
        // Only pages and files are ever the current row.
        if ((await files.locator(".tree-row.dir [aria-current]").count()) > 0) {
          throw new Error("a folder is the current row");
        }
        page.off("request", count);
        if (asked > 0) throw new Error(`opening a folder made ${asked} request(s)`);
        // Files come after the pages in each folder, with a file icon; at the root after the
        // folders and the root pages.
        const file = `${folder}/gate-tree-file.png`;
        const put = await fetch(`${libApi}/files/${enc(file)}`, {
          method: "PUT",
          headers: { ...bearer, "Content-Type": "image/png", "X-Note": "gate: a file in the tree" },
          body: greyPng(8, 8, 0x99),
        });
        if (!put.ok) throw new Error(`upload ${file}: ${put.status} ${await put.text()}`);
        const fileRow = sidebar.locator(`.tree-row.file:has(a[data-path="${file}"])`);
        await fileRow.waitFor({ timeout: 10_000 });
        if ((await fileRow.locator("svg").count()) !== 1)
          throw new Error("no icon on a file's row");
        const misplaced = await page.evaluate<string[]>(`(() => {
          const bad = [];
          for (const ul of document.querySelectorAll('nav[aria-label="Files"] ul')) {
            let rank = 0;
            for (const li of ul.children) {
              const row = li.querySelector(":scope > .tree-row");
              if (!row) continue;
              const r = row.classList.contains("dir") ? 0 : row.classList.contains("file") ? 2 : 1;
              if (r < rank) bad.push(row.textContent);
              rank = Math.max(rank, r);
            }
          }
          return bad;
        })()`);
        if (misplaced.length > 0) {
          throw new Error(`rows out of order (folders, pages, files): ${misplaced.join(", ")}`);
        }
        await agentDeletes(file);
        await fileRow.waitFor({ state: "detached", timeout: 10_000 });
      }
      await sidebar.locator(`a[data-path="${nested}"]`).click();
      await page.waitForURL(`${lib}/${enc(nested)}`);
      await page.locator(".body .prose").waitFor({ timeout: 15_000 });
      if ((await sidebar.locator(`a[aria-current="page"][data-path="${nested}"]`).count()) !== 1) {
        throw new Error("the open file is not marked in the tree");
      }
      // Page info (its versions) from the corner row; Escape closes it.
      await openInfo();
      await historyPanel.locator("a.version").first().waitFor({ timeout: 10_000 });
      await page.keyboard.press("Escape");
      await historyPanel.waitFor({ state: "detached", timeout: 5000 });
      await page.goBack();
      await page.waitForURL(`${lib}/`);
      await home();
      await page.goForward();
      await page.waitForURL(`${lib}/${enc(nested)}`);
      // A page seen before draws from the cache: no loading state on the way back.
      if ((await page.getByText("Loading…").count()) > 0) {
        throw new Error("a page seen before showed Loading… again");
      }
      await page.locator(".body .prose").waitFor({ timeout: 1000 });
      if ((await page.locator('.ws-sidebar[data-gate="kept"]').count()) !== 1) {
        throw new Error("the sidebar was rebuilt (the page reloaded or the frame remounted)");
      }
    });
    await step(
      "workspace: hover prefetches, new pages start at the top, back restores",
      async () => {
        const other = pagePaths.find(
          (c) => c !== nested && c.split("/").slice(0, -1).join("/") === folder,
        );
        if (!other) throw new Error(`no second page in ${folder}/ to move to`);
        await page.locator(".body .prose").waitFor({ timeout: 15_000 });
        await main.evaluate((el) => {
          el.scrollTop = 300;
        });
        const before = await main.evaluate((el) => el.scrollTop);
        const title = await main.locator("h1.doc-title").innerText();
        const link = sidebar.locator(`a[data-path="${other}"]`);
        await link.hover();
        await page.waitForTimeout(1500); // the hover's prefetch lands in the cache
        await link.click();
        await page.waitForURL(`${lib}/${enc(other)}`);
        // The URL changes before the app draws the new page: wait for the page itself (on a
        // slow runner the old one can still be on screen, scrolled, when the URL has moved).
        // By its title, not any h1: the old page's body can have h1 headings of its own, which
        // satisfied the wait while the old page was still on screen.
        // (A locator, not waitForFunction: the app's CSP refuses string evaluation.)
        const exact = new RegExp(`^${literal(title)}$`);
        await main
          .locator("h1.doc-title", { hasNotText: exact })
          .or(main.getByText("Loading…"))
          .first()
          .waitFor({ timeout: 5000 });
        if ((await page.getByText("Loading…").count()) > 0) {
          throw new Error("a hovered file still showed Loading… when opened");
        }
        if ((await main.evaluate((el) => el.scrollTop)) !== 0) {
          throw new Error("the new page did not start at the top");
        }
        await page.goBack();
        await page.waitForURL(`${lib}/${enc(nested)}`);
        const after = await main.evaluate((el) => el.scrollTop);
        if (Math.abs(after - before) > 2) {
          throw new Error(`back returned to ${after}px, not ${before}px`);
        }
      },
    );
    await step(
      "workspace: a slow page keeps the old one on screen, then says it is loading",
      async () => {
        // TEMPRA-194: a move to a page not in the cache keeps the page on screen (and its scroll)
        // for up to 300 ms while the next one's data arrives; past that the next page draws its
        // loading state, said politely. The address, the tree's row and the bar's path move at
        // the click. The next page's file is held here so the hold is seen to end by the delay.
        // Not the page the step before moved to (the first of the folder's others): one this
        // browser has not opened, so it is not in the cache.
        const siblings = pagePaths.filter(
          (c) => c !== nested && c.split("/").slice(0, -1).join("/") === folder,
        );
        const next = siblings[1] ?? pagePaths.find((c) => c !== nested && c !== siblings[0]);
        if (!next) throw new Error(`no third page in ${folder}/ to move to`);
        await page.locator(".body .prose").waitFor({ timeout: 15_000 });
        await main.evaluate((el) => {
          el.scrollTop = 200;
        });
        const scrolled = await main.evaluate((el) => el.scrollTop);
        const title = await main.locator("h1.doc-title").innerText();
        let release = () => {};
        const held = new Promise<void>((r) => {
          release = r;
        });
        const hold = async (route: Route) => {
          await held;
          await route.continue().catch(() => {});
        };
        const fileApi = `**/api/v1/libraries/${owner}/${slug}/page/${enc(next)}*`;
        await page.route(fileApi, hold);
        try {
          const clicked = Date.now();
          await sidebar.locator(`a[data-path="${next}"]`).click();
          await page.waitForURL(`${lib}/${enc(next)}`);
          // Within the hold: the old page, still scrolled, no Loading…, and the frame already
          // at the new page (its row current, its title last in the bar's path).
          if (Date.now() - clicked < 200) {
            if ((await main.locator("h1.doc-title").innerText()) !== title) {
              throw new Error("the old page left before the hold ended");
            }
            if ((await main.getByText("Loading…").count()) > 0) {
              throw new Error("Loading… showed within the hold");
            }
            if (Math.abs((await main.evaluate((el) => el.scrollTop)) - scrolled) > 2) {
              throw new Error("the old page lost its scroll within the hold");
            }
          }
          if (
            (await sidebar.locator(`a[aria-current="page"][data-path="${next}"]`).count()) !== 1
          ) {
            throw new Error("the tree's row did not follow the click at once");
          }
          const path = sheetBar.getByRole("navigation", { name: "Path" });
          const last = (await path.locator('[aria-current="page"]').innerText()).trim();
          if (last === title.trim()) throw new Error("the bar's path still named the old page");
          await main.getByText("Loading…").waitFor({ timeout: 5000 });
          if (Date.now() - clicked < 250) throw new Error("Loading… showed before the hold ended");
          const said = (await page.locator('.workspace > p[role="status"]').innerText()).trim();
          if (said !== "Loading…") throw new Error(`the live region said ${JSON.stringify(said)}`);
          if ((await main.evaluate((el) => el.scrollTop)) !== 0) {
            throw new Error("the next page did not start at the top");
          }
        } finally {
          release();
          await page.unroute(fileApi, hold);
        }
        await main
          .locator("h1.doc-title", { hasNotText: new RegExp(`^${literal(title)}$`) })
          .waitFor({ timeout: 10_000 });
        if ((await main.getByText("Loading…").count()) > 0) {
          throw new Error("Loading… stayed after the page drew");
        }
        await page.goBack();
        await page.waitForURL(`${lib}/${enc(nested)}`);
        await page.locator(".body .prose").waitFor({ timeout: 15_000 });
      },
    );
    await step(
      "the page's path over it; a folder is not a page, its address reveals it",
      async () => {
        if (!folder) throw new Error("no page in a folder");
        await page.locator(".body .prose").waitFor({ timeout: 15_000 });
        // The top bar names the page's path (TEMPRA-145): its folders as words (folders are not
        // pages, so no links), then its title; the page's own line of folders stays hidden.
        const path = sheetBar.getByRole("navigation", { name: "Path" });
        await path.waitFor({ timeout: 5000 });
        const crumbs = (await path.locator(".crumb").allInnerTexts()).map((t) => t.trim());
        const title = (await main.locator("h1.doc-title").innerText()).trim();
        const want = [
          ...folder.split("/").map((_, i, all) => folderName(all.slice(0, i + 1).join("/"))),
          title,
        ];
        if (JSON.stringify(crumbs) !== JSON.stringify(want)) {
          throw new Error(`the path reads ${JSON.stringify(crumbs)}, not ${JSON.stringify(want)}`);
        }
        if ((await path.getByRole("link").count()) > 0) throw new Error("the path has links");
        if ((await path.locator('[aria-current="page"]').innerText()).trim() !== title) {
          throw new Error("the path's last part is not the page");
        }
        const folders = main.getByRole("navigation", { name: "Folders" });
        if (await folders.isVisible()) throw new Error("the page's folders show beside the tree");
        // A folder's address (an old link, a link to it in a page's body) opens the home, with the
        // folder open in the tree, and the address becomes the home's.
        await page.goto(`${lib}/${enc(folder)}/`);
        await page.waitForURL(`${lib}/`);
        await home();
        const row = sidebar.locator(`button.tree-name[title="${folderName(folder)}"]`);
        if ((await row.first().getAttribute("aria-expanded")) !== "true") {
          throw new Error("a folder's address did not open it in the tree");
        }
        await sidebar.locator(`a[data-path="${nested}"]`).waitFor({ timeout: 10_000 });
        if (shots) await page.screenshot({ path: `${shots}/folder.png` });
        await markStay();
        await sidebar.locator(`a[data-path="${nested}"]`).click();
        await page.waitForURL(`${lib}/${enc(nested)}`);
        await page.locator(".body .prose").waitFor({ timeout: 15_000 });
        if (!(await stayed())) throw new Error("the tree's row reloaded the page");
      },
    );
    await step("workspace: the tree follows an agent's write and move, live", async () => {
      await page.reload();
      await sidebar.locator(".tree a").first().waitFor({ timeout: 15_000 });
      const put = await fetch(`${libApi}/files/gate-live.md`, {
        method: "PUT",
        headers: { ...bearer, "Content-Type": "text/markdown", "X-Note": "gate: tree" },
        body: "---\ntype: Note\ntitle: Gate live\ndescription: Written while the tree was open.\n---\nLive.\n",
      });
      if (!put.ok) throw new Error(`write: ${put.status}`);
      const row = sidebar.locator('a[data-path="gate-live.md"]');
      await row.waitFor({ timeout: 5000 });
      // The tree does not mark change (TEMPRA-173): no dot, live or since the person looked.
      if ((await sidebar.locator(".change-dot").count()) > 0) {
        throw new Error("the tree marks change");
      }
      const target = folder ? `${folder}/gate-live.md` : "moved/gate-live.md";
      const moved = await fetch(`${libApi}/files/gate-live.md/move`, {
        method: "POST",
        headers: { ...bearer, "Content-Type": "application/json" },
        body: JSON.stringify({ to: target, note: "gate: tree move" }),
      });
      if (!moved.ok) throw new Error(`move: ${moved.status}`);
      await row.waitFor({ state: "detached", timeout: 5000 });
      if (folder) await sidebar.locator(`a[data-path="${target}"]`).waitFor({ timeout: 5000 });
      // Not found (take 4, board 32): the old path says where the file moved, with Open, then
      // Home and Search (the quick switcher).
      b.expect404("gate-live.md");
      await page.goto(`${lib}/gate-live.md`);
      await main
        .getByRole("heading", { level: 1, name: "This page isn't here", exact: true })
        .waitFor({ timeout: 15_000 });
      const fate = main.locator(".not-found-fate");
      // Named by its title and folder, not its path (TEMPRA-131).
      await fate
        .filter({ hasText: /Moved to (Gate live|gate-live) \(.+\) by / })
        .waitFor({ timeout: 10_000 });
      const open = await fate.getByRole("link", { name: "Open", exact: true }).getAttribute("href");
      if (open !== `/${owner}/${slug}/${enc(target)}`) throw new Error(`Open: ${open}`);
      await main.getByRole("link", { name: "Home", exact: true }).waitFor();
      if (shots) await page.screenshot({ path: `${shots}/not-found.png` });
      await main.getByRole("button", { name: "Search", exact: true }).click();
      const dialog = page.getByRole("dialog", { name: /^Search / });
      await dialog.waitFor({ timeout: 5000 });
      await page.keyboard.press("Escape");
      await dialog.waitFor({ state: "hidden", timeout: 5000 });
      await agentDeletes(target);
    });
    // What an agent wrote shows in Recently changed and in Activity; nothing counts it for the
    // person (TEMPRA-173): no "since you last looked" line, no tree dot, no Activity divider.
    await step("home: Recently changed, and nothing counted since the last look", async () => {
      const path = folder ? `${folder}/gate-since.md` : "gate-since.md";
      const wrote = await fetch(`${libApi}/files/${enc(path)}`, {
        method: "PUT",
        headers: { ...bearer, "Content-Type": "text/markdown", "X-Note": "gate: since" },
        body: "---\ntype: Note\ntitle: Gate since\ndescription: Written after the last look.\n---\nNew.\n",
      });
      if (!wrote.ok) throw new Error(`write: ${wrote.status}`);
      await page.goto(`${lib}/`);
      await home();
      const recent = main.getByRole("region", { name: "Recently changed" });
      // Each row a ChangeRow, as Activity's are (TEMPRA-288): the avatar, the page, where and who,
      // and when at the right.
      const newest = recent.locator(".change-row").first();
      await newest
        .getByRole("link", { name: "Gate since", exact: true })
        .waitFor({ timeout: 10_000 });
      const meta = await newest.locator(".change-row-meta").innerText();
      const when = await newest.locator(".change-row-when").innerText();
      if (
        !/for @/.test(meta) ||
        when !== "just now" ||
        !(await newest.locator(".avatar-mark").count())
      ) {
        throw new Error(`Recently changed says "${meta}", "${when}"`);
      }
      if ((await main.getByText(/^Since /).count()) > 0) throw new Error("the home counts change");
      if ((await main.getByRole("region", { name: "For you here" }).count()) > 0) {
        throw new Error("the home still has For you here");
      }
      if ((await sidebar.locator(".change-dot").count()) > 0)
        throw new Error("the tree marks change");
      if (shots) await page.screenshot({ path: `${shots}/home-recent.png` });
      await markStay();
      await sidebar
        .getByRole("navigation", { name: "Library" })
        .getByRole("link", { name: /^Activity/ })
        .click();
      await page.waitForURL(`${lib}/-/activity`);
      await main.locator(".activity-day .change-row").first().waitFor({ timeout: 15_000 });
      const above = await main.locator(".activity-day .change-row").first().innerText();
      if (!above.includes("Gate since")) throw new Error(`the newest entry reads "${above}"`);
      if ((await main.getByText("New since you looked").count()) > 0) {
        throw new Error("Activity still marks what is new since the last look");
      }
      // Home is the library's name in the bar (TEMPRA-145).
      await sheetBar.locator(".topbar-brand a.brand-name").click();
      await page.waitForURL(`${lib}/`);
      await home();
      if (!(await stayed())) throw new Error("moving between home and Activity reloaded the page");
      await agentDeletes(path);
    });
    // Any link pointed at loads its page ahead (TEMPRA-193), not only the tree's rows: here a
    // Recently changed row. The page then opens from what the hover loaded, asking nothing again.
    await step("home: a link pointed at loads its page ahead", async () => {
      const path = folder ? `${folder}/gate-ahead.md` : "gate-ahead.md";
      const wrote = await fetch(`${libApi}/files/${enc(path)}`, {
        method: "PUT",
        headers: { ...bearer, "Content-Type": "text/markdown", "X-Note": "gate: ahead" },
        body: "---\ntype: Note\ntitle: Gate ahead\ndescription: Loaded on hover.\n---\nAhead.\n",
      });
      if (!wrote.ok) throw new Error(`write: ${wrote.status}`);
      await page.goto(`${lib}/`);
      await home();
      const row = main
        .getByRole("region", { name: "Recently changed" })
        .getByRole("link", { name: "Gate ahead", exact: true });
      await row.waitFor({ timeout: 10_000 });
      // A file's page is one request (TEMPRA-191): `page/{path}`, never the five it replaced.
      const fileApi = `/api/v1/libraries/${owner}/${slug}/page/${enc(path)}`;
      const asked: string[] = [];
      const split: string[] = [];
      const onRequest = (r: { url(): string }) => {
        const p = new URL(r.url()).pathname;
        if (p === fileApi) asked.push(r.url());
        for (const old of ["files", "sources", "links", "history"]) {
          if (p === `/api/v1/libraries/${owner}/${slug}/${old}/${enc(path)}`) split.push(p);
        }
      };
      page.on("request", onRequest);
      try {
        const loaded = page.waitForResponse((r) => new URL(r.url()).pathname === fileApi, {
          timeout: 5000,
        });
        await row.hover();
        await loaded;
        await page.waitForTimeout(300); // the rest of the page's load lands in the cache
        const before = asked.length;
        await row.click();
        await page.waitForURL(`${lib}/${enc(path)}`);
        await main.locator("h1.doc-title", { hasText: "Gate ahead" }).waitFor({ timeout: 5000 });
        if ((await main.getByText("Loading…").count()) > 0) {
          throw new Error("a page loaded on hover still showed Loading…");
        }
        if (asked.length !== before) throw new Error("the page asked for its file again");
        if (before !== 1) throw new Error(`the hover asked for the file ${before} times`);
        if (split.length > 0) throw new Error(`the page asked ${split.join(", ")}`);
      } finally {
        page.off("request", onRequest);
      }
      // Back home, as the step before left it, before the page goes.
      await page.goBack();
      await page.waitForURL(`${lib}/`);
      await home();
      await agentDeletes(path);
      // The frame's index has caught up (the switcher next offers what the index holds).
      await sidebar
        .locator(`a[data-path="${path}"]`)
        .waitFor({ state: "detached", timeout: 10_000 });
    });
    await step("workspace: the quick switcher opens a page", async () => {
      const first = pagePaths[0] ?? "";
      const meta = (await (
        await fetch(`${libApi}/files/${enc(first)}`, {
          headers: { ...bearer, Accept: "application/json" },
        })
      ).json()) as { frontmatter?: { title?: string } };
      const word = String(meta.frontmatter?.title ?? "").split(/\s+/)[0] ?? "";
      const dialog = page.getByRole("dialog", { name: /^Search / });
      const box = dialog.getByRole("combobox");
      // It closes every way a person tries: Escape, the same keys, a click outside.
      const closes = async (how: string, close: () => Promise<void>) => {
        await page.keyboard.press("Control+k");
        await box.waitFor({ timeout: 5000 }).catch(() => {
          throw new Error(`the switcher did not open (before ${how})`);
        });
        await close();
        await dialog.waitFor({ state: "hidden", timeout: 5000 }).catch(() => {
          throw new Error(`the switcher did not close with ${how}`);
        });
      };
      await closes("Escape", () => box.press("Escape"));
      await closes("the same keys", () => page.keyboard.press("Control+k"));
      await closes("a click outside", () => page.mouse.click(5, 5));
      // Nothing matches: "No results", once search inside pages has answered (F-12).
      await page.keyboard.press("Control+k");
      await box.waitFor({ timeout: 5000 });
      await box.fill("zqxjvw");
      await dialog.locator(".switcher-status", { hasText: /^No results$/ }).waitFor({
        timeout: 10_000,
      });
      if ((await dialog.locator('[role="option"]').count()) > 0) {
        throw new Error("options for a query that matches nothing");
      }
      if (shots) await page.screenshot({ path: `${shots}/search-none.png` });
      await box.press("Escape");
      await dialog.waitFor({ state: "hidden", timeout: 5000 });
      // The round search button over the sidebar opens it too (TEMPRA-145).
      await page
        .locator(".topbar-brand")
        .getByRole("button", { name: "Search", exact: true })
        .click();
      await box.waitFor({ timeout: 5000 });
      await box.fill(word);
      const option = page.locator('.switcher [role="option"]', { hasText: first }).first();
      await option.waitFor({ timeout: 5000 });
      await box.press("ArrowDown");
      await box.press("ArrowUp");
      // The hit for the first page, wherever it ranks.
      await option.click();
      await page.waitForURL(`${lib}/${enc(first)}`);
    });
    await step("workspace: hiding the sidebar is remembered", async () => {
      const show = page.getByRole("button", { name: "Show sidebar" });
      if ((await show.count()) > 0) throw new Error("Show sidebar offered while it shows");
      // Ctrl+\ hides it (take 4 has no button for it).
      await page.keyboard.press("Control+\\");
      await sidebar.waitFor({ state: "hidden", timeout: 5000 });
      await show.waitFor({ timeout: 5000 });
      await page.reload();
      await page.locator(".body .prose").waitFor({ timeout: 15_000 });
      await show.waitFor({ timeout: 5000 });
      if (await sidebar.isVisible()) throw new Error("the hidden sidebar came back on reload");
      // With the tree out of sight, the bar still names the page's path, and the bar over the
      // sidebar the library (TEMPRA-145); the page's own line of folders stays the phone's.
      await sheetBar.getByRole("navigation", { name: "Path" }).waitFor({ timeout: 5000 });
      await page.locator(".topbar-brand a.brand-name").waitFor({ timeout: 5000 });
      if (await main.getByRole("navigation", { name: "Folders" }).isVisible()) {
        throw new Error("the page's folders show above its title beside the bar's path");
      }
      if (shots) await page.screenshot({ path: `${shots}/sidebar-hidden.png` });
      await show.click();
      await sidebar.waitFor({ state: "visible", timeout: 5000 });
      await page.reload();
      await sidebar.getByRole("navigation", { name: "Files" }).waitFor({ timeout: 15_000 });
      if ((await show.count()) > 0) throw new Error("Show sidebar offered after showing it");
    });
    // New library, from the switcher's menu: a compose dialog over the library list, its address
    // following the name; Escape closes it and creates nothing.
    await step("New library: the compose dialog", async () => {
      await page.locator(".topbar-brand").getByRole("button", { name: "Switch library" }).click();
      await page
        .locator(".menu-list.libraries")
        .getByRole("link", { name: "New library", exact: true })
        .click();
      const dialog = page.getByRole("dialog", { name: "New library" });
      await dialog.waitFor({ timeout: 15_000 });
      const name = dialog.getByRole("textbox", { name: "Name", exact: true });
      if (!(await name.evaluate((el) => el === el.ownerDocument.activeElement))) {
        throw new Error("New library: the name field does not have the focus");
      }
      await name.fill("Gate Notes & Plans");
      const address = await dialog.getByRole("textbox", { name: "Address" }).inputValue();
      if (address !== "gate-notes-plans") throw new Error(`New library: address ${address}`);
      await page.keyboard.press("Escape");
      await dialog.waitFor({ state: "hidden", timeout: 5000 });
      await page.goto(lib);
      await main.waitFor();
    });
    // The frame (take 4, TEMPRA-113): the switcher's menu, the library's settings with General
    // (TEMPRA-102), the bell, and the theme, chosen in the avatar's menu and kept on the account.
    await step("the frame: the switcher's menu, General, the bell and the theme", async () => {
      // Over the sidebar, Linear's docs translated (TEMPRA-145): the Tempra mark, the library's
      // name (its home) with ⌄ for the switcher, and search; the sidebar is the tree, then
      // Activity and Settings at its foot; the switcher's menu only switches.
      const brand = page.locator(".topbar-brand");
      const brandIs = async (where: string, name = slug) => {
        await brand.getByRole("link", { name: "Tempra", exact: true }).waitFor({ timeout: 5000 });
        const shown = (await brand.locator("a.brand-name").innerText()).trim();
        if (shown !== name)
          throw new Error(`the bar over the sidebar names "${shown}" on ${where}`);
        await brand.getByRole("button", { name: "Switch library" }).waitFor({ timeout: 5000 });
        await brand.getByRole("button", { name: "Search", exact: true }).waitFor({ timeout: 5000 });
      };
      await brandIs("a library's page");
      if ((await brand.locator('a.brand-name[aria-current="page"]').count()) !== 1) {
        throw new Error("the library's name is not the current page on its home");
      }
      const foot = sidebar.getByRole("navigation", { name: "Library" });
      const rows = (await foot.locator(".nav-row").filter({ visible: true }).allInnerTexts()).map(
        (t) => t.replace(/\s+/g, " ").trim(),
      );
      if (JSON.stringify(rows) !== JSON.stringify(["Activity", "Settings"])) {
        throw new Error(`the sidebar's foot reads ${JSON.stringify(rows)}`);
      }
      // The tree fades out above the foot (TEMPRA-149), with as much room at its end as the fade,
      // so the last row rests clear of it.
      const fade = await page.evaluate<{ mask: string; pad: number }>(`(() => {
        const cs = getComputedStyle(document.querySelector(".ws-sidebar .sidebar-scroll"));
        return { mask: cs.maskImage || cs.webkitMaskImage, pad: parseFloat(cs.paddingBottom) };
      })()`);
      if (!fade.mask.includes("gradient") || fade.pad < 40) {
        throw new Error(`the tree does not fade above the foot: ${JSON.stringify(fade)}`);
      }
      for (const gone of ["Home", "Search"]) {
        if (
          (await sidebar.getByText(gone, { exact: true }).filter({ visible: true }).count()) > 0
        ) {
          throw new Error(`the sidebar still has ${gone}`);
        }
      }
      const switcher = () => brand.getByRole("button", { name: "Switch library" });
      await switcher().click();
      const menu = page.locator(".menu-list.libraries");
      await menu
        .locator('a[aria-current="page"]')
        .filter({ hasText: slug })
        .waitFor({ timeout: 5000 });
      await menu.getByRole("link", { name: "All libraries", exact: true }).waitFor();
      await menu.getByRole("link", { name: "New library", exact: true }).waitFor();
      if ((await menu.getByText(/settings$/).count()) > 0) {
        throw new Error("the switcher's menu still has the library's settings");
      }
      await page.keyboard.press("Escape");
      await foot.getByRole("link", { name: "Settings", exact: true }).click();
      await page.waitForURL(`${lib}/-/settings`);
      await main
        .getByRole("heading", { level: 1, name: "Settings", exact: true })
        .waitFor({ timeout: 15_000 });
      await brandIs("the library's settings");
      // Settings is one page in the library's frame, as Activity is: the tree and the foot stay,
      // Settings the current row, and every section is a heading on the page, the owner's in order.
      await sidebar.locator(".tree").waitFor({ timeout: 5000 });
      await foot
        .locator('a[aria-current="page"]', { hasText: "Settings" })
        .waitFor({ timeout: 5000 });
      if ((await sidebar.getByRole("link", { name: "Back to library", exact: true }).count()) > 0) {
        throw new Error("the Settings page still has a settings sidebar");
      }
      const sectionNames = [
        "General",
        "Members",
        "Connect",
        "Import & export",
        "Recovery",
        "Delete library",
      ];
      await main
        .getByRole("heading", { level: 2, name: "Delete library", exact: true })
        .waitFor({ timeout: 5000 });
      const sectionHeads = await main.locator(".settings-section > h2").allTextContents();
      if (JSON.stringify(sectionHeads) !== JSON.stringify(sectionNames)) {
        throw new Error(`Settings' sections: ${JSON.stringify(sectionHeads)}`);
      }
      if (shots) await page.screenshot({ path: `${shots}/settings.png`, fullPage: true });
      // A title, saved: the switcher and the home show it; cleared again, they show the slug.
      await page.locator("#library-title").fill("The gate's library");
      await page.getByRole("button", { name: "Save", exact: true }).click();
      await page.getByText("Saved.").waitFor({ timeout: 15_000 });
      // Leaving Settings is opening anything else in the library: here its home, by its name.
      await brand.locator("a.brand-name").click();
      await page.waitForURL(`${lib}/`);
      await main
        .getByRole("heading", { level: 1, name: "The gate's library", exact: true })
        .waitFor({ timeout: 15_000 });
      await brand.locator("a.brand-name", { hasText: "The gate's library" }).waitFor({
        timeout: 5000,
      });
      if (shots) await page.screenshot({ path: `${shots}/home-titled.png` });
      await page.goto(`${lib}/-/settings`);
      await page.locator("#library-title").waitFor({ timeout: 15_000 });
      await page.locator("#library-title").fill("");
      await page.getByRole("button", { name: "Save", exact: true }).click();
      await page.getByText("Saved.").waitFor({ timeout: 15_000 });
      await page.goto(`${lib}/`);
      await home();
      // The bell is the notifications: a panel over the page, which leaves the page where it was,
      // with no Inbox page to link to (TEMPRA-189).
      const bellPop = page.locator(".menu-list.bell-pop");
      await page
        .locator("header.ws-topbar")
        .getByRole("button", { name: /^Notifications/ })
        .click();
      await bellPop.getByText("Notifications", { exact: true }).waitFor({ timeout: 5000 });
      if ((await bellPop.locator('a[href^="/inbox"]').count()) > 0) {
        throw new Error("the bell's panel links to an Inbox page");
      }
      if (page.url() !== `${lib}/`) throw new Error(`the bell left the page: ${page.url()}`);
      await page.keyboard.press("Escape");
      await bellPop.waitFor({ state: "detached", timeout: 5000 });
      // The theme: dark until the person chooses (TEMPRA-285), whatever the system says; a
      // choice applied at once and kept on the account across a reload; then the system's, which
      // the rest of the gate needs, since its light and dark passes emulate the system's scheme.
      const account = page.locator(".menu-list.account");
      await page.emulateMedia({ colorScheme: "light" });
      await page.locator('html[data-theme="dark"]').waitFor({ timeout: 5000 });
      if (shots) await page.screenshot({ path: `${shots}/home-dark.png` });
      await page.getByRole("button", { name: "Account menu" }).click();
      await account
        .locator('button[aria-pressed="true"]', { hasText: "Dark" })
        .waitFor({ timeout: 5000 });
      await account.getByRole("button", { name: "Light", exact: true }).click();
      await page.locator('html[data-theme="light"]').waitFor({ timeout: 5000 });
      await page.keyboard.press("Escape");
      await account.waitFor({ state: "detached", timeout: 5000 });
      await page.reload();
      await page.locator('html[data-theme="light"]').waitFor({ timeout: 15_000 });
      await home();
      await page.getByRole("button", { name: "Account menu" }).click();
      await account.getByRole("button", { name: "System", exact: true }).click();
      await page.locator("html:not([data-theme])").waitFor({ timeout: 5000 });
      await page.keyboard.press("Escape");
      await account.waitFor({ state: "detached", timeout: 5000 });
      await page.reload();
      await page.locator("html:not([data-theme])").waitFor({ timeout: 15_000 });
      await home();
      await page.emulateMedia({ colorScheme: null });
    });
    // The phone (take 4, TEMPRA-118, boards 34 and 36): a top bar with Tempra (TEMPRA-140), the
    // sidebar as a drawer over it with Tempra at its head (TEMPRA-141), the home stacked.
    await step(
      "workspace: at phone width the top bar shows Tempra, the sidebar is a drawer",
      async () => {
        const topbar = page.locator("header.ws-topbar");
        const menu = topbar.getByRole("button", { name: "Menu", exact: true });
        if (await menu.isVisible()) throw new Error("the phone's menu button shows on a desktop");
        await page.setViewportSize({ width: 390, height: 844 });
        try {
          await menu.waitFor({ state: "visible", timeout: 5000 });
          if (await sidebar.isVisible()) throw new Error("the sidebar shows at phone width");
          // The top bar on the home: the menu, the mark and the library's name, the bell, the
          // avatar. Search and the switcher are the drawer's head's (TEMPRA-145).
          const libraryName = (await main.locator("h1").first().innerText()).trim();
          await phoneNamed(libraryName);
          if (await topbar.getByRole("button", { name: /^Search/ }).isVisible()) {
            throw new Error("the phone's top bar has a search button");
          }
          for (const control of [
            topbar.getByRole("button", { name: /^Notifications/ }),
            topbar.getByRole("button", { name: "Account menu" }),
          ]) {
            if (!(await control.isVisible()))
              throw new Error("the phone's top bar lacks a control");
          }
          const menuBox = await menu.boundingBox();
          if (!menuBox || menuBox.height < 44 || menuBox.width < 44) {
            throw new Error(`the menu button is no touch target: ${JSON.stringify(menuBox)}`);
          }
          // The drawer: over the top bar, about four fifths of the screen, the page dimmed beside
          // it; it takes the focus.
          await menu.click();
          await sidebar.waitFor({ state: "visible" });
          const drawn = await sidebar.boundingBox();
          if (!drawn || drawn.x > 1 || drawn.y > 1 || drawn.width < 280 || drawn.width > 340) {
            throw new Error(
              `the drawer is not four fifths of the screen: ${JSON.stringify(drawn)}`,
            );
          }
          await page.locator(".ws-scrim").waitFor({ timeout: 2000 });
          const focused = await page.evaluate<boolean>(
            'Boolean(document.querySelector("section.ws-sidebar")?.contains(document.activeElement))',
          );
          if (!focused) throw new Error("the drawer did not take the focus");
          // What it holds (TEMPRA-145): at its head the desktop's bar over the sidebar (the mark,
          // the library's name, its switcher, search) and ×; then the tree; Activity and Settings
          // at its foot.
          await drawerHead(libraryName);
          const views = sidebar.getByRole("navigation", { name: "Library" });
          const searchRow = sidebar
            .locator(".drawer-head")
            .getByRole("button", { name: "Search", exact: true });
          for (const part of [
            sidebar.locator(".tree-row").first(),
            views.getByRole("link", { name: /^Activity/ }),
            views.getByRole("link", { name: "Settings", exact: true }),
          ]) {
            if (!(await part.isVisible())) throw new Error(`the drawer lacks ${part}`);
          }
          const footRows = (await views.locator(".nav-row").allInnerTexts()).map(
            (t) => t.replace(/\s+/g, " ").trim().split(" ")[0],
          );
          // Notifications are the bell's, in no drawer (TEMPRA-189).
          if (JSON.stringify(footRows) !== JSON.stringify(["Activity", "Settings"])) {
            throw new Error(`the drawer's foot reads ${JSON.stringify(footRows)}`);
          }
          if (shots) await page.screenshot({ path: `${shots}/drawer-phone.png` });
          // The switcher, at the drawer's head, opens its menu of libraries there.
          await sidebar.getByRole("button", { name: "Switch library" }).click();
          const libraries = page.locator(".menu-list.libraries");
          await libraries
            .getByRole("link", { name: "All libraries", exact: true })
            .waitFor({ timeout: 5000 });
          await page.keyboard.press("Escape");
          await libraries.waitFor({ state: "hidden", timeout: 5000 });
          if (!(await sidebar.isVisible())) {
            throw new Error("closing the switcher's menu closed the drawer");
          }
          // Escape closes it, and the focus goes back to the menu button.
          await page.keyboard.press("Escape");
          await sidebar.waitFor({ state: "hidden" });
          const back = await page.evaluate<boolean>(
            'document.activeElement?.matches("header.ws-topbar .ws-menu") === true',
          );
          if (!back) {
            throw new Error("the focus did not go back to the menu button");
          }
          // So do × and a tap on the dimmed page beside it.
          await menu.click();
          await sidebar.getByRole("button", { name: "Close menu" }).click();
          await sidebar.waitFor({ state: "hidden" });
          await menu.click();
          await sidebar.waitFor({ state: "visible" });
          await page.mouse.click(Math.round(drawn.x + drawn.width + 20), 400);
          await sidebar.waitFor({ state: "hidden" });
          // Search at the drawer's head opens the quick switcher.
          await menu.click();
          await searchRow.click();
          const dialog = page.getByRole("dialog", { name: /^Search / });
          await dialog.waitFor({ timeout: 5000 });
          await page.keyboard.press("Escape");
          await dialog.waitFor({ state: "hidden", timeout: 5000 });
          await page.keyboard.press("Escape");
          await sidebar.waitFor({ state: "hidden" });
          // A view chosen in the drawer opens, the drawer closes, and the page's heading names it.
          await menu.click();
          await views.getByRole("link", { name: /^Activity/ }).click();
          await page.waitForURL(`${lib}/-/activity`);
          await sidebar.waitFor({ state: "hidden" });
          await phoneNamed("Activity");
          // Home stacks its parts (board 36), with no sections and no sidebar rows of its own:
          // the drawer is the tree, and a folder opens there, in place (TEMPRA-138).
          // Home is the library's name at the drawer's head (TEMPRA-145).
          await menu.click();
          await sidebar.locator(".drawer-head a.brand-name").click();
          await page.waitForURL(`${lib}/`);
          await sidebar.waitFor({ state: "hidden" });
          await phoneNamed(libraryName);
          const parts = main.locator(".home-section");
          await parts.first().waitFor({ timeout: 15_000 });
          if (shots) await page.screenshot({ path: `${shots}/home-phone.png` });
          const wide = await page.locator("html").evaluate((el) => el.scrollWidth > el.clientWidth);
          if (wide) throw new Error("the home scrolls sideways at phone width");
          if ((await main.locator(".nav-row, .tree-row").count()) > 0) {
            throw new Error("the phone home draws the sidebar's rows");
          }
          const boxes = await parts.evaluateAll((els) =>
            els.map((el) => el.getBoundingClientRect()).map((r) => ({ x: r.x, w: r.width })),
          );
          if (boxes.some((r) => Math.abs(r.x - (boxes[0]?.x ?? 0)) > 1 || r.w < 300)) {
            throw new Error(`the home's parts are not stacked: ${JSON.stringify(boxes)}`);
          }
          await menu.click();
          await sidebar.waitFor({ state: "visible" });
          const folderRow = sidebar.locator("button.tree-name").first();
          const was = await folderRow.getAttribute("aria-expanded");
          await folderRow.click();
          if ((await folderRow.getAttribute("aria-expanded")) === was) {
            throw new Error("a folder's row in the drawer did not open or close it");
          }
          if (page.url() !== `${lib}/`) throw new Error(`a folder's row moved to ${page.url()}`);
          await sidebar.waitFor({ state: "visible" });
          await folderRow.click();
          await page.keyboard.press("Escape");
          await sidebar.waitFor({ state: "hidden" });
          // The Settings page's drawer is the library's: the tree, then Activity and Settings,
          // Settings the current row; Activity leaves it.
          await page.goto(`${lib}/-/settings`);
          await phoneNamed("Settings");
          await menu.click();
          await sidebar.waitFor({ state: "visible" });
          const settingsFoot = sidebar.getByRole("navigation", { name: "Library" });
          await settingsFoot
            .locator('a[aria-current="page"]', { hasText: "Settings" })
            .waitFor({ timeout: 5000 });
          await sidebar.locator(".tree").waitFor({ timeout: 5000 });
          await sidebar.getByRole("button", { name: "Close menu" }).waitFor();
          await drawerHead(libraryName);
          if (shots) await page.screenshot({ path: `${shots}/settings-drawer-phone.png` });
          await settingsFoot.getByRole("link", { name: "Activity", exact: true }).click();
          await page.waitForURL(`${lib}/-/activity`);
          await sidebar.waitFor({ state: "hidden" });
          await phoneNamed("Activity");
          // The account's pages: the mark and "Tempra" on the bar and at the drawer's head, with
          // search and no switcher, never the page's own name there. Email settings are one
          // switch on Account, where /notifications lands (TEMPRA-189).
          await page.goto(`${base}/notifications`);
          await page.waitForURL(`${base}/account#email`);
          await main
            .getByRole("heading", { name: "Email", exact: true })
            .waitFor({ timeout: 15_000 });
          if (!(await main.getByLabel("Email me mentions and replies").isChecked())) {
            throw new Error("the email switch is not on by default");
          }
          await menu.click();
          await sidebar.waitFor({ state: "visible" });
          await drawerHead("Tempra", false);
          await page.keyboard.press("Escape");
          await sidebar.waitFor({ state: "hidden" });
          // The library list has no sidebar and no drawer (TEMPRA-189): its bar keeps the mark,
          // Tempra and search, then the bell and the avatar.
          await page.goto(`${base}/`);
          await main.locator("h1").first().waitFor({ timeout: 15_000 });
          if ((await menu.count()) > 0) throw new Error("the library list has a menu button");
          if ((await page.locator("section.ws-sidebar").count()) > 0) {
            throw new Error("the library list has a sidebar");
          }
          await topbar.getByRole("button", { name: "Search", exact: true }).click();
          const found = page.getByRole("dialog", { name: "Search libraries" });
          await found.waitFor({ timeout: 5000 });
          await page.keyboard.press("Escape");
          await found.waitFor({ state: "hidden", timeout: 5000 });
          // New library floats at the screen's bottom right, not in the top bar (TEMPRA-148).
          if (
            (await page
              .locator("header.ws-topbar")
              .getByRole("button", { name: "New library" })
              .filter({ visible: true })
              .count()) > 0
          ) {
            throw new Error("New library is in the phone's top bar");
          }
          const fab = page.locator("button.fab", { hasText: "New library" });
          const fabBox = await fab.boundingBox();
          if (
            !fabBox ||
            fabBox.x + fabBox.width < 390 - 32 ||
            fabBox.y + fabBox.height < 844 - 32
          ) {
            throw new Error(
              `New library does not float at the bottom right: ${JSON.stringify(fabBox)}`,
            );
          }
          if (shots) await page.screenshot({ path: `${shots}/libraries-phone.png` });
          await fab.click();
          const making = page.getByRole("dialog", { name: "New library" });
          await making.waitFor({ timeout: 5000 });
          await page.keyboard.press("Escape");
          await making.waitFor({ state: "hidden", timeout: 5000 });
          // A former tab's URL opens Settings at its section.
          await page.goto(`${lib}/-/members`);
          await page.waitForURL(`${lib}/-/settings#members`);
          await phoneNamed("Settings");
        } finally {
          await page.setViewportSize({ width: 1280, height: 720 });
        }
      },
    );

    // A few pages with tables, code, footnotes and lists, as screenshots for review.
    const shotsOf = [
      pagePaths[0] ?? "",
      ...pagePaths.filter((c) => /orders|transactions|events|metrics\//.test(c)).slice(0, 3),
    ];
    let tooltipShown = false;
    for (const pagePath of pagePaths) {
      await step(`reader on ${pagePath}`, async () => {
        // The first page's data comes in the shell (TEMPRA-175): a full load of a page draws
        // its body without asking the API for the file, its context or the frame's first calls.
        const asked: string[] = [];
        // The frame's libraries by name alone (TEMPRA-190): never the list with every library's
        // summary, which wakes them all.
        const summarised: string[] = [];
        const onRequest = (r: import("playwright-core").Request) => {
          const u = new URL(r.url());
          if (u.origin !== base || !u.pathname.startsWith("/api/")) return;
          asked.push(u.pathname);
          if (u.pathname === "/api/v1/libraries" && u.searchParams.get("summary") !== "false") {
            summarised.push(u.pathname + u.search);
          }
        };
        page.on("request", onRequest);
        await page.goto(`${base}/${owner}/${slug}/${enc(pagePath)}`);
        const body = page.locator(".body .prose");
        await body.waitFor({ timeout: 15_000 });
        page.off("request", onRequest);
        const lib = `/api/v1/libraries/${owner}/${slug}`;
        const booted = [`${lib}/page/${enc(pagePath)}`, `${lib}/outline`, "/api/v1/inbox/count"];
        const refetched = asked.filter((a) => booted.includes(a));
        if (refetched.length > 0) {
          throw new Error(`asked the API for what the shell carries: ${refetched.join(", ")}`);
        }
        if (summarised.length > 0) {
          throw new Error(`woke every library for the frame: ${summarised.join(", ")}`);
        }
        // The page is one call (TEMPRA-191): none of the five it replaced.
        const split = asked.filter(
          (a) =>
            a === `${lib}/stats` ||
            ["files", "sources", "links", "history"].some(
              (r) => a === `${lib}/${r}/${enc(pagePath)}`,
            ),
        );
        if (split.length > 0) throw new Error(`a page's view asked ${split.join(", ")}`);
        // The page's tools are its corner row (TEMPRA-283): nothing of them in the top bar.
        await tool("comments").waitFor();
        if ((await sheetBar.getByRole("button", { name: "More", exact: true }).count()) > 0) {
          throw new Error("⋯ is still in the top bar");
        }
        if ((await main.locator(".page-actions").count()) > 0) throw new Error("the + is back");
        // Read and comment only (TEMPRA-99): nothing in the page edits.
        if ((await page.locator("[contenteditable]").count()) > 0) throw new Error("editable");
        if ((await page.getByRole("button", { name: "Edit", exact: true }).count()) > 0) {
          throw new Error("an Edit control is offered");
        }
        if ((await body.innerText()).trim() === "") throw new Error("empty body");
        // Every block carries its ID, every textblock its place in the text.
        if ((await body.locator("[data-block]").count()) === 0) throw new Error("no block IDs");
        if (shots && shotsOf.includes(pagePath)) {
          const name = pagePath.replace(/\.md$/, "").replaceAll("/", "-");
          // On a desktop the page opens on its contents; a panel only when asked.
          await wide();
          await main.evaluate((el) => {
            el.scrollTop = 0;
          });
          await page.screenshot({ path: `${shots}/reader-${name}.png` });
          await openComments();
          await comments.waitFor({ timeout: 5000 });
          await page.screenshot({ path: `${shots}/reader-${name}-comments.png` });
          await page.getByRole("button", { name: "Close comments" }).click();
          await comments.waitFor({ state: "detached", timeout: 5000 });
          await page.setViewportSize({ width: 390, height: 844 });
          await page.waitForTimeout(200);
          await page.screenshot({ path: `${shots}/reader-${name}-phone.png` });
          // On a phone the comments are a bottom sheet, opened from the page's actions.
          await openComments();
          await comments.waitFor({ timeout: 5000 });
          await page.screenshot({ path: `${shots}/reader-${name}-phone-comments.png` });
          await page.getByRole("button", { name: "Close comments" }).click();
          await comments.waitFor({ state: "detached", timeout: 5000 });
          await usual();
        }
        const ref = page.locator(".body .fnref a").first();
        if (!tooltipShown && (await ref.count()) > 0) {
          await ref.hover();
          await page.locator(".tooltip").first().waitFor({ timeout: 5_000 });
          tooltipShown = true;
          if (shots) await page.screenshot({ path: `${shots}/tooltip.png` });
        }
      });
    }
    if (!tooltipShown) problems.push("no footnote reference showed a tooltip");

    // Diagrams (TEMPRA-98): a mermaid fence drawn by Pele, loaded on demand, within the CSP (a
    // violation is a console error, which fails the gate); a broken one as its source with a
    // notice, and as lint in the write result.
    await step("diagrams: drawn, and a broken one shown as its source", async () => {
      const put = await fetch(`${libApi}/files/gate-diagram.md`, {
        method: "PUT",
        headers: { ...bearer, "Content-Type": "text/markdown", "X-Note": "gate: diagrams" },
        body: [
          "---\ntype: Note\ntitle: Gate diagram\ndescription: A diagram and a broken one.\n---",
          "Before.\n",
          "```mermaid\nflowchart LR\n  A[Agent writes] --> B{Parses?}\n  B -->|yes| C[Drawn]\n  B -->|no| D[Source and lint]\n```\n",
          "```mermaid\nflowchart LR\n  X[Never closed --> Y\n```\n",
          "After.\n",
        ].join("\n"),
      });
      if (!put.ok) throw new Error(`write: ${put.status} ${await put.text()}`);
      const lint =
        ((await put.json()) as { lint?: { code: string; message: string }[] }).lint ?? [];
      const bad = lint.filter((l) => l.code === "diagram_invalid");
      if (bad.length !== 1 || !/line 2, column 4 of the fence/.test(bad[0]?.message ?? "")) {
        throw new Error(`diagram lint: ${JSON.stringify(lint)}`);
      }
      await page.goto(`${base}/${owner}/${slug}/gate-diagram.md`);
      const drawn = page.locator(".body figure.diagram[data-opaque]");
      const svg = drawn.locator(".diagram-svg svg");
      await svg.waitFor({ timeout: 15_000 });
      if (!(await svg.locator("text", { hasText: "Agent writes" }).count())) {
        throw new Error("the diagram's labels are missing");
      }
      const notice = page.locator(".body figure.diagram.failed .diagram-notice");
      await notice.waitFor({ timeout: 10_000 });
      const source = await page.locator(".body figure.diagram.failed pre[data-text]").innerText();
      if (!source.includes("Never closed")) throw new Error(`broken diagram: ${source}`);
      await page.getByText("After.", { exact: true }).waitFor();
      // Its frame's Source shows the fence in place of the drawing, and again draws it.
      const sourceButton = drawn.getByRole("button", { name: "Source", exact: true });
      await sourceButton.click();
      const fence = await drawn.locator("pre.diagram-source").innerText();
      if (!fence.includes("Agent writes")) throw new Error(`diagram source: ${fence}`);
      await sourceButton.click();
      await svg.waitFor({ timeout: 15_000 });
      // At phone width it fits the column: the page does not scroll sideways.
      await page.setViewportSize({ width: 390, height: 844 });
      await page.waitForTimeout(300);
      const wide = await page.locator("html").evaluate((el) => el.scrollWidth > el.clientWidth);
      if (shots) {
        await page.screenshot({ path: `${shots}/diagram-phone.png` });
        await page.emulateMedia({ colorScheme: "dark" });
        await page.screenshot({ path: `${shots}/diagram-phone-dark.png` });
        await page.emulateMedia({ colorScheme: "light" });
      }
      await page.setViewportSize({ width: 1280, height: 720 });
      if (shots) await page.screenshot({ path: `${shots}/diagram.png` });
      if (wide) throw new Error("the diagram makes the page scroll sideways at phone width");
      await agentDeletes("gate-diagram.md");
    });

    // SVG fences (TEMPRA-206): drawn sanitized within the CSP (its style attribute through the
    // CSSOM; a violation fails the gate), with nothing of what it should not run left in the page,
    // named by its alt; its lint in the write result.
    await step("SVG fences: drawn sanitized and named by their alt", async () => {
      const put = await fetch(`${libApi}/files/gate-svg.md`, {
        method: "PUT",
        headers: { ...bearer, "Content-Type": "text/markdown", "X-Note": "gate: svg fence" },
        body: [
          "---\ntype: Note\ntitle: Gate SVG\ndescription: An SVG fence.\n---",
          "Before.\n",
          '```svg alt="A box and a dot" title="Drawn from source"',
          '<svg viewBox="0 0 120 40" onload="window.__svgRan=1"><script>window.__svgRan=1</script><rect x="2" y="2" width="50" height="36" fill="none" stroke="currentColor" style="stroke-width:2"/><circle cx="90" cy="20" r="10" fill="currentColor"/><text x="60" y="38">Gate</text></svg>',
          "```\n",
          "After.\n",
        ].join("\n"),
      });
      if (!put.ok) throw new Error(`write: ${put.status} ${await put.text()}`);
      const lint = ((await put.json()) as { lint?: { code: string }[] }).lint ?? [];
      if (!lint.some((l) => l.code === "svg_unsafe")) {
        throw new Error(`svg lint: ${JSON.stringify(lint)}`);
      }
      await page.goto(`${base}/${owner}/${slug}/gate-svg.md`);
      const figure = page.locator(".body figure.diagram[data-opaque]");
      const svg = figure.locator(".diagram-svg svg");
      await svg.waitFor({ timeout: 15_000 });
      if ((await figure.locator(".diagram-svg").getAttribute("aria-label")) !== "A box and a dot") {
        throw new Error("the SVG is not named by its alt");
      }
      const width = await svg
        .locator("rect")
        .evaluate(
          (el) =>
            el.ownerDocument.defaultView?.getComputedStyle(el).getPropertyValue("stroke-width") ??
            "",
        );
      if (width !== "2px" && width !== "2") throw new Error(`the SVG's style: ${width}`);
      if (await page.locator(".body script").count()) throw new Error("a script reached the page");
      if (await page.evaluate(() => (globalThis as { __svgRan?: number }).__svgRan)) {
        throw new Error("the SVG's script ran");
      }
      const caption = await figure.locator("figcaption").innerText();
      if (!caption.includes("Drawn from source")) throw new Error(`svg caption: ${caption}`);
      if (shots) await page.screenshot({ path: `${shots}/svg-fence.png` });
      await agentDeletes("gate-svg.md");
    });

    // Charts (TEMPRA-207): a Vega-Lite fence drawn by Vega in the page with its data from a CSV in
    // the library, within the CSP (no 'unsafe-eval': Vega runs its interpreter; a violation is a
    // console error, which fails the gate), named by its alt.
    await step("charts: a Vega-Lite fence drawn from a library CSV", async () => {
      const csv = await fetch(`${libApi}/files/gate-chart.csv`, {
        method: "PUT",
        headers: { ...bearer, "Content-Type": "text/csv", "X-Note": "gate: chart data" },
        body: "month,orders\nJan,120\nFeb,95\nMar,140\n",
      });
      if (!csv.ok) throw new Error(`csv: ${csv.status} ${await csv.text()}`);
      const spec = {
        data: { url: "/gate-chart.csv" },
        mark: "bar",
        encoding: {
          x: { field: "month", type: "ordinal", sort: null },
          y: { field: "orders", type: "quantitative" },
        },
      };
      const put = await fetch(`${libApi}/files/gate-chart.md`, {
        method: "PUT",
        headers: { ...bearer, "Content-Type": "text/markdown", "X-Note": "gate: chart" },
        body: [
          "---\ntype: Note\ntitle: Gate chart\ndescription: A chart.\n---",
          "Before.\n",
          '```vega-lite alt="Orders by month" title="Orders"',
          JSON.stringify(spec, null, 2),
          "```\n",
          "After.\n",
        ].join("\n"),
      });
      if (!put.ok) throw new Error(`write: ${put.status} ${await put.text()}`);
      const lint = ((await put.json()) as { lint?: { code: string }[] }).lint ?? [];
      if (lint.some((l) => l.code === "chart_invalid" || l.code === "image_no_alt")) {
        throw new Error(`chart lint: ${JSON.stringify(lint)}`);
      }
      await page.goto(`${base}/${owner}/${slug}/gate-chart.md`);
      const figure = page.locator(".body figure.diagram[data-opaque]");
      const svg = figure.locator(".diagram-svg svg");
      await svg.waitFor({ timeout: 20_000 });
      if (!(await svg.locator("text", { hasText: "Feb" }).count())) {
        throw new Error("the chart's labels are missing");
      }
      if ((await figure.locator(".diagram-svg").getAttribute("aria-label")) !== "Orders by month") {
        throw new Error("the chart is not named by its alt");
      }
      if (shots) await page.screenshot({ path: `${shots}/chart.png` });
      await agentDeletes("gate-chart.md");
      await agentDeletes("gate-chart.csv");
    });

    // Figures (tempra-dev: app/reader, Figures): an image alone in its paragraph is a numbered
    // figure that opens the full-screen view, which steps through the page's figures.
    await step("figures: an image opens the full-screen view, and Escape closes it", async () => {
      for (const [path, shade] of [
        ["gate-figure-1.png", 0x88],
        ["gate-figure-2.png", 0xcc],
      ] as const) {
        const put = await fetch(`${libApi}/files/${path}`, {
          method: "PUT",
          headers: { ...bearer, "Content-Type": "image/png", "X-Note": "gate: a figure" },
          body: greyPng(240, 160, shade),
        });
        if (!put.ok) throw new Error(`upload ${path}: ${put.status} ${await put.text()}`);
      }
      // The second image is replaced once, with what it shows, its credit and its licence, so
      // its page has two versions in File history (TEMPRA-170).
      const facts2 = new URLSearchParams({
        description: "A lighter block, drawn by the gate.",
        credit: "The gate",
        licence: "CC0 1.0",
      });
      const first2 = (await (
        await fetch(`${libApi}/files/gate-figure-2.png`, {
          headers: { ...bearer, Accept: "application/json" },
        })
      ).json()) as { hash: string };
      const replaced = await fetch(`${libApi}/files/gate-figure-2.png?${facts2}`, {
        method: "PUT",
        headers: {
          ...bearer,
          "Content-Type": "image/png",
          "If-Match": `"${first2.hash}"`,
          "X-Note": "gate: a bigger figure",
        },
        body: greyPng(300, 200, 0xcc),
      });
      if (!replaced.ok) throw new Error(`replace: ${replaced.status} ${await replaced.text()}`);
      const put = await fetch(`${libApi}/files/gate-figures.md`, {
        method: "PUT",
        headers: { ...bearer, "Content-Type": "text/markdown", "X-Note": "gate: figures" },
        body: [
          "---\ntype: Note\ntitle: Gate figures\ndescription: Two images, each a figure.\n---",
          "Before.\n",
          '![A grey block](/gate-figure-1.png "The first block")\n',
          "![A lighter block](/gate-figure-2.png)\n",
          "After.\n",
        ].join("\n"),
      });
      if (!put.ok) throw new Error(`write: ${put.status} ${await put.text()}`);
      await page.goto(`${lib}/gate-figures.md`);
      const figures = page.locator(".body figure.figure");
      await figures.nth(1).waitFor({ timeout: 15_000 });
      const caption = await figures.first().locator("figcaption").innerText();
      if (!/^Figure 1\.\s*The first block$/.test(caption.trim())) {
        throw new Error(`caption: ${caption}`);
      }
      await page.getByRole("button", { name: "Enlarge image: A grey block" }).click();
      const view = page.locator("dialog.lightbox");
      await view.waitFor({ state: "visible", timeout: 5000 });
      await view.getByText("fig. 1 of 2", { exact: true }).waitFor({ timeout: 5000 });
      await view.getByRole("button", { name: "Next figure" }).click();
      await view.getByText("fig. 2 of 2", { exact: true }).waitFor({ timeout: 5000 });
      // Its quiet line says what it shows (TEMPRA-170).
      await view
        .locator(".lightbox-facts", { hasText: "A lighter block, drawn by the gate." })
        .waitFor({ timeout: 5000 });
      if (!(await view.getByRole("link", { name: "Download" }).count())) {
        throw new Error("no Download");
      }
      // Open file: the image's attachment page.
      const open = await view.getByRole("link", { name: "Open file" }).getAttribute("href");
      if (open !== `/${owner}/${slug}/gate-figure-2.png`) throw new Error(`Open file: ${open}`);
      if (shots) await page.screenshot({ path: `${shots}/lightbox.png` });
      await page.keyboard.press("Escape");
      await view.waitFor({ state: "hidden", timeout: 5000 });
      // The attachment's page (take 4, board 28): the image on its frame, Download, Copy link,
      // Type, Size, Added and Used in (the page that shows it).
      await page.goto(`${lib}/gate-figure-2.png`);
      const side = main.locator(".attachment-side");
      await side
        .getByRole("heading", { level: 1, name: "gate-figure-2.png", exact: true })
        .waitFor({ timeout: 15_000 });
      await main.locator(".attachment-frame img").waitFor({ timeout: 10_000 });
      const download = await side.getByRole("link", { name: "Download" }).getAttribute("href");
      if (download !== `/${owner}/${slug}/-/download/gate-figure-2.png`) {
        throw new Error(`Download: ${download}`);
      }
      await side.getByRole("button", { name: "Copy link", exact: true }).waitFor();
      const facts = side.locator(".attachment-facts");
      await facts.locator("dd", { hasText: /^PNG image$/ }).waitFor({ timeout: 5000 });
      await facts.locator("div", { has: page.locator("dt", { hasText: "Size" }) }).waitFor();
      // Its size in pixels from the server, read from the image's header (TEMPRA-152).
      const described = (await (
        await fetch(`${libApi}/files/gate-figure-2.png`, {
          headers: { ...bearer, Accept: "application/json" },
        })
      ).json()) as { width?: number; height?: number };
      if (described.width !== 300 || described.height !== 200) {
        throw new Error(`attachment dimensions: ${JSON.stringify(described)}`);
      }
      await facts.locator("dd", { hasText: "300 × 200" }).waitFor({ timeout: 5000 });
      await facts.locator("div", { has: page.locator("dt", { hasText: "Added" }) }).waitFor();
      await facts
        .locator("dd")
        .getByRole("link", { name: "Gate figures", exact: true })
        .waitFor({ timeout: 10_000 });
      // The image's page (TEMPRA-170): what it shows under its name, its source, credit and
      // licence, the figure it appears as, and File history with both versions.
      await side
        .locator(".attachment-description", { hasText: "A lighter block, drawn by the gate." })
        .waitFor({ timeout: 5000 });
      const fact = (label: string) =>
        facts.locator("div", { has: page.locator("dt", { hasText: label }) }).locator("dd");
      await fact("Source").getByText("Uploaded by").waitFor({ timeout: 5000 });
      if ((await fact("Credit").innerText()).trim() !== "The gate") throw new Error("no credit");
      if ((await fact("Licence").innerText()).trim() !== "CC0 1.0") throw new Error("no licence");
      await fact("Used in")
        .getByText(/^Figure 2\. A lighter block$/)
        .waitFor({ timeout: 10_000 });
      const history = main.locator(".attachment-history");
      await history
        .getByRole("heading", { level: 2, name: "File history" })
        .waitFor({ timeout: 10_000 });
      const versions = history.locator("li");
      if ((await versions.count()) !== 2) {
        throw new Error(`File history: ${await versions.count()} versions`);
      }
      if ((await history.getByText("Current", { exact: true }).count()) !== 1) {
        throw new Error("File history: not one current version");
      }
      await versions.first().getByText("Replaced by").waitFor();
      await versions.first().getByText("300 × 200").waitFor();
      await versions.nth(1).getByText("Added by").waitFor();
      await versions.nth(1).getByText("240 × 160").waitFor();
      const old = await versions
        .nth(1)
        .getByRole("link", { name: /^Download/ })
        .getAttribute("href");
      if (!old?.startsWith(`/${owner}/${slug}/-/download/gate-figure-2.png?at=`)) {
        throw new Error(`a version's Download: ${old}`);
      }
      const page2 = await main.innerText();
      if (/claude-code\/|human:|[0-9a-f]{64}/.test(page2)) {
        throw new Error("the image's page shows a raw actor id or a hash");
      }
      if (shots) await page.screenshot({ path: `${shots}/attachment.png`, fullPage: true });
      // A phone: the facts and File history stacked under the image, nothing sideways.
      await page.setViewportSize({ width: 390, height: 844 });
      await history.waitFor();
      const frameBox = await main.locator(".attachment-frame").boundingBox();
      const sideBox = await side.boundingBox();
      if (!frameBox || !sideBox || sideBox.y < frameBox.y + frameBox.height - 1) {
        throw new Error("the image's facts do not stack under it on a phone");
      }
      const sideways = await page.locator("html").evaluate((el) => el.scrollWidth > el.clientWidth);
      if (sideways) throw new Error("the image's page scrolls sideways on a phone");
      if (shots) await page.screenshot({ path: `${shots}/attachment-phone.png`, fullPage: true });
      await usual();
      for (const path of ["gate-figures.md", "gate-figure-1.png", "gate-figure-2.png"]) {
        await agentDeletes(path);
      }
    });

    // Figure markup (TEMPRA-161; tempra-dev: app/media, Figure markup): a wide figure reaches
    // past the text, a group's images sit side by side under one caption, and on a phone they
    // stack; the full-screen view steps through the group's images.
    await step("figure markup: a wide figure and a group, stacked on a phone", async () => {
      const images = [
        ["gate-markup-wide.png", 1400, 500, 0x99],
        ["gate-markup-a.png", 640, 400, 0x88],
        ["gate-markup-b.png", 640, 400, 0xbb],
      ] as const;
      for (const [path, w, h, shade] of images) {
        const put = await fetch(`${libApi}/files/${path}`, {
          method: "PUT",
          headers: { ...bearer, "Content-Type": "image/png", "X-Note": "gate: a figure" },
          body: greyPng(w, h, shade),
        });
        if (!put.ok) throw new Error(`upload ${path}: ${put.status} ${await put.text()}`);
      }
      const put = await fetch(`${libApi}/files/gate-markup.md`, {
        method: "PUT",
        headers: { ...bearer, "Content-Type": "text/markdown", "X-Note": "gate: figure markup" },
        body: [
          "---\ntype: Note\ntitle: Gate figure markup\ndescription: A wide figure and a group.\n---",
          "Before the figures, a paragraph long enough to show the text's measure on the page.\n",
          ':::figure{layout=wide frame}\n![A wide grey band](/gate-markup-wide.png "The wide one")\n:::\n',
          ':::figure[Before and after]\n![A darker block](/gate-markup-a.png "Before")\n![A lighter block](/gate-markup-b.png "After")\n:::\n',
          "After.\n",
        ].join("\n"),
      });
      if (!put.ok) throw new Error(`write: ${put.status} ${await put.text()}`);
      const lint = ((await put.json()) as { lint?: { code: string }[] }).lint ?? [];
      if (lint.some((l) => l.code === "figure_invalid")) throw new Error("figure_invalid lint");
      await wide();
      await page.goto(`${lib}/gate-markup.md`);
      const body = page.locator(".body");
      const wideFig = body.locator("figure.figure-wide");
      const group = body.locator("figure.figure-group");
      await group.locator("img").nth(1).waitFor({ timeout: 15_000 });
      await wideFig.locator("img").waitFor({ timeout: 15_000 });
      const box = async (l: ReturnType<typeof page.locator>) => {
        const b = await l.boundingBox();
        if (!b) throw new Error("not drawn");
        return b;
      };
      const text = await box(body.locator("p[data-text]").first());
      const wideBox = await box(wideFig.locator("img"));
      if (wideBox.width <= text.width + 40) {
        throw new Error(`the wide figure is ${wideBox.width}px, the text ${text.width}px`);
      }
      const caption = (await group.locator(":scope > figcaption").innerText()).trim();
      if (!/^Figures 2 and 3\.\s*Before and after$/.test(caption)) {
        throw new Error(`group caption: ${caption}`);
      }
      const cells = group.locator(".figure-cell");
      const [a, b] = [await box(cells.nth(0)), await box(cells.nth(1))];
      if (Math.abs(a.y - b.y) > 2 || b.x <= a.x + a.width - 1) {
        throw new Error("the group's images are not side by side");
      }
      if (shots) await page.screenshot({ path: `${shots}/figure-markup.png`, fullPage: true });
      // The full-screen view steps through the group's images.
      await page.getByRole("button", { name: "Enlarge image: A darker block" }).click();
      const view = page.locator("dialog.lightbox");
      await view.getByText("fig. 2 of 3", { exact: true }).waitFor({ timeout: 5000 });
      await view.getByRole("button", { name: "Next figure" }).click();
      await view.getByText("fig. 3 of 3", { exact: true }).waitFor({ timeout: 5000 });
      await page.keyboard.press("Escape");
      await view.waitFor({ state: "hidden", timeout: 5000 });
      // A phone: the group stacks.
      await page.setViewportSize({ width: 390, height: 844 });
      for (let i = 0; ; i++) {
        const [x, y] = [await box(cells.nth(0)), await box(cells.nth(1))];
        if (y.y >= x.y + x.height - 1) break;
        if (i > 50) throw new Error("the group's images do not stack on a phone");
        await page.waitForTimeout(100);
      }
      if (shots) {
        await group.scrollIntoViewIfNeeded();
        await page.screenshot({ path: `${shots}/figure-markup-phone.png` });
      }
      await usual();
      for (const [path] of [["gate-markup.md"], ...images]) await agentDeletes(path);
    });

    // External images (TEMPRA-163; tempra-dev: app/media): a hotlinked figure names its site under
    // the caption, and its broken box says it is external. The gate has no internet, so the image
    // is on a host that never resolves (`.invalid`), which is the broken state; `work` lists the
    // page as one external_image item for an agent to bring the image home.
    await step("external images: the site under the caption, the broken box, work", async () => {
      const ext = "https://images.gate.invalid/chart.png";
      const put = await fetch(`${libApi}/files/gate-external.md`, {
        method: "PUT",
        headers: { ...bearer, "Content-Type": "text/markdown", "X-Note": "gate: a hotlink" },
        body: [
          "---\ntype: Note\ntitle: Gate external image\ndescription: A hotlinked figure.\n---",
          `![A chart from elsewhere](${ext} "A remote chart")\n`,
        ].join("\n"),
      });
      if (!put.ok) throw new Error(`write: ${put.status} ${await put.text()}`);
      const lint = ((await put.json()) as { lint?: { code: string }[] }).lint ?? [];
      if (!lint.some((l) => l.code === "image_external")) throw new Error("no image_external lint");
      await page.goto(`${lib}/gate-external.md`);
      const fig = page.locator(".body figure.figure");
      const source = fig.locator("figcaption .figure-source");
      await source.waitFor({ timeout: 15_000 });
      const from = (await source.innerText()).trim();
      if (from !== "From images.gate.invalid") throw new Error(`the source line: ${from}`);
      const broken = fig.locator(".figure-broken");
      await broken.waitFor({ timeout: 15_000 });
      const said = await broken.innerText();
      if (!said.includes("An external image from images.gate.invalid")) {
        throw new Error(`the broken box: ${said}`);
      }
      if (shots) await page.screenshot({ path: `${shots}/figure-external.png` });
      const work = (await (
        await fetch(`${libApi}/work?kind=external_image`, { headers: bearer })
      ).json()) as { items: { path: string; detail: string }[] };
      const item = work.items.find((i) => i.path === "gate-external.md");
      if (!item?.detail.includes(ext)) throw new Error("work does not list the hotlinked image");
      await agentDeletes("gate-external.md");
    });

    // Other media (TEMPRA-164; tempra-dev: app/media, How people see): a short WebM plays in the
    // reader (the shell's media-src, the media route's ranges) and in the full-screen view; a PDF
    // is a card whose Open goes to its page; the video's own page plays it in place.
    await step("media: a WebM plays, a PDF's card opens its page", async () => {
      const files = [
        ["gate-clip.webm", "video/webm", readFileSync(join(WORKER_DIR, "test/media/clip.webm"))],
        [
          "gate-paper.pdf",
          "application/pdf",
          new TextEncoder().encode("%PDF-1.4\n1 0 obj << /Type /Catalog >> endobj\n%%EOF\n"),
        ],
      ] as const;
      for (const [path, type, body] of files) {
        const put = await fetch(`${libApi}/files/${path}`, {
          method: "PUT",
          headers: { ...bearer, "Content-Type": type, "X-Note": "gate: media" },
          body: new Uint8Array(body),
        });
        if (!put.ok) throw new Error(`upload ${path}: ${put.status} ${await put.text()}`);
      }
      const put = await fetch(`${libApi}/files/gate-media.md`, {
        method: "PUT",
        headers: { ...bearer, "Content-Type": "text/markdown", "X-Note": "gate: media" },
        body: [
          "---\ntype: Note\ntitle: Gate media\ndescription: A video and a PDF.\n---",
          '![A short test pattern](/gate-clip.webm "A test clip")\n',
          '![A one-page paper](/gate-paper.pdf "The paper")\n',
        ].join("\n"),
      });
      if (!put.ok) throw new Error(`write: ${put.status} ${await put.text()}`);
      await page.goto(`${lib}/gate-media.md`);
      const video = page.locator(".body video");
      await video.waitFor({ timeout: 15_000 });
      /** The part of an HTMLVideoElement the gate plays (no DOM types in the Worker's scripts). */
      type Video = {
        muted: boolean;
        play(): Promise<void>;
        pause(): void;
        currentTime: number;
        videoWidth: number;
        error: { code: number } | null;
      };
      const plays = (el: unknown) =>
        new Promise<{ t: number; w: number; error: number | null }>((done) => {
          const v = el as Video;
          v.muted = true;
          const after = () => {
            v.pause();
            done({ t: v.currentTime, w: v.videoWidth, error: v.error?.code ?? null });
          };
          v.play().then(
            () => setTimeout(after, 500),
            () => done({ t: 0, w: v.videoWidth, error: v.error?.code ?? -1 }),
          );
        });
      const played = await video.evaluate(plays);
      if (!(played.t > 0) || played.w !== 64) {
        throw new Error(`the video did not play: ${JSON.stringify(played)}`);
      }
      // Seeking asks for ranges, which the media route answers.
      const src = (await video.getAttribute("src")) ?? "";
      const ranged = await page.evaluate(async (u) => {
        const r = await fetch(u, { headers: { Range: "bytes=0-9" } });
        return { status: r.status, range: r.headers.get("Content-Range") };
      }, src);
      if (ranged.status !== 206 || !ranged.range?.startsWith("bytes 0-9/")) {
        throw new Error(`a range of the video: ${JSON.stringify(ranged)}`);
      }
      const captions = await page.locator(".body figcaption").allInnerTexts();
      if (
        captions.map((c) => c.trim()).join(" | ") !== "Figure 1. A test clip | Figure 2. The paper"
      ) {
        throw new Error(`captions: ${captions.join(" | ")}`);
      }
      const card = page.locator(".body .figure-pdf");
      const about = (await card.innerText()).replace(/\s+/g, " ");
      if (!about.includes("gate-paper.pdf") || !about.includes("PDF document")) {
        throw new Error(`the PDF's card: ${about}`);
      }
      if ((await page.locator(".body iframe, .body embed, .body object").count()) > 0) {
        throw new Error("a PDF is embedded");
      }
      if (shots) await page.screenshot({ path: `${shots}/media.png`, fullPage: true });
      // The full-screen view plays it.
      await page.getByRole("button", { name: "Enlarge video: A short test pattern" }).click();
      const view = page.locator("dialog.lightbox");
      await view.getByText("fig. 1 of 2", { exact: true }).waitFor({ timeout: 5000 });
      const big = await view.locator("video").evaluate(plays);
      if (!(big.t > 0))
        throw new Error(`the full-screen view did not play: ${JSON.stringify(big)}`);
      await page.keyboard.press("Escape");
      await view.waitFor({ state: "hidden", timeout: 5000 });
      // A phone: the video and the card fit the screen.
      await page.setViewportSize({ width: 390, height: 844 });
      await page.waitForTimeout(200);
      const sideways = await page.locator("html").evaluate((el) => el.scrollWidth > el.clientWidth);
      if (sideways) throw new Error("the media page scrolls sideways on a phone");
      if (shots) await page.screenshot({ path: `${shots}/media-phone.png`, fullPage: true });
      await usual();
      // Open on the card: the PDF's page.
      await card.getByRole("link", { name: "Open", exact: true }).click();
      await page
        .getByRole("heading", { level: 1, name: "gate-paper.pdf", exact: true })
        .waitFor({ timeout: 15_000 });
      // The video's page plays it in place.
      await page.goto(`${lib}/gate-clip.webm`);
      const inPlace = page.locator(".attachment-frame video");
      await inPlace.waitFor({ timeout: 15_000 });
      const there = await inPlace.evaluate(plays);
      if (!(there.t > 0))
        throw new Error(`the video's page did not play: ${JSON.stringify(there)}`);
      if (shots) await page.screenshot({ path: `${shots}/media-attachment.png` });
      for (const path of ["gate-media.md", "gate-clip.webm", "gate-paper.pdf"]) {
        await agentDeletes(path);
      }
    });

    // Reader images (TEMPRA-162; tempra-dev: app/media, How people see): every image from the
    // image route by hash, its box reserved from the stored size, so nothing moves as images
    // load; a phone gets a scaled copy (cf dev's Images stand-in scales locally), far smaller
    // than the original; the attachment page knows the size before the image draws. The page
    // stays until after the busy minute, so that covers a page of figures.
    const imagesPage = "gate-images.md";
    /** What the gate reads of an img in the page (the scripts have no DOM types). */
    type ImgLike = {
      complete: boolean;
      naturalWidth: number;
      currentSrc: string;
      getAttribute(name: string): string | null;
      getBoundingClientRect(): { top: number; height: number };
    };
    const imagePaths = ["gate-image-big.png", "gate-image-small.png"];
    await step(
      "reader images: right-sized, from the image route, with no layout shift",
      async () => {
        const bytes = busyPng(1600, 1000);
        for (const [path, body] of [
          [imagePaths[0], bytes],
          [imagePaths[1], greyPng(300, 200, 0xaa)],
        ] as const) {
          const put = await fetch(`${libApi}/files/${path}`, {
            method: "PUT",
            headers: { ...bearer, "Content-Type": "image/png", "X-Note": "gate: an image" },
            body,
          });
          if (!put.ok) throw new Error(`upload ${path}: ${put.status} ${await put.text()}`);
        }
        const put = await fetch(`${libApi}/files/${imagesPage}`, {
          method: "PUT",
          headers: { ...bearer, "Content-Type": "text/markdown", "X-Note": "gate: images" },
          body: [
            "---\ntype: Note\ntitle: Gate images\ndescription: A page of figures.\n---",
            "Before the figures.\n",
            `![A busy screenshot](/${imagePaths[0]} "A big one")\n`,
            "Between the figures.\n",
            `![A small block](/${imagePaths[1]} "A small one")\n`,
            `:::figure{layout=wide}\n![The busy one again](/${imagePaths[0]})\n:::\n`,
            "After the figures, the paragraph whose place must not move.\n",
          ].join("\n"),
        });
        if (!put.ok) throw new Error(`write: ${put.status} ${await put.text()}`);
        const hash = new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
        // Images held back until the text is measured, so the measure is before they load.
        let release = () => {};
        const held = new Promise<void>((r) => {
          release = r;
        });
        // Released and unrouted together, so a held request can find its route already handled
        // once it goes on; that is the release working, not a failure.
        const hold = async (route: Route) => {
          await held;
          await route.continue().catch(() => {});
        };
        await page.route("**/-/image/**", hold);
        await wide();
        await page.goto(`${lib}/${imagesPage}`, { waitUntil: "domcontentloaded" });
        const after = page.locator(".body p[data-text]", { hasText: "After the figures" });
        await after.waitFor({ timeout: 15_000 });
        /** The paragraph's place in the body (the page scrolls inside main, so not the window). */
        const top = () =>
          after.evaluate((el) => {
            const body = el.closest(".body");
            return Math.round(
              el.getBoundingClientRect().top - (body?.getBoundingClientRect().top ?? 0),
            );
          });
        const imgs = page.locator(".body img");
        const allIn = () =>
          imgs.evaluateAll((els) =>
            els.every((el) => {
              const i = el as unknown as ImgLike;
              return i.complete && i.naturalWidth > 0;
            }),
          );
        const until = async (what: string, ok: () => Promise<boolean>) => {
          for (let i = 0; !(await ok()); i++) {
            if (i > 200) throw new Error(`timed out: ${what}`);
            await page.waitForTimeout(100);
          }
        };
        const first = await imgs.first().evaluate((el) => {
          const img = el as unknown as ImgLike;
          const style = (
            globalThis as unknown as {
              getComputedStyle(e: unknown): { backgroundColor: string };
            }
          ).getComputedStyle(el);
          return {
            src: img.getAttribute("src"),
            width: img.getAttribute("width"),
            height: img.getAttribute("height"),
            srcset: img.getAttribute("srcset"),
            complete: img.complete && img.naturalWidth > 0,
            box: img.getBoundingClientRect().height,
            background: style.backgroundColor,
          };
        });
        if (first.src !== `/${owner}/${slug}/-/image/${hash}`) throw new Error(`src: ${first.src}`);
        if (first.width !== "1600" || first.height !== "1000") {
          throw new Error(`dimensions: ${first.width} × ${first.height}`);
        }
        if (!first.srcset?.includes("?w=640 640w") || first.srcset.includes("1920w")) {
          throw new Error(`srcset: ${first.srcset}`);
        }
        if (first.complete || first.box < 100) {
          throw new Error(`no box reserved before the image loads: ${JSON.stringify(first)}`);
        }
        if (/rgba\(0, 0, 0, 0\)|transparent/.test(first.background)) {
          throw new Error("no grey box while the image loads");
        }
        const before = await top();
        if (shots) await page.screenshot({ path: `${shots}/images-loading.png` });
        release();
        await page.unroute("**/-/image/**", hold);
        // Every image in, the lazy ones too.
        await main.evaluate((el) => {
          el.scrollTop = el.scrollHeight;
        });
        await until("every image loaded", allIn);
        const later = await top();
        if (Math.abs(later - before) > 1) {
          throw new Error(`the text moved ${later - before}px as the images loaded`);
        }
        if (shots) {
          await main.evaluate((el) => {
            el.scrollTop = 0;
          });
          await page.screenshot({ path: `${shots}/images-loaded.png`, fullPage: true });
        }
        // On a phone: a scaled copy, well under 200 KB, where the original is about a megabyte.
        await page.setViewportSize({ width: 390, height: 844 });
        await page.reload();
        const big = page.locator(".body img").first();
        await big.waitFor({ timeout: 15_000 });
        await until("the phone's image loaded", () =>
          big.evaluate((el) => {
            const i = el as unknown as ImgLike;
            return i.complete && i.naturalWidth > 0;
          }),
        );
        const phone = await big.evaluate(async (el) => {
          const url = (el as unknown as ImgLike).currentSrc;
          const r = await fetch(url);
          return {
            url,
            type: r.headers.get("Content-Type"),
            bytes: (await r.arrayBuffer()).byteLength,
          };
        });
        const original = await page.evaluate(async (url) => {
          const r = await fetch(url);
          return (await r.arrayBuffer()).byteLength;
        }, `/${owner}/${slug}/-/image/${hash}`);
        console.log(
          `  reader images: the original ${Math.round(original / 1024)} KB; at phone width ${new URL(phone.url).search || "(original)"} as ${phone.type}, ${Math.round(phone.bytes / 1024)} KB (${Math.round((100 * (original - phone.bytes)) / original)}% saved)`,
        );
        if (!phone.url.includes("?w="))
          throw new Error(`the phone loads the original: ${phone.url}`);
        if (phone.bytes >= 200 * 1024) {
          throw new Error(`the phone's image is ${Math.round(phone.bytes / 1024)} KB`);
        }
        // The attachment page: its size before the image draws, its box reserved.
        await usual();
        let releaseFile = () => {};
        const heldFile = new Promise<void>((r) => {
          releaseFile = r;
        });
        const holdFile = async (route: Route) => {
          await heldFile;
          await route.continue().catch(() => {});
        };
        await page.route("**/-/image/**", holdFile);
        await page.goto(`${lib}/${imagePaths[0]}`, { waitUntil: "domcontentloaded" });
        const facts = main.locator(".attachment-facts");
        await facts.locator("dd", { hasText: "1600 × 1000" }).waitFor({ timeout: 15_000 });
        const pending = await main.locator(".attachment-frame img").evaluate((el) => {
          const img = el as unknown as ImgLike;
          return {
            loaded: img.complete && img.naturalWidth > 0,
            height: img.getBoundingClientRect().height,
          };
        });
        if (pending.loaded || pending.height < 100) {
          throw new Error(`the attachment page's image: ${JSON.stringify(pending)}`);
        }
        const download = await main
          .locator(".attachment-side")
          .getByRole("link", { name: "Download" })
          .getAttribute("href");
        if (download !== `/${owner}/${slug}/-/download/${imagePaths[0]}`) {
          throw new Error(`Download: ${download}`);
        }
        releaseFile();
        await page.unroute("**/-/image/**", holdFile);
      },
    );

    // Verify a page as a person, let an agent change it, and see the change over the text.
    const pagePath = pagePaths[0] ?? "";
    const url = `${base}/${owner}/${slug}/${enc(pagePath)}`;
    const api = `${base}/api/v1/libraries/${owner}/${slug}/files/${enc(pagePath)}`;
    const auth = { Authorization: `Bearer ${token}` };
    /** An agent appends a sentence (which also lapses any human verification). */
    const agentAppends = async (sentence: string, note = "gate: an agent edits") => {
      const now = await fetch(api, { headers: auth });
      const md = await now.text();
      const put = await fetch(api, {
        method: "PUT",
        headers: {
          ...auth,
          "Content-Type": "text/markdown",
          "If-Match": now.headers.get("ETag") ?? "",
          "X-Note": note,
        },
        body: `${md.trimEnd()}\n\n${sentence}\n`,
      });
      if (!put.ok) throw new Error(`edit: ${put.status} ${await put.text()}`);
    };
    function markStay() {
      return page.evaluate(() => {
        (globalThis as unknown as { stayed: boolean }).stayed = true;
      });
    }
    function stayed() {
      return page.evaluate(() => (globalThis as unknown as { stayed?: boolean }).stayed === true);
    }

    // The change feed (TEMPRA-12): an agent's write reaches an open page without a reload.
    await step("an agent's write appears on the open page", async () => {
      await page.goto(url);
      await page.locator(".body .prose").waitFor({ timeout: 15_000 });
      await page.waitForTimeout(500); // the feed's socket opens after the page's data
      await markStay();
      const started = Date.now();
      await agentAppends("A sentence written while the page was open.");
      // A newer version shows as the agent dot on Page info (TEMPRA-283).
      await newVersion().waitFor({ timeout: 10_000 });
      const ms = Date.now() - started;
      console.log(`  (the change reached the page in ${ms} ms)`);
      if (ms > 3000) throw new Error(`the new-version dot took ${ms} ms`);
      if (shots) await page.screenshot({ path: `${shots}/live.png` });
      // The open file prefetched again (a hover on its own row) must not hide the new version.
      await page.locator(`.ws-sidebar a[data-path="${pagePath}"]`).hover();
      await page.waitForTimeout(500);
      await newVersion().waitFor({ timeout: 5000 });
      await openInfo();
      await infoPanel
        .locator(".page-info-newer")
        .getByText(/^A newer version/)
        .waitFor();
      // Said once to a screen reader too, in the page's polite live region (C-27).
      await main
        .getByRole("status")
        .filter({ hasText: /^New version: .*changed this/ })
        .waitFor();
      await infoPanel.getByRole("button", { name: "Show it" }).click();
      await page
        .locator(".body")
        .getByText("A sentence written while the page was open.")
        .waitFor();
      await newVersion().waitFor({ state: "detached", timeout: 5000 });
      await page.keyboard.press("Escape");
      await infoPanel.waitFor({ state: "detached", timeout: 5000 });
      if (!(await stayed())) throw new Error("the page reloaded");
    });

    await step(
      "checking a page: Mark as checked, an agent's edit, the changes since, review mode",
      async () => {
        // From here on, a desktop with room for a panel beside the text (at 1280px the contents give way to it).
        await wide();
        await agentAppends("A sentence before the check.");
        await page.goto(url);
        // A page nobody checked says nothing about it (TEMPRA-122): no line under the byline,
        // and Page info's check line offers only Mark as checked (TEMPRA-283).
        await byline.waitFor({ timeout: 15_000 });
        if ((await byline.getByText(/verif|review|check/i).count()) > 0) {
          throw new Error("the byline shows verification");
        }
        if ((await checkedLine.count()) > 0) throw new Error("a never-checked page says checked");
        await openInfo();
        const mark = check().getByRole("button", { name: "Mark as checked" });
        await mark.waitFor({ timeout: 10_000 });
        const said = (await check().innerText()).replace(/\s+/g, " ").trim();
        if (
          (await check().getByRole("link").count()) > 0 ||
          !/^Nobody has checked this page ?Mark as checked$/.test(said)
        ) {
          throw new Error(`a never-checked page's check line says: ${said}`);
        }
        if ((await infoPanel.getByText(/verif/i).count()) > 0) {
          throw new Error("Page info says verify");
        }
        // Checked from Page info (the floating + is retired, TEMPRA-283).
        await mark.click();
        await page.waitForURL(`${url}?done=verify`, { timeout: 10_000 });
        await page
          .getByText("Checked. It stays checked until the next edit.")
          .waitFor({ timeout: 10_000 });
        // Checked: the line under the byline, and Page info says who, with nothing to do.
        await checkedLine.getByText(/^Checked by you, /).waitFor({ timeout: 10_000 });
        if ((await checkedLine.getByText("changed since").count()) > 0) {
          throw new Error("a page checked just now says changed since");
        }
        await openInfo();
        await infoPanel.getByText("Linked from").waitFor({ timeout: 10_000 });
        await check()
          .getByText(/^Checked by you, /)
          .waitFor({ timeout: 10_000 });
        if ((await check().getByRole("button", { name: "Mark as checked" }).count()) > 0) {
          throw new Error("a checked page still offers Mark as checked");
        }
        await page.keyboard.press("Escape");
        await infoPanel.waitFor({ state: "detached", timeout: 5000 });
        // An agent edits it: "· changed since", which opens review mode; Page info offers the
        // same, how many changes with Show changes.
        await agentAppends("A sentence the gate added.");
        await page.goto(url);
        await openInfo();
        const showChanges = check().getByRole("link", { name: "Show changes" });
        await showChanges.waitFor({ timeout: 10_000 });
        if (!(await check().innerText()).includes("1 change since you checked")) {
          throw new Error(`Page info's check says ${await check().innerText()}`);
        }
        await page.keyboard.press("Escape");
        await infoPanel.waitFor({ state: "detached", timeout: 5000 });
        await checkedLine.getByRole("link", { name: "changed since" }).click();
        await page.waitForURL(`${url}?review=1`);
        const bar = page.getByRole("region", { name: "Review" });
        await bar.getByText(/^Changes since you checked on /).waitFor({ timeout: 10_000 });
        // The changes since the person checked, drawn in the text.
        const added = page.locator(".body ins.diff-added").last();
        await added.waitFor({ timeout: 10_000 });
        if (!(await added.innerText()).includes("A sentence the gate added.")) {
          throw new Error(`added: ${await added.innerText()}`);
        }
        if (shots) await page.screenshot({ path: `${shots}/changes.png`, fullPage: true });
        // Page info says how much changed, with no second way out (Done is the bar's).
        await openInfo();
        await check()
          .getByText(/^1 change since you checked$/)
          .waitFor({ timeout: 10_000 });
        if ((await check().getByRole("link").count()) > 0) {
          throw new Error("Page info offers a second way out of review mode");
        }
        if ((await page.getByRole("button", { name: "Mark as checked" }).count()) !== 1) {
          throw new Error("Mark as checked is offered twice in review mode");
        }
        if (shots) await page.screenshot({ path: `${shots}/review.png` });
        // Each changed block has the rule beside it.
        // (A script string: this file has no DOM types.)
        const rule = await page.evaluate<string>(`(() => {
          const added = [...document.querySelectorAll(".body ins.diff-added")].pop();
          return getComputedStyle(added.closest(".prose > *")).borderLeftWidth;
        })()`);
        if (rule !== "1px") throw new Error(`no rule beside the changed block: ${rule}`);
        // Done, the one way out, leaves review mode: the plain text again.
        if ((await page.getByRole("link", { name: "Hide changes" }).count()) > 0) {
          throw new Error("review mode has two exits");
        }
        await bar.getByRole("link", { name: "Done" }).click();
        await page.waitForURL(url);
        await bar.waitFor({ state: "detached", timeout: 5000 });
        if ((await page.locator(".body ins.diff-added").count()) > 0) {
          throw new Error("the changes are still drawn after Done");
        }
        if ((await infoPanel.count()) > 0) {
          await page.getByRole("button", { name: "Close page info" }).click();
        }
        await infoPanel.waitFor({ state: "detached", timeout: 5000 });
      },
    );
    // An agent edited a page the person checked: the page says so ("changed since"), and
    // nothing reaches their notifications (TEMPRA-173).
    await step(
      "Notifications: an edit to a page the person checked tells them nothing",
      async () => {
        const reviewHref = `/${owner}/${slug}/${enc(pagePath)}?review=1`;
        await page.goto(`${base}/`);
        await main.locator("h1").first().waitFor({ timeout: 15_000 });
        // An account page's bar over the sidebar, as the drawer's head has it: the mark and
        // "Tempra", search, no switcher (TEMPRA-145).
        const accountBrand = page.locator(".topbar-brand");
        if ((await accountBrand.locator("a.brand-name").innerText()).trim() !== "Tempra") {
          throw new Error("an account page's bar does not read Tempra");
        }
        await accountBrand.getByRole("button", { name: "Search", exact: true }).waitFor();
        if ((await accountBrand.getByRole("button", { name: "Switch library" }).count()) > 0) {
          throw new Error("an account page's bar has a library switcher");
        }
        await page
          .locator("header.ws-topbar")
          .getByRole("button", { name: /^Notifications/ })
          .click();
        const pop = page.locator(".menu-list.bell-pop");
        await pop.getByText("Notifications", { exact: true }).waitFor({ timeout: 5000 });
        await pop.locator(".bell-item, .bell-empty").first().waitFor({ timeout: 10_000 });
        if ((await pop.locator(`a[href="${reviewHref}"]`).count()) > 0) {
          throw new Error("the bell lists a page to check");
        }
        if ((await pop.getByText("To check").count()) > 0)
          throw new Error("the bell says To check");
        await page.keyboard.press("Escape");
        await pop.waitFor({ state: "detached", timeout: 5000 });
        // Checking from review mode's bar, with a note, clears "changed since" (TEMPRA-122).
        await page.goto(`${url}?review=1`);
        const bar = page.getByRole("region", { name: "Review" });
        await bar.getByLabel("Note").fill("Gate: read it through.");
        await bar.getByRole("button", { name: "Mark as checked" }).click();
        await page.waitForURL(`${url}?done=verify`, { timeout: 10_000 });
        await checkedLine.getByText(/^Checked by you, /).waitFor({ timeout: 10_000 });
        await checkedLine
          .getByText("changed since")
          .waitFor({ state: "detached", timeout: 10_000 })
          .catch(() => {
            throw new Error("checking did not clear changed since");
          });
        await page.goto(url);
        await byline.waitFor({ timeout: 15_000 });
      },
    );
    await step(
      "Page info's versions: a version's changes in the text, and back to the latest",
      async () => {
        await page.locator(".body .prose").waitFor({ timeout: 15_000 });
        await openInfo();
        // A version opens as it was, with what it changed from the one before (TEMPRA-128, C-1):
        // an earlier one at ?at=<it>&since=<the one before>, the latest at ?since=<the one before>.
        const changed = historyPanel.locator('a.version[href*="since="]');
        await changed.first().waitFor({ timeout: 10_000 });
        if ((await historyPanel.getByText(/verif/i).count()) > 0) {
          throw new Error("Page info's versions show verification");
        }
        if (shots) await page.screenshot({ path: `${shots}/history.png` });
        const older = historyPanel.locator('a.version[href*="at="][href*="since="]');
        const pick = (await older.count()) > 0 ? older.first() : changed.first();
        const label = (await pick.locator(".version-n").textContent())?.trim() ?? "";
        const href = (await pick.getAttribute("href")) ?? "";
        const asked = new URL(href, base).searchParams;
        await pick.click();
        await page.waitForURL((u) => u.search.includes(`since=${asked.get("since")}`));
        // The slim bar names the version on screen, the one chosen; History stays open on it.
        const bar = page.getByRole("region", { name: "Changes" });
        await bar
          .locator(".review-lead")
          .filter({ hasText: new RegExp(`^Changes in ${label}$`) })
          .waitFor({ timeout: 15_000 });
        await page
          .locator(".body ins.diff-added, .body del.diff-removed")
          .first()
          .waitFor({ timeout: 10_000 });
        await historyPanel
          .locator('a.version[aria-current="true"] .version-n')
          .filter({ hasText: label })
          .waitFor({ timeout: 10_000 });
        // No sequence numbers for people on the way (the old "Viewing as of sequence …").
        if ((await page.getByText(/as of sequence/).count()) > 0) {
          throw new Error("a version shows its sequence number");
        }
        if (shots) await page.screenshot({ path: `${shots}/version.png` });
        // An earlier version: "v3 as it was" shows it alone, its byline its own (never "editing
        // now"), History marking it, and "Changes in v3" draws them again (TEMPRA-134, C-14).
        if (asked.has("at")) {
          await bar.getByRole("link", { name: `${label} as it was` }).click();
          await page.waitForURL((u) => u.searchParams.has("at") && !u.searchParams.has("since"));
          const alone = page.getByRole("region", { name: "Version" });
          await alone
            .locator(".review-lead")
            .filter({ hasText: new RegExp(`^${label} as it was$`) })
            .waitFor({ timeout: 15_000 });
          if ((await page.locator(".body ins.diff-added, .body del.diff-removed").count()) > 0) {
            throw new Error("a version as it was draws changes");
          }
          if ((await byline.getByText(/editing now/).count()) > 0) {
            throw new Error("an earlier version's byline says editing now");
          }
          await historyPanel
            .locator('a.version[aria-current="true"] .version-n')
            .filter({ hasText: label })
            .waitFor({ timeout: 10_000 });
          await alone.getByRole("link", { name: `Changes in ${label}` }).click();
          await page.waitForURL((u) => u.search.includes(`since=${asked.get("since")}`));
          await bar.waitFor({ timeout: 15_000 });
        }
        await bar.getByRole("link", { name: "Back to latest" }).click();
        await page.waitForURL(url);
        await bar.waitFor({ state: "detached", timeout: 5000 });
        if ((await historyPanel.count()) > 0) {
          await page.getByRole("button", { name: "Close page info" }).click();
        }
        await historyPanel.waitFor({ state: "detached", timeout: 5000 });
      },
    );
    await step("an internal link's tooltip", async () => {
      await page.goto(url);
      await page.locator(".body .prose").waitFor({ timeout: 15_000 });
      const link = page.locator(".body a.internal:not(.broken)").first();
      if ((await link.count()) === 0) return;
      await link.hover();
      await page.locator(".tooltip strong").first().waitFor({ timeout: 10_000 });
      if (shots) await page.screenshot({ path: `${shots}/link.png` });
    });
    // Comments (TEMPRA-13): a person comments on selected text; an agent answers and resolves,
    // and the open page follows without reloading, in the Comments panel (take 4).
    await step(
      "comments: comment on a selection, an agent replies and resolves, live",
      async () => {
        await page.goto(url);
        await page.locator(".body .prose").waitFor({ timeout: 15_000 });
        // The page opens on its contents: no panel until the person asks for one.
        await page.waitForTimeout(300);
        if ((await comments.count()) > 0) throw new Error("the comments opened by themselves");
        // Selects the first 16 characters of the first longer run of paragraph text, as a
        // person dragging over it would (a script string: this file has no DOM types).
        const select = () =>
          page.evaluate<string | null>(`(() => {
          const root = document.querySelector(".body .prose");
          const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
          for (let n = walker.nextNode(); n; n = walker.nextNode()) {
            const text = n.textContent ?? "";
            if (text.trim().length < 24 || n.parentElement?.closest("h1, h2, h3, a, code")) continue;
            const start = text.search(/\\S/);
            // In view, as a person selecting it would have it: the toolbar sits beside it.
            n.parentElement.scrollIntoView({ block: "center" });
            const range = document.createRange();
            range.setStart(n, start);
            range.setEnd(n, start + 16);
            const sel = document.getSelection();
            sel?.removeAllRanges();
            sel?.addRange(range);
            return range.toString();
          }
          return null;
        })()`);
        const unselect = () => page.evaluate("document.getSelection().removeAllRanges()");
        const tools = page.locator(".selection-tools");
        /** The text a highlight covers (the CSS Custom Highlight API: no element in the body). */
        const highlighted = (name: string) =>
          page.evaluate<string[]>(
            `[...(CSS.highlights.get(${JSON.stringify(name)}) ?? [])].map((r) => r.toString())`,
          );
        /** Where a person would click on a highlight's first range, in the viewport. */
        const pointOn = (name: string) =>
          page.evaluate<{ x: number; y: number } | null>(`(() => {
          const range = [...(CSS.highlights.get(${JSON.stringify(name)}) ?? [])][0];
          // In view first, as a person would scroll to it.
          range?.startContainer.parentElement?.scrollIntoView({ block: "center" });
          const box = range?.getClientRects()[0];
          return box ? { x: box.left + Math.min(6, box.width / 2), y: box.top + box.height / 2 } : null;
        })()`);
        /** Waits until the highlight covers some text (or none, with `gone`). */
        const highlight = async (name: string, gone = false, ms = 10_000) => {
          const until = Date.now() + ms;
          for (;;) {
            const now = await highlighted(name);
            if (gone ? now.length === 0 : now.some((t) => t.trim() !== "")) return now;
            if (Date.now() > until) {
              throw new Error(`highlight ${name} ${gone ? "still drawn" : "not drawn"}: ${now}`);
            }
            await page.waitForTimeout(100);
          }
        };
        if (!(await page.evaluate<boolean>("typeof CSS !== 'undefined' && 'highlights' in CSS"))) {
          throw new Error("this Chrome has no CSS Custom Highlight API");
        }
        // Selecting shows the toolbar; clicking away (the selection gone) hides it, and
        // nothing is held for a comment.
        const quote = await select();
        if (!quote) throw new Error("no paragraph text to select");
        await tools.waitFor({ timeout: 5_000 });
        if (shots) await page.screenshot({ path: `${shots}/selection-tools.png` });
        await unselect();
        await tools.waitFor({ state: "detached", timeout: 5_000 });
        if ((await page.locator(".comment-form .quote").count()) > 0) {
          throw new Error("a quote was held for a comment after the selection went");
        }
        // Comment on the toolbar opens the Comments panel with a draft at the top: filled in
        // the body, the box focused. Escape drops it (the panel stays); a second is posted.
        await select();
        await tools.getByRole("button", { name: "Comment" }).click();
        const drafted = await highlight("tempra-comment-draft", false, 5_000);
        if (drafted.join("") !== quote) {
          throw new Error(
            `the draft covers ${JSON.stringify(drafted)}, not ${JSON.stringify(quote)}`,
          );
        }
        // The draft is at the top of the panel, with its quote.
        await comments.waitFor({ timeout: 5000 });
        await comments
          .locator(".comments-list > form.comment-form:first-of-type .quote")
          .waitFor({ timeout: 5000 });
        const box = comments.getByPlaceholder("Comment on the selection");
        if (!(await box.evaluate((el) => el === el.ownerDocument.activeElement))) {
          throw new Error("the comment box did not take the focus");
        }
        await page.keyboard.press("Escape");
        await highlight("tempra-comment-draft", true, 5_000);
        await comments.locator("form.comment-form").waitFor({ state: "detached", timeout: 5000 });
        if (!(await comments.isVisible())) throw new Error("Escape on a draft closed the panel");
        await select();
        await tools.getByRole("button", { name: "Comment" }).click();
        await tools.waitFor({ state: "detached", timeout: 5_000 });
        await box.fill("Gate: please check this sentence.");
        if (shots) await page.screenshot({ path: `${shots}/comment-draft.png` });
        // An agent writes while the comment is being written (TEMPRA-128, C-4): the new version
        // waits beside the tools and never swaps in under the draft, past the reader's idle
        // time (15 s), so nothing typed is lost.
        await agentAppends("A sentence written under a draft.", "gate: a write under a draft");
        await newVersion().waitFor({ timeout: 10_000 });
        await page.waitForTimeout(17_000);
        if ((await box.inputValue()) !== "Gate: please check this sentence.") {
          throw new Error("the draft was lost when a new version arrived");
        }
        if ((await highlight("tempra-comment-draft", false, 1000)).join("") !== quote) {
          throw new Error("the draft's quote was lost when a new version arrived");
        }
        if ((await page.getByText("A sentence written under a draft.").count()) > 0) {
          throw new Error("the new version swapped in under the draft");
        }
        // Enter sends (TEMPRA-223): Shift+Enter first adds a line and sends nothing.
        await box.press("End");
        await box.press("Shift+Enter");
        await page.waitForTimeout(300);
        if ((await box.inputValue()) !== "Gate: please check this sentence.\n") {
          throw new Error(`Shift+Enter in the box: ${JSON.stringify(await box.inputValue())}`);
        }
        await box.press("Backspace");
        await box.press("Enter");
        await highlight("tempra-comment-draft", true);
        // Posted: the new version comes in when asked, the comment staying on its quote.
        await showNewVersion();
        await page
          .locator(".body .prose")
          .getByText("A sentence written under a draft.")
          .waitFor({ timeout: 10_000 });
        // The posted thread is the active one: solid, then dotted with the others.
        const marked = async () => [
          ...(await highlighted("tempra-comment")),
          ...(await highlighted("tempra-comment-active")),
        ];
        const until = Date.now() + 10_000;
        while (!(await marked()).some((t) => t.includes(quote.trim().slice(0, 8)))) {
          if (Date.now() > until) throw new Error(`highlight: ${await marked()} for ${quote}`);
          await page.waitForTimeout(100);
        }
        const card = comments.getByRole("region", { name: "Comment thread" });
        await card.getByText("Gate: please check this sentence.").waitFor();
        if (shots) await page.screenshot({ path: `${shots}/comment.png` });
        const listed = (await (
          await fetch(`${libApi}/comments?path=${encodeURIComponent(pagePath)}&status=open`, {
            headers: bearer,
          })
        ).json()) as { threads: { id: string; comments: { body: string }[] }[] };
        const thread = listed.threads.find((t) =>
          t.comments.some((c) => c.body === "Gate: please check this sentence."),
        )?.id;
        if (!thread) throw new Error(`the thread is not listed: ${JSON.stringify(listed)}`);
        const threadEl = comments.locator(`[id="panel-thread-${thread}"]`);
        // A click elsewhere in the text lets the thread go (compact in the panel); a click on
        // its quote makes it the active thread again.
        await page
          .locator(".body .prose")
          .getByText("A sentence the gate added.", { exact: true })
          .click();
        await comments.locator(`button.thread.collapsed[id="panel-thread-${thread}"]`).waitFor({
          timeout: 5000,
        });
        await highlight("tempra-comment-active", true, 5000);
        // An open thread's quote, and its block's mark beside the text (TEMPRA-223), as they
        // look in light and dark.
        const blockMark = main.locator(".body > .comment-marks").getByRole("button", {
          name: "1 comment",
          exact: true,
        });
        await blockMark.waitFor({ timeout: 5000 });
        if (shots) {
          const quoteAt = await pointOn("tempra-comment");
          if (quoteAt) await page.mouse.move(quoteAt.x, quoteAt.y + 200);
          await page.screenshot({ path: `${shots}/comment-open.png` });
          await page.emulateMedia({ colorScheme: "dark" });
          await page.waitForTimeout(200);
          await page.screenshot({ path: `${shots}/comment-open-dark.png` });
          await page.emulateMedia({ colorScheme: "light" });
        }
        const at = await pointOn("tempra-comment");
        if (!at) throw new Error("the thread's quote is not drawn");
        await page.mouse.click(at.x, at.y);
        await comments.locator(`section.thread.open[id="panel-thread-${thread}"]`).waitFor({
          timeout: 5000,
        });
        await highlight("tempra-comment-active", false, 5000);
        if (shots) {
          await page.screenshot({ path: `${shots}/comment-active.png` });
          await page.emulateMedia({ colorScheme: "dark" });
          await page.waitForTimeout(200);
          await page.screenshot({ path: `${shots}/comment-active-dark.png` });
          await page.emulateMedia({ colorScheme: "light" });
        }
        // The mark opens the panel on its block's first thread, from the keyboard too; the corner
        // row's Comments opens it as well, its open count in its name (TEMPRA-283).
        await page.getByRole("button", { name: "Close comments" }).click();
        await comments.waitFor({ state: "detached", timeout: 5000 });
        await blockMark.focus();
        await page.keyboard.press("Enter");
        await comments.locator(`section.thread.open[id="panel-thread-${thread}"]`).waitFor({
          timeout: 5000,
        });
        await page.getByRole("button", { name: "Close comments" }).click();
        await comments.waitFor({ state: "detached", timeout: 5000 });
        const cornerComments = tool("comments");
        const named = (await cornerComments.getAttribute("aria-label")) ?? "";
        if (named !== "Comments, 1 open") {
          throw new Error(`the corner's Comments is named ${JSON.stringify(named)}`);
        }
        if ((await cornerComments.locator(".icon-button-count").innerText()) !== "1") {
          throw new Error("the corner's Comments shows no count");
        }
        await cornerComments.click();
        await comments.waitFor({ timeout: 5000 });
        await comments.locator(`[id="panel-thread-${thread}"]`).waitFor({ timeout: 5000 });
        await markStay();
        await page.waitForTimeout(300);
        // An agent writes a new paragraph above it (TEMPRA-22): the commented block keeps its
        // ID, the thread stays on it, and the highlight follows the quote on the open page.
        type Anchored = { anchor: { block: string | null } | null; outdated: boolean };
        const threadNow = async () =>
          (await (
            await fetch(`${libApi}/comments/${thread}`, { headers: bearer })
          ).json()) as Anchored;
        const block = (await threadNow()).anchor?.block;
        if (!block) throw new Error("the comment's anchor names no block");
        const before = await fetch(api, { headers: auth });
        const md = await before.text();
        const end = md.indexOf("\n---\n", 3) + 5;
        const opening = "An agent's new opening paragraph.";
        const inserted = await fetch(api, {
          method: "PUT",
          headers: {
            ...auth,
            "Content-Type": "text/markdown",
            "If-Match": before.headers.get("ETag") ?? "",
            "X-Note": "gate: an agent writes above a comment",
          },
          body: `${md.slice(0, end)}${opening}\n\n${md.slice(end)}`,
        });
        if (!inserted.ok)
          throw new Error(`agent write: ${inserted.status} ${await inserted.text()}`);
        const after = (await (
          await fetch(api, { headers: { ...auth, Accept: "application/json" } })
        ).json()) as { doc: unknown };
        if (!JSON.stringify(after.doc).includes(`"id":"${block}"`)) {
          throw new Error("the commented block lost its ID in the agent's write");
        }
        const moved = await threadNow();
        if (moved.outdated || moved.anchor?.block !== block) {
          throw new Error(`the thread lost its place: ${JSON.stringify(moved)}`);
        }
        await showNewVersion();
        await page.locator(".body").getByText(opening).waitFor({ timeout: 10_000 });
        const followed = Date.now() + 10_000;
        while (!(await marked()).some((t) => t.includes(quote.trim().slice(0, 8)))) {
          if (Date.now() > followed) {
            throw new Error(`highlight after the agent's write: ${await marked()}`);
          }
          await page.waitForTimeout(100);
        }
        // The agent answers: the reply shows in the thread's card in the panel, live.
        const reply = await fetch(`${libApi}/comments/${thread}`, {
          method: "POST",
          headers: { ...bearer, "Content-Type": "application/json" },
          body: JSON.stringify({ body: "Checked it; it holds." }),
        });
        if (!reply.ok) throw new Error(`agent reply: ${reply.status} ${await reply.text()}`);
        await threadEl.getByText("Checked it; it holds.").waitFor({ timeout: 10_000 });
        // Notifications (TEMPRA-72, TEMPRA-74): the agent's reply on the person's thread is in
        // their inbox, its count shows on the open page's bell (take 4) without a reload, and
        // the batched mail lands in the dev outbox.
        await sheetBar
          .getByRole("button", { name: /^Notifications, \d+ waiting$/ })
          .waitFor({ timeout: 10_000 });
        const inbox = (await (await apiAs(devCookie, "/api/v1/inbox")).json()) as {
          items: { id: string; kind: string; excerpt: string; href: string }[];
        };
        const item = inbox.items.find((i) => i.excerpt === "Checked it; it holds.");
        if (item?.kind !== "reply" || !item.href.endsWith("#comments")) {
          throw new Error(`inbox: ${JSON.stringify(inbox.items.slice(0, 3))}`);
        }
        const sent = await ui(`${base}/_dev/mail/send`, {
          method: "POST",
          headers: { Accept: "application/json" },
        });
        // Queued on the local MAIL_QUEUE (TEMPRA-89): its consumer fills the outbox a moment later.
        let outbox: { mails: { to: string; text: string }[] } = { mails: [] };
        for (let i = 0; i < 40; i++) {
          outbox = (await (await ui(`${base}/_dev/mail.json`)).json()) as typeof outbox;
          if (outbox.mails.some((m) => m.text.includes("Checked it; it holds."))) break;
          await new Promise((r) => setTimeout(r, 250));
        }
        if (!sent.ok || !outbox.mails.some((m) => m.text.includes("Checked it; it holds."))) {
          throw new Error(`dev outbox: ${sent.status} ${JSON.stringify(outbox.mails[0] ?? null)}`);
        }
        const resolve = await fetch(`${libApi}/comments/${thread}/resolve`, {
          method: "POST",
          headers: { ...bearer, "Content-Type": "application/json" },
          body: "{}",
        });
        if (!resolve.ok)
          throw new Error(`agent resolve: ${resolve.status} ${await resolve.text()}`);
        await comments.getByRole("button", { name: "Resolved 1" }).waitFor({ timeout: 10_000 });
        await highlight("tempra-comment", true);
        await highlight("tempra-comment-active", true);
        if ((await tool("comments").getAttribute("aria-label")) !== "Comments") {
          throw new Error(
            `Comments still counts open threads: ${await tool("comments").getAttribute("aria-label")}`,
          );
        }
        // Under Resolved it is there, with Reopen.
        await comments.getByRole("button", { name: "Resolved 1" }).click();
        await threadEl.waitFor({ timeout: 5000 });
        if ((await threadEl.evaluate((el) => el.tagName)) === "BUTTON") await threadEl.click();
        await threadEl.getByRole("button", { name: "Reopen" }).waitFor({ timeout: 5000 });
        if (!(await stayed())) throw new Error("the page reloaded");
        // Resolving the thread closed its item (TEMPRA-116): it is done.
        const closed = (await (await apiAs(devCookie, "/api/v1/inbox?all=1")).json()) as {
          items: { id: string; done_at: string | null }[];
        };
        if (!closed.items.find((i) => i.id === item.id)?.done_at) {
          throw new Error("resolving the thread left its inbox item open");
        }
      },
    );
    // Notifications (TEMPRA-173, TEMPRA-189): an agent's reply on a thread the person opened waits
    // in the bell's panel, on the page the person is on; opening it lands in the thread and is
    // seeing it.
    await step("Notifications: an agent's reply waits in the bell's panel", async () => {
      const target = pagePaths.find((c) => c !== pagePath) ?? pagePath;
      const posted = await apiAs(devCookie, `/api/v1/libraries/${owner}/${slug}/comments`, "POST", {
        path: target,
        body: "Gate: is this still current?",
        anchor: null,
      });
      if (!posted.ok) throw new Error(`the person comments: ${posted.status}`);
      const id = ((await posted.json()) as { thread: { id: string } }).thread.id;
      const answered = await fetch(`${libApi}/comments/${id}`, {
        method: "POST",
        headers: { ...bearer, "Content-Type": "application/json" },
        body: JSON.stringify({ body: "Gate: yes, it is still current." }),
      });
      if (!answered.ok) throw new Error(`agent reply: ${answered.status}`);
      const threadHref = `/${owner}/${slug}/${enc(target)}#thread-${encodeURIComponent(id)}`;
      // The bell, on the library's home, lists the reply, by the page's title, never its slug.
      await page.goto(`${lib}/`);
      await home();
      await markStay();
      const bell = page.locator("header.ws-topbar").getByRole("button", { name: /^Notifications/ });
      const bellPop = page.locator(".menu-list.bell-pop");
      await bell.click();
      const item = bellPop.locator(`a.bell-item[href="${threadHref}"]`);
      await item.waitFor({ timeout: 10_000 });
      await item.getByText("replied to your thread").waitFor({ timeout: 5000 });
      const meta = (await (
        await fetch(`${libApi}/files/${enc(target)}`, {
          headers: { ...bearer, Accept: "application/json" },
        })
      ).json()) as { frontmatter: { title?: string } };
      const title = meta.frontmatter.title;
      if (title) {
        await item
          .locator("strong")
          .filter({ hasText: new RegExp(`^${title.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`) })
          .waitFor({ timeout: 10_000 });
      }
      if (shots) await page.screenshot({ path: `${shots}/bell.png` });
      // Opening it lands in the thread, in the page's Comments panel, with no reload.
      await item.click();
      await page.waitForURL(`${base}${threadHref}`);
      await comments
        .locator(`section.thread.open[id="panel-thread-${id}"]`)
        .waitFor({ timeout: 15_000 });
      if (!(await stayed())) throw new Error("the notification reloaded the page");
      // Opening it was seeing it (one state, TEMPRA-189): done, and gone from the panel.
      const deadline = Date.now() + 10_000;
      for (;;) {
        const open = (await (await apiAs(devCookie, "/api/v1/inbox")).json()) as {
          items: { thread: string | null }[];
        };
        if (!open.items.some((i) => i.thread === id)) break;
        if (Date.now() > deadline) throw new Error("opening the reply left it waiting");
        await page.waitForTimeout(200);
      }
      await bell.click();
      await bellPop.locator(".bell-item, .bell-empty").first().waitFor({ timeout: 10_000 });
      await item.waitFor({ state: "detached", timeout: 10_000 });
      await page.keyboard.press("Escape");
      await bellPop.waitFor({ state: "detached", timeout: 5000 });
      const resolved = await fetch(`${libApi}/comments/${id}/resolve`, {
        method: "POST",
        headers: { ...bearer, "Content-Type": "application/json" },
        body: "{}",
      });
      if (!resolved.ok) throw new Error(`agent resolve: ${resolved.status}`);
    });
    // A page at phone width (take 4, TEMPRA-118, boards 33 and 35; TEMPRA-283): the top bar with
    // Tempra, the bell and the avatar (no ⋯), the folders above the title, the corner row under
    // the byline (Comments, Page info, Copy page), "On this page" closed until opened; Comments
    // and Page info are one bottom sheet, opened only when asked, closed by × or Escape.
    await step(
      "a page at phone width: its top bar, On this page, the panels as a bottom sheet",
      async () => {
        await page.setViewportSize({ width: 390, height: 844 });
        try {
          await page.goto(url);
          await page.locator(".body .prose").waitFor({ timeout: 15_000 });
          const title = (await main.locator("h1.doc-title").innerText()).trim();
          await phoneNamed(title);
          // The page's tools sit under the byline (TEMPRA-283), 44px targets; the bar has the
          // bell and no ⋯.
          const headRow = main.locator(".page-tools-head");
          await headRow.waitFor({ state: "visible", timeout: 5000 });
          const rowBox = await headRow.boundingBox();
          const bylineBox = await byline.boundingBox();
          if (!rowBox || !bylineBox || rowBox.y < bylineBox.y + bylineBox.height - 1) {
            throw new Error(`the page's tools are not under the byline: ${JSON.stringify(rowBox)}`);
          }
          const target = await tool("comments").boundingBox();
          if (!target || target.height < 43) {
            throw new Error(`Comments is not a 44px target: ${JSON.stringify(target)}`);
          }
          if (await sheetBar.getByRole("button", { name: "More", exact: true }).isVisible()) {
            throw new Error("⋯ is still in the phone's top bar");
          }
          if (!(await sheetBar.getByRole("button", { name: /^Notifications/ }).isVisible())) {
            throw new Error("no bell in the page's phone bar");
          }
          for (const gone of [
            sheetBar.getByRole("button", { name: "Search", exact: true }),
            sheetBar.getByRole("button", { name: /^Comments/ }),
            sheetBar.getByRole("button", { name: /^Copy page$/ }),
          ]) {
            if (await gone.isVisible()) throw new Error(`the page's phone bar shows ${gone}`);
          }
          if (pagePath.includes("/")) {
            const crumbs = main.getByRole("navigation", { name: "Folders" });
            if (!(await crumbs.isVisible())) throw new Error("no crumbs under the phone's top bar");
          }
          await page.waitForTimeout(500);
          if ((await comments.count()) > 0) throw new Error("the comments opened by themselves");
          // On this page: a closed disclosure under the byline; it opens, and a heading closes it.
          const inline = main.locator("details.toc-inline");
          if ((await inline.count()) > 0) {
            const isOpen = () =>
              page.evaluate<boolean>('document.querySelector("details.toc-inline").open');
            if (await isOpen()) {
              throw new Error("On this page is open by itself");
            }
            await inline.locator("summary").click();
            const entry = inline.locator(".toc a").first();
            await entry.waitFor({ state: "visible", timeout: 5000 });
            await entry.click();
            await page.waitForFunction(
              '!document.querySelector("details.toc-inline").open',
              undefined,
              {
                timeout: 5000,
              },
            );
            if (await isOpen()) throw new Error("On this page stayed open after a heading");
          }
          if (shots) await page.screenshot({ path: `${shots}/page-phone.png` });
          const sideways = await page
            .locator("html")
            .evaluate((el) => el.scrollWidth > el.clientWidth);
          if (sideways) throw new Error("the page scrolls sideways at phone width");
          // Copy page, the row's own button, on a phone as everywhere (TEMPRA-283).
          await b.context.grantPermissions(["clipboard-read", "clipboard-write"], { origin: base });
          await copyButton().click();
          await headRow.getByRole("button", { name: "Copied" }).waitFor({ timeout: 5000 });
          const copied = await page.evaluate<string>("navigator.clipboard.readText()");
          if (!copied.startsWith("---\n"))
            throw new Error(`Copy page copied: ${copied.slice(0, 60)}`);
          // A sheet from the bottom: as wide as the screen, its foot at the screen's, about two
          // thirds of it high, with a drag handle.
          const isSheet = async (sheet: typeof comments, what: string) => {
            await sheet.waitFor({ timeout: 5000 });
            const box = await sheet.boundingBox();
            if (
              !box ||
              box.x > 1 ||
              Math.abs(box.y + box.height - 844) > 2 ||
              box.width < 380 ||
              box.height < 0.55 * 844 ||
              box.height > 0.75 * 844
            ) {
              throw new Error(`${what} is not a bottom sheet: ${JSON.stringify(box)}`);
            }
            if (!(await sheet.locator(".panel-grip").isVisible())) {
              throw new Error(`${what} has no drag handle`);
            }
          };
          await openComments();
          await isSheet(comments, "Comments");
          await comments.getByRole("button", { name: "Comment on the page…" }).waitFor();
          if (shots) await page.screenshot({ path: `${shots}/comments-phone.png` });
          await comments.getByRole("button", { name: "Close comments" }).click();
          await comments.waitFor({ state: "detached", timeout: 5000 });
          await openInfo();
          await isSheet(infoPanel, "Page info");
          if (shots) await page.screenshot({ path: `${shots}/page-info-phone.png` });
          await infoPanel.getByRole("button", { name: "Close page info" }).click();
          await infoPanel.waitFor({ state: "detached", timeout: 5000 });
        } finally {
          await wide();
        }
      },
    );
    // Keyboard only (TEMPRA-133): a panel opened from its control takes the focus to its heading
    // and gives it back on close (its corner button, TEMPRA-283); the menus move by arrow keys and close when the
    // focus leaves; a footnote's card describes its marker and closes on Escape; selected text is
    // commented on with Ctrl+Alt+M and posted from the keyboard. At phone width the drawer and a
    // panel's sheet are modal (what they dim is inert), and a tap on the dimmed page closes the
    // sheet.
    await step("keyboard: panels, menus, a card, a comment, the drawer and the sheet", async () => {
      const path = "gate-keys.md";
      const put = await fetch(`${libApi}/files/${path}`, {
        method: "PUT",
        headers: { ...bearer, "Content-Type": "text/markdown", "X-Note": "gate: keys" },
        body: [
          "---\ntype: Note\ntitle: Gate keys\ndescription: A page read from the keyboard.\n---",
          "A sentence long enough to select from the keyboard, with a note.[^n]\n",
          "[^n]: The note itself.\n",
        ].join("\n"),
      });
      if (!put.ok) throw new Error(`write: ${put.status} ${await put.text()}`);
      await page.goto(`${lib}/${path}`);
      const prose = page.locator(".body .prose");
      await prose.waitFor({ timeout: 15_000 });
      const focusIs = (selector: string) =>
        page.evaluate<boolean>(`!!document.activeElement?.matches(${JSON.stringify(selector)})`);
      const focused = () =>
        page.evaluate<string>(`(() => {
          const el = document.activeElement;
          if (!el) return "nothing";
          return el.tagName + " " + (el.textContent ?? "").trim().slice(0, 60);
        })()`);
      const expectFocus = async (selector: string, what: string) => {
        const until = Date.now() + 3000;
        while (!(await focusIs(selector))) {
          if (Date.now() > until) throw new Error(`${what}: the focus is on ${await focused()}`);
          await page.waitForTimeout(50);
        }
      };
      // Comments from the corner row (TEMPRA-283): the focus to the panel's heading, and back to
      // its button, pressed while open, on Escape.
      await openCommentsByKeys();
      await comments.waitFor({ timeout: 5000 });
      await expectFocus("aside#panel-comments h2", "opening Comments");
      if ((await tool("comments").getAttribute("aria-pressed")) !== "true") {
        throw new Error("Comments is not pressed while its panel is open");
      }
      await page.keyboard.press("Escape");
      await comments.waitFor({ state: "detached", timeout: 5000 });
      await expectFocus('.page-tools-side [data-panel="comments"]', "closing Comments");
      // Page info from the keyboard: Tab to it, Enter; its heading takes the focus; Escape gives
      // it back to its button.
      await page.keyboard.press("Tab");
      await expectFocus('.page-tools-side [data-panel="info"]', "Tab to Page info");
      await page.keyboard.press("Enter");
      await infoPanel.waitFor({ timeout: 5000 });
      await expectFocus("aside#panel-info h2", "opening Page info");
      await page.keyboard.press("Escape");
      await infoPanel.waitFor({ state: "detached", timeout: 5000 });
      await expectFocus('.page-tools-side [data-panel="info"]', "closing Page info");
      // Copy page's ⌄ by its keys: Down opens it at View Markdown, End, Home move; Escape gives
      // the focus back to the ⌄.
      const list = page.locator(".menu-list");
      await copyMore().focus();
      await page.keyboard.press("ArrowDown");
      await list.waitFor({ timeout: 5000 });
      if (!(await focused()).includes("View Markdown")) throw new Error(`Down: ${await focused()}`);
      await page.keyboard.press("End");
      if (!(await focused()).includes("Download")) throw new Error(`End: ${await focused()}`);
      await page.keyboard.press("Home");
      if (!(await focused()).includes("View Markdown")) throw new Error(`Home: ${await focused()}`);
      if ((await list.getByText("Copy link").count()) > 0) throw new Error("Copy link is back");
      await page.keyboard.press("Escape");
      await list.waitFor({ state: "detached", timeout: 5000 });
      await expectFocus('.page-tools-side [aria-label="More copy options"]', "closing the ⌄");
      // A menu closes when the focus leaves it.
      await page.keyboard.press("Enter");
      await list.waitFor({ timeout: 5000 });
      await page.keyboard.press("Shift+Tab");
      await list.waitFor({ state: "detached", timeout: 5000 });
      // A footnote marker's card: its description while shown, gone on Escape.
      const marker = prose.locator(".fnref a").first();
      await marker.focus();
      const card = page.locator(".tooltip[role=tooltip]");
      await card.waitFor({ timeout: 5000 });
      const described = await marker.getAttribute("aria-describedby");
      if (!described || described !== (await card.getAttribute("id"))) {
        throw new Error(`the card does not describe its marker: ${described}`);
      }
      if ((await marker.getAttribute("aria-label")) !== "footnote 1") {
        throw new Error(`the marker says "${await marker.getAttribute("aria-label")}"`);
      }
      await page.keyboard.press("Escape");
      await card.waitFor({ state: "detached", timeout: 5000 });
      // Selected text, then Ctrl+Alt+M: the draft's box takes the focus; Tab to Comment, Enter.
      await page.evaluate(`(() => {
        // The paragraph's first text with words in it (Svelte keeps empty text anchors).
        const p = document.querySelector(".body .prose p");
        const text = [...p.childNodes].find((n) => n.nodeType === 3 && n.textContent.length >= 18);
        const range = document.createRange();
        range.setStart(text, 0);
        range.setEnd(text, 18);
        const sel = document.getSelection();
        sel.removeAllRanges();
        sel.addRange(range);
      })()`);
      await page.keyboard.press("Control+Alt+KeyM");
      await comments.waitFor({ timeout: 5000 });
      const box = comments.getByPlaceholder("Comment on the selection");
      await expectFocus("aside#panel-comments textarea", "Ctrl+Alt+M");
      await page.keyboard.type("Gate: from the keyboard.");
      await page.keyboard.press("Tab");
      await page.keyboard.press("Tab");
      await expectFocus('form.comment-form button[type="submit"]', "Tab to Comment");
      await page.keyboard.press("Enter");
      await box.waitFor({ state: "detached", timeout: 10_000 });
      await comments
        .getByRole("region", { name: "Comment thread" })
        .getByText("Gate: from the keyboard.")
        .waitFor({ timeout: 10_000 });
      await page.keyboard.press("Escape");
      await comments.waitFor({ state: "detached", timeout: 5000 });
      // The focus goes back where it was before Ctrl+Alt+M: the marker, focused for its card.
      await expectFocus(".body .fnref a", "closing Comments after commenting");
      // At phone width: the drawer from its button, modal, closed by Escape, the focus back.
      await page.setViewportSize({ width: 390, height: 844 });
      try {
        const inert = (selector: string) =>
          page.evaluate<boolean>(`!!document.querySelector(${JSON.stringify(selector)})?.inert`);
        const menuButton = page.locator("button.ws-menu");
        await menuButton.waitFor({ timeout: 5000 });
        await menuButton.focus();
        await page.keyboard.press("Enter");
        await page.locator("section.ws-sidebar.open").waitFor({ timeout: 5000 });
        await expectFocus("section.ws-sidebar, section.ws-sidebar *", "opening the drawer");
        if (!(await inert("header.ws-topbar")) || !(await inert("main.ws-main"))) {
          throw new Error("the page behind the drawer is not inert");
        }
        for (let i = 0; i < 4; i++) await page.keyboard.press("Tab");
        await expectFocus("section.ws-sidebar *", "Tab in the drawer");
        await page.keyboard.press("Escape");
        await page.locator("section.ws-sidebar.open").waitFor({ state: "detached" });
        await expectFocus("button.ws-menu", "closing the drawer");
        if ((await inert("header.ws-topbar")) || (await inert("main.ws-main"))) {
          throw new Error("the page stayed inert after the drawer closed");
        }
        // A panel's sheet: modal, its heading focused, closed by a tap on the dimmed page.
        await openCommentsByKeys();
        await comments.waitFor({ timeout: 5000 });
        await expectFocus("aside#panel-comments h2", "opening the sheet");
        if (!(await inert("main article.doc")) || !(await inert("header.ws-topbar"))) {
          throw new Error("the page behind the sheet is not inert");
        }
        await page.mouse.click(195, 120);
        await comments.waitFor({ state: "detached", timeout: 5000 });
        if ((await inert("main article.doc")) || (await inert("header.ws-topbar"))) {
          throw new Error("the page stayed inert after the sheet closed");
        }
      } finally {
        await wide();
      }
    });
    // Agents' presence (TEMPRA-219): while a page is open, an agent searches the library over
    // MCP, then reads two pages. A search marks nothing: what it found does not shimmer. The
    // pages it reads do, with no words beside them; a hover names the agent (the row's title).
    // A closed folder holding one shimmers its own name instead; opened mid-shimmer, the pages
    // inside take it and the folder stops. All of it fades a few seconds after the agent stops,
    // and the person's own reads and searches mark nothing. With GATE_SCREENSHOTS, a still with
    // the band held mid-row; with GATE_RECORD=1 too, a recording of the tree (presence.webm,
    // presence.gif) while the agent reads a page in a closed folder and the person opens it.
    await step("presence: an agent's reads shimmer in the tree, its search does not", async () => {
      await page.goto(url);
      await main.locator(".body .prose").waitFor({ timeout: 15_000 });
      // The page left open: one the gate's agent has not written in this run.
      const outline = (await page.evaluate(
        `fetch("/api/v1/libraries/${owner}/${slug}/outline").then((r) => r.json())`,
      )) as { files: { path: string; kind: string; title?: string | null; seq?: number }[] };
      const pages = outline.files.filter(
        (f) =>
          f.kind === "page" &&
          f.path !== pagePath &&
          !f.path.startsWith("gate") &&
          /[A-Za-z]{4,}/.test(f.title ?? ""),
      );
      const other = [...pages].sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0))[0];
      if (!other) throw new Error("no other page to read");
      const nested = [pagePath, other.path].find((p) => p.includes("/"));
      if (!nested) throw new Error("no page in a folder to read");
      const top = nested.split("/")[0] ?? "";
      /** A folder's row in the tree, by its first-level name. */
      const folderRow = (name: string) =>
        sidebar
          .locator(".tree-row.dir")
          .filter({
            has: page.locator(
              `button.tree-name:is([title="${folderName(name)}"], [title^="${folderName(name)}: "])`,
            ),
          })
          .first();
      /** Holds every shimmer with its band mid-row, for a still that shows it; `false` lets go. */
      const holdBand = (hold: boolean) =>
        page.evaluate(
          `document.getAnimations().filter((a) => a.animationName === "tempra-shimmer").forEach((a) => { if (${hold}) { a.pause(); a.currentTime = 1000; } else a.play(); })`,
        );
      // What the feed brings to the page opened below (only sockets opened from here on): its
      // hello, which says the socket is open, and its presence messages and live events, each
      // with when it came (ms since `t0`), said if a mark does not come or does not go.
      const t0 = Date.now();
      let feedOpen = false;
      const frames: { at: number; paths: string[]; text: string }[] = [];
      const writes: string[] = [];
      const listen = (ws: { on(e: "framereceived", f: (d: { payload: unknown }) => void): void }) =>
        ws.on("framereceived", (d) => {
          const text = String(d.payload);
          if (text === "pong") return;
          try {
            const m = JSON.parse(text) as {
              type?: string;
              paths?: string[];
              events?: { op: string; path: string; actor: string }[];
            };
            const at = Date.now() - t0;
            if (m.type === "hello") feedOpen = true;
            if (m.type === "presence") frames.push({ at, paths: m.paths ?? [], text });
            for (const e of m.events ?? [])
              writes.push(`+${at} ms ${e.op} ${e.path} by ${e.actor}`);
          } catch {
            // Not the feed's JSON: nothing to note.
          }
        });
      const said = () =>
        `presence on the feed: ${frames.map((f) => `+${f.at} ms ${f.text}`).join(" ") || "none"}; writes on it: ${writes.join(", ") || "none"}`;
      /** A wait that says which one it was when it times out. */
      const named = <T>(what: string, wait: Promise<T>) =>
        wait.catch((e: unknown) => {
          throw new Error(`${what}: ${String(e).split("\n")[0]}`);
        });
      page.on("websocket", listen);
      const client = new Client({ name: "gate-presence", version: "1.0.0" });
      await client.connect(
        new StreamableHTTPClientTransport(new URL(`${base}/mcp`), {
          fetch,
          requestInit: { headers: { Authorization: `Bearer ${token}` } },
        }),
      );
      const call = async (name: string, args: Record<string, unknown>) => {
        const r = await client.callTool({
          name,
          arguments: { library: `${owner}/${slug}`, ...args },
        });
        if (r.isError) throw new Error(`${name}: ${JSON.stringify(r.content).slice(0, 200)}`);
      };
      const marked = sidebar.locator(".tree-row.presence");
      try {
        // Every folder open, so every row the agent touches is drawn.
        await page.evaluate(`localStorage.removeItem("tempra:tree-closed:${owner}/${slug}")`);
        feedOpen = false;
        await page.goto(`${lib}/${enc(other.path)}`);
        await named(
          `${other.path} drawn`,
          main.locator(".body .prose").waitFor({ timeout: 15_000 }),
        );
        await named(
          "the tree drawn",
          sidebar.locator(`a[data-path="${pagePath}"]`).waitFor({ timeout: 10_000 }),
        );
        // The page's feed open (its hello) before the agent does anything: presence goes only to
        // open sockets and is never caught up, so a read before it would be missed.
        await named(
          "the page's feed opening",
          (async () => {
            const until = Date.now() + 10_000;
            while (!feedOpen) {
              if (Date.now() > until) throw new Error("no hello on the feed in 10 s");
              await page.waitForTimeout(50);
            }
          })(),
        );
        // Earlier steps' agent writes and reads fade first.
        await named(
          "earlier marks fading",
          marked.first().waitFor({ state: "detached", timeout: 20_000 }),
        );
        // What a search will find, asked as the person (whose search is no presence either).
        const q =
          (other.title ?? "")
            .split(/[^A-Za-z]+/)
            .filter((w) => w.length >= 4)
            .sort((a, b) => b.length - a.length)[0] ?? "";
        const found = (await page.evaluate(
          `fetch("/api/v1/libraries/${owner}/${slug}/search?q=${encodeURIComponent(q)}").then((r) => r.json())`,
        )) as { results: { path: string }[] };
        const read = [pagePath, other.path];
        // What the search finds that the agent will not read: these must never shimmer.
        const unread = [...new Set(found.results.map((r) => r.path))].filter(
          (p) => !read.includes(p),
        );
        await call("search", { q });
        // A presence message would land in milliseconds; the search sends none.
        await page.waitForTimeout(1500);
        if ((await marked.count()) > 0 || frames.length > 0) {
          throw new Error(`a search marked pages: ${said()}`);
        }
        for (const path of read) await call("read", { path });
        // The pages it read shimmer, as reading; what it only found does not.
        for (const path of read) {
          const row = sidebar.locator(`a.presence[data-path="${path}"][data-presence="reading"]`);
          await row.waitFor({ timeout: 5000 }).catch(() => {
            throw new Error(`${path} is not marked; ${said()}`);
          });
        }
        for (const path of unread) {
          if ((await sidebar.locator(`a.presence[data-path="${path}"]`).count()) > 0) {
            throw new Error(`${path}, only found by the search, shimmers`);
          }
        }
        const row = sidebar.locator(`a.presence[data-path="${other.path}"]`);
        const shimmer = await row.evaluate(
          (el) =>
            (
              globalThis as unknown as {
                getComputedStyle(e: unknown): { animationName: string };
              }
            ).getComputedStyle(el).animationName,
        );
        if (shimmer !== "tempra-shimmer") throw new Error(`the row's animation is "${shimmer}"`);
        // No words beside the name: the shimmer is the cue. A hover names the agent.
        const shown = (await row.innerText()).trim();
        if (shown !== other.title) throw new Error(`the row reads "${shown}", not its name`);
        const title = (await row.getAttribute("title")) ?? "";
        if (!/: Claude Code for @\w+ is reading$/.test(title)) {
          throw new Error(`the row's tooltip is "${title}"`);
        }
        if ((await byline.getByText(/reading/).count()) > 0) {
          throw new Error("the byline says the agent is reading");
        }
        if (shots) {
          await holdBand(true);
          await sidebar.screenshot({ path: `${shots}/presence-tree.png` });
          await holdBand(false);
        }
        // Closed, a folder holding a page being read shimmers its own name: no ring or dot.
        const folder = folderRow(top);
        await folder.locator("button.tree-name").click();
        await sidebar
          .locator(".tree-row.dir.presence button.tree-name[data-presence='reading']")
          .first()
          .waitFor({ timeout: 3000 });
        if (!(await folder.evaluate((el) => el.classList.contains("presence")))) {
          throw new Error(`the closed ${folderName(top)} does not shimmer`);
        }
        if ((await sidebar.locator(".presence-mark").count()) > 0) {
          throw new Error("a closed folder shows a mark beside its name");
        }
        if (shots) {
          await holdBand(true);
          await sidebar.screenshot({ path: `${shots}/presence-folder.png` });
          await holdBand(false);
        }
        // Opened mid-shimmer: the pages inside take it at once, and the open folder stops.
        await folder.locator("button.tree-name").click();
        for (const path of read.filter((p) => p.startsWith(`${top}/`))) {
          await sidebar.locator(`a.presence[data-path="${path}"]`).waitFor({ timeout: 1000 });
        }
        if (await folder.evaluate((el) => el.classList.contains("presence"))) {
          throw new Error(`the open ${folderName(top)} still shimmers`);
        }
        if ((await sidebar.locator(".tree-row.dir.open.presence").count()) > 0) {
          throw new Error("an open folder shimmers");
        }
        // Gone a few seconds after the agent stopped: PRESENCE_TTL_MS (app/src/presence.ts, 8 s)
        // after the last presence message for these pages, not after the gate starts looking,
        // and only these marks (an agent elsewhere in the library is not this check's business).
        const lastFor = Math.max(
          ...frames.filter((f) => f.paths.some((p) => read.includes(p))).map((f) => f.at),
        );
        const deadline = t0 + lastFor + 8000 + 4000;
        const ours = sidebar.locator(
          [
            ...read.map((p) => `a.presence[data-path="${p}"]`),
            `.tree-row.dir.presence button.tree-name[title^="${folderName(top)}: "]`,
          ].join(", "),
        );
        await ours
          .first()
          .waitFor({ state: "detached", timeout: Math.max(1, deadline - Date.now()) })
          .catch(async () => {
            const still = await sidebar
              .locator(".tree-row.presence a, .tree-row.dir.presence button.tree-name")
              .evaluateAll((els) =>
                els.map((el) => {
                  const e = el as unknown as { getAttribute(n: string): string | null };
                  return e.getAttribute("data-path") ?? e.getAttribute("title");
                }),
              );
            throw new Error(
              `still marked ${Date.now() - t0 - lastFor} ms after the last presence for the pages read (+${lastFor} ms): ${still.join(", ")}; ${said()}`,
            );
          });

        // A recording for review, with GATE_RECORD=1 (it needs Playwright's ffmpeg, which CI's
        // runners lack): the tree while the agent reads a page outside a closed folder and one
        // inside it, and the person opens the folder while it shimmers.
        if (shots && process.env.GATE_RECORD === "1") {
          const outside = pages.find((f) => !f.path.startsWith(`${top}/`));
          if (!outside) throw new Error("no page outside the folder to read");
          const videoDir = join(shots, "presence-video");
          mkdirSync(videoDir, { recursive: true });
          const size = { width: 1280, height: 720 };
          const rec = await b.browser.newContext({
            storageState: await b.context.storageState(),
            viewport: size,
            recordVideo: { dir: videoDir, size },
          });
          try {
            const p = await rec.newPage();
            await p.goto(`${lib}/${enc(other.path)}`);
            const side = p.locator("section.ws-sidebar");
            await side.locator(`a[data-path="${pagePath}"]`).waitFor({ timeout: 15_000 });
            const f = side
              .locator(".tree-row.dir")
              // Its title names the agent while it shimmers ("Computations: … in here").
              .filter({
                has: p.locator(
                  `button.tree-name:is([title="${folderName(top)}"], [title^="${folderName(top)}: "])`,
                ),
              })
              .first();
            await f.locator("button.tree-name").click();
            await p.waitForTimeout(800);
            await call("read", { path: outside.path });
            await p.waitForTimeout(400);
            await call("read", { path: nested });
            await side.locator(".tree-row.dir.presence").first().waitFor({ timeout: 3000 });
            await p.waitForTimeout(2600);
            await f.locator("button.tree-name").click();
            await side.locator(`a.presence[data-path="${nested}"]`).waitFor({ timeout: 2000 });
            await p.waitForTimeout(3000);
            await p.close();
            const video = await p.video()?.path();
            if (!video) throw new Error("no recording");
            await rec.close();
            copyFileSync(video, `${shots}/presence.webm`);
            // The sidebar alone, about 12 frames a second, one palette for the whole GIF.
            const gif = Bun.spawnSync([
              "/usr/bin/ffmpeg",
              "-y",
              "-loglevel",
              "error",
              "-i",
              video,
              "-vf",
              "fps=12,crop=264:720:0:0,split[a][b];[a]palettegen=stats_mode=diff[p];[b][p]paletteuse=dither=sierra2_4a",
              `${shots}/presence.gif`,
            ]);
            if (gif.exitCode !== 0)
              throw new Error(`ffmpeg: ${gif.stderr.toString().slice(0, 300)}`);
          } finally {
            await rec.close().catch(() => {});
          }
        }
      } finally {
        page.off("websocket", listen);
        await client.close();
      }
    });
    // Read history (TEMPRA-220, tempra-dev: v2/read-history): pointing at links in the tree loads
    // their pages ahead and counts no read; an agent reads a page over MCP, then the person opens
    // it, and it counts once for each: Properties says so in people's words, and MCP `read`
    // reports the reads by surface and by agent or person, never who.
    await step(
      "read history: Properties and MCP read report reads; hovering counts none",
      async () => {
        type Counts = { total: number; agents: number; people: number; mcp: number; app: number };
        type Reads = {
          week: Counts;
          month: Counts;
          last: { mcp: string | null; app: string | null };
          last_read: string | null;
        };
        const api = `/api/v1/libraries/${owner}/${slug}`;
        /** A page's reads, as the app's own GET sees them (a session's GET counts nothing). */
        const readsOf = async (p: string) =>
          (
            (await page.evaluate(`fetch("${api}/page/${enc(p)}").then((r) => r.json())`)) as {
              reads: Reads;
            }
          ).reads;
        await page.evaluate(`localStorage.removeItem("tempra:tree-closed:${owner}/${slug}")`);
        await page.goto(url);
        await main.locator(".body .prose").waitFor({ timeout: 15_000 });
        const rows = (
          await sidebar
            .locator("a[data-path]")
            .evaluateAll((els) => els.map((e) => e.getAttribute("data-path") ?? ""))
        ).filter((p) => p.endsWith(".md") && p !== pagePath && !p.startsWith("gate"));
        const target = rows[0];
        if (!target || rows.length < 3)
          throw new Error(`too few pages in the tree: ${rows.length}`);
        const hovered = rows.slice(0, 4);
        const before = new Map<string, Reads>();
        for (const p of hovered) before.set(p, await readsOf(p));
        // Pointing at links loads their pages ahead (80 ms, TEMPRA-193): no read is counted.
        for (const p of hovered) {
          await sidebar.locator(`a[data-path="${p}"]`).hover();
          await page.waitForTimeout(250);
        }
        await page.mouse.move(0, 0);
        await page.waitForTimeout(300);
        for (const p of hovered) {
          const now = await readsOf(p);
          if (now.month.total !== before.get(p)?.month.total) {
            throw new Error(`hovering ${p} counted reads: ${JSON.stringify(now.month)}`);
          }
        }
        // An agent reads it over MCP.
        const client = new Client({ name: "gate-reads", version: "1.0.0" });
        await client.connect(
          new StreamableHTTPClientTransport(new URL(`${base}/mcp`), {
            fetch,
            requestInit: { headers: { Authorization: `Bearer ${token}` } },
          }),
        );
        const mcpRead = async () => {
          const r = await client.callTool({
            name: "read",
            arguments: { library: `${owner}/${slug}`, path: target },
          });
          if (r.isError) throw new Error(`read: ${JSON.stringify(r.content).slice(0, 200)}`);
          const text = (r.content as { type: string; text?: string }[])
            .map((c) => c.text ?? "")
            .join("\n");
          return text.split("\n").find((l) => l.startsWith("reads: ")) ?? "";
        };
        try {
          const started = Date.now();
          const first = await mcpRead();
          if (!first) throw new Error("MCP read has no reads line");
          // The person opens it, from the tree (loaded ahead already).
          await sidebar.locator(`a[data-path="${target}"]`).click();
          await page.waitForURL((u) => decodeURIComponent(u.pathname).endsWith(`/${target}`));
          await main.locator(".body .prose").waitFor({ timeout: 15_000 });
          const was = before.get(target) as Reads;
          // Each reader counts once per page and day (TEMPRA-220): the gate's one person and its
          // agent may have read this page earlier today, so the counts are what they would be
          // with both of them among today's readers.
          const recent = (at: string | null | undefined) =>
            !!at && Date.parse(at) >= started - 2000;
          const deadline = Date.now() + 10_000;
          let got = await readsOf(target);
          while (!recent(got.last.app) && Date.now() < deadline) {
            await page.waitForTimeout(200);
            got = await readsOf(target);
          }
          const counted = (r: Reads, where: string) => {
            const w = r.week;
            if (
              !recent(r.last.app) ||
              !recent(r.last.mcp) ||
              w.people !== Math.max(was.week.people, 1) ||
              w.agents < Math.max(was.week.agents, 1) ||
              w.agents > was.week.agents + 1 ||
              w.total !== w.agents + w.people ||
              w.app < 1 ||
              w.mcp < 1
            ) {
              throw new Error(
                `reads ${where}: ${JSON.stringify(r)}, before ${JSON.stringify(was.week)}`,
              );
            }
          };
          counted(got, "after an agent's read and one open");
          // Opened again the same day: no more reads.
          await page.goto(url);
          await main.locator(".body .prose").waitFor({ timeout: 15_000 });
          await sidebar.locator(`a[data-path="${target}"]`).click();
          await page.waitForURL((u) => decodeURIComponent(u.pathname).endsWith(`/${target}`));
          await main.locator(".body .prose").waitFor({ timeout: 15_000 });
          await page.waitForTimeout(500);
          const again = await readsOf(target);
          counted(again, "after opening it again");
          if (again.week.total !== got.week.total) {
            throw new Error(`opening it again counted: ${got.week.total} then ${again.week.total}`);
          }
          // Page info's About this page, in people's words.
          await openInfo();
          const fact = (name: string) =>
            properties()
              .locator(".fact")
              .filter({ has: page.locator("dt", { hasText: new RegExp(`^${name}$`) }) })
              .locator("dd");
          const w = again.week;
          const times = `${w.total} time${w.total === 1 ? "" : "s"} this week`;
          const by = w.agents === w.total ? ", all by agents" : `, ${w.agents} by agents`;
          await fact("Read")
            .filter({ hasText: new RegExp(`^${times}${by}$`) })
            .waitFor({ timeout: 5000 })
            .catch(async () => {
              throw new Error(`Page info's Read says "${await fact("Read").innerText()}"`);
            });
          const last = await fact("Last read").innerText();
          if (last !== "just now") throw new Error(`Page info's Last read says "${last}"`);
          // The reads name no reader and no surface (Last changed still names the writer).
          const said = `${await fact("Read").innerText()} ${last}`;
          if (/\bmcp\b|\bapi\b|claude|@dev|human:/i.test(said)) {
            throw new Error(`Page info's reads name readers or surfaces: ${said}`);
          }
          if (shots) await properties().screenshot({ path: `${shots}/properties-reads.png` });
          await page.getByRole("button", { name: "Close page info" }).click();
          // MCP read reports both, by surface and by kind; the agent reading again that day adds
          // nothing.
          const line = await mcpRead();
          if (
            !line.startsWith(
              `reads: ${w.total} in 7 days (${w.agents} by agents, ${w.people} by people · `,
            ) ||
            !/ · mcp \d+, app \d+/.test(line) ||
            !/; last read .*just now \(mcp\)/.test(line) ||
            !/; last read .*just now \(app\)/.test(line)
          ) {
            throw new Error(`MCP read says "${line}"`);
          }
        } finally {
          await client.close();
        }
      },
    );
    // View Markdown, in ⋯, shows the file as stored, frontmatter first, with line numbers, in
    // place of the page; Back to page returns.
    await step("the Markdown view shows the file as stored", async () => {
      await page.goto(url);
      const body = page.locator(".body .prose");
      await body.waitFor({ timeout: 15_000 });
      await more("View Markdown");
      // In the URL (TEMPRA-134, C-16), with no contents beside it.
      await page.waitForURL((u) => u.searchParams.get("view") === "markdown");
      const stored = page.locator(".raw-markdown pre");
      await stored.waitFor({ timeout: 10_000 });
      const text = await stored.innerText();
      if (!text.startsWith("---\ntype:")) throw new Error(`markdown view: ${text.slice(0, 60)}`);
      if (await body.isVisible()) throw new Error("the reader still shows beside the markdown");
      if (await main.locator("h1.doc-title").isVisible()) {
        throw new Error("the page's title shows over the markdown");
      }
      const numbers = await page.locator(".raw-markdown .raw-line").count();
      if (numbers !== text.replace(/\n$/, "").split("\n").length) {
        throw new Error(`${numbers} line numbers for ${text.split("\n").length} lines`);
      }
      await page.locator(".raw-markdown").getByText(pagePath, { exact: true }).waitFor();
      if ((await contentsNav.count()) > 0) throw new Error("the contents show beside the markdown");
      // Download's glyph sits beside its word, not over it.
      const download = await page
        .locator(".raw-head")
        .getByRole("link", { name: "Download" })
        .boundingBox();
      if (!download || download.height > 40) {
        throw new Error(`Download stacks its glyph: ${JSON.stringify(download)}`);
      }
      if (shots) await page.screenshot({ path: `${shots}/markdown.png` });
      // Wrap lines: long lines wrap instead of scrolling.
      const wrap = page.getByRole("button", { name: "Wrap lines" });
      await wrap.click();
      if ((await wrap.getAttribute("aria-pressed")) !== "true") throw new Error("Wrap not pressed");
      const scrolls = await page.evaluate<boolean>(
        `(() => { const pre = document.querySelector(".raw-markdown pre"); return pre.scrollWidth > pre.clientWidth + 1; })()`,
      );
      if (scrolls) throw new Error("wrapped lines still scroll sideways");
      await wrap.click();
      // Reloaded, the view is still the Markdown; Back to page leaves it.
      await page.reload();
      await stored.waitFor({ timeout: 15_000 });
      await page.getByRole("button", { name: "Back to page" }).click();
      await body.waitFor({ state: "visible" });
      if (new URL(page.url()).searchParams.has("view"))
        throw new Error("the view stayed in the URL");
    });
    // The panels (tempra-dev: decisions/page-tools-in-the-corner, TEMPRA-283): one at a time in
    // place of the contents, opened from the page's corner row, closed by ×, Escape or the same
    // button, the contents back; a link with ?panel= opens one (history and properties open Page
    // info); none is remembered. Under 1100px a panel takes the contents' column, and under 960px
    // overlays the page. Copy page copies the stored file; the byline says an agent is editing.
    await step("panels: open and close, the contents come back, ?panel=, Copy page", async () => {
      const path = "gate-panels.md";
      const put = await fetch(`${libApi}/files/${path}`, {
        method: "PUT",
        headers: { ...bearer, "Content-Type": "text/markdown", "X-Note": "gate: panels" },
        body: [
          "---\ntype: Note\ntitle: Gate panels\ndescription: A page with contents.\n---",
          "## First\n\nOne.\n",
          "### Inside\n\nTwo.\n",
          "## Second\n\nThree.\n",
        ].join("\n"),
      });
      if (!put.ok) throw new Error(`write: ${put.status} ${await put.text()}`);
      const here = `${lib}/${path}`;
      await page.goto(here);
      await contentsNav.waitFor({ timeout: 15_000 });
      // Just written by an agent: the byline names it once, then "editing now" with the pulsing
      // dot (TEMPRA-131).
      await byline.getByText(/editing now$/).waitFor({ timeout: 5000 });
      await byline.locator(".change-dot.live").waitFor();
      if (shots) await page.screenshot({ path: `${shots}/page.png` });
      const entries = await contentsNav.locator("a").allInnerTexts();
      if (entries.join("|") !== "First|Inside|Second") throw new Error(`contents: ${entries}`);
      const back = async (what: string) => {
        await contentsNav.waitFor({ timeout: 5000 });
        if ((await page.locator("aside.page-aside").count()) > 0) {
          throw new Error(`a panel is still open after ${what}`);
        }
      };
      // The page's tools (TEMPRA-283): nothing in the top bar; a row in the right column's top
      // corner, right-aligned with the page, the contents below it; no floating +.
      if ((await sheetBar.getByRole("button", { name: /^Comments/ }).count()) > 0) {
        throw new Error("Comments is still in the top bar");
      }
      if ((await main.locator(".page-actions").count()) > 0) throw new Error("the + is back");
      const sideRow = main.locator(".page-tools-side");
      await sideRow.waitFor({ state: "visible", timeout: 5000 });
      const rowAt = await sideRow.boundingBox();
      const tocAt = await contentsNav.boundingBox();
      const viewport = page.viewportSize();
      if (!rowAt || !tocAt || !viewport || rowAt.x + rowAt.width < viewport.width - 24) {
        throw new Error(`the page's tools are not in the corner: ${JSON.stringify(rowAt)}`);
      }
      const named = await sideRow
        .getByRole("button")
        .evaluateAll((els) => els.map((e) => e.getAttribute("aria-label")));
      if (
        JSON.stringify(named) !==
        JSON.stringify(["Comments", "Page info", "Copy page", "More copy options"])
      ) {
        throw new Error(`the page's tools are ${JSON.stringify(named)}`);
      }
      if (shots) await page.screenshot({ path: `${shots}/page-tools.png` });
      const textX = async () => (await main.locator("article.doc").boundingBox())?.x ?? -1;
      const before = await textX();
      await openComments();
      await comments.waitFor({ timeout: 5000 });
      if ((await tool("comments").getAttribute("aria-pressed")) !== "true") {
        throw new Error("Comments is not pressed while its panel is open");
      }
      if ((await contentsNav.count()) > 0) throw new Error("the contents show beside a panel");
      // The card starts below the row: the row never overlaps it.
      const cardAt = await comments.boundingBox();
      if (!cardAt || cardAt.y < rowAt.y + rowAt.height) {
        throw new Error(`the card runs under the page's tools: ${JSON.stringify(cardAt)}`);
      }
      const after = await textX();
      if (Math.abs(after - before) > 1) {
        throw new Error(`opening a panel moved the text from ${before} to ${after}`);
      }
      // The panel starts a comment on the page itself.
      await comments.getByRole("button", { name: "Comment on the page…" }).waitFor();
      await comments.getByText("Or select text to comment on it").waitFor();
      await comments.getByText("No open threads.", { exact: true }).waitFor();
      await page.getByRole("button", { name: "Close comments" }).click();
      await back("×");
      // Page info, closed by ×, by Escape and by its own button; one panel at a time.
      await openInfo();
      await openComments();
      await comments.waitFor({ timeout: 5000 });
      if ((await page.locator("aside.page-aside").count()) !== 1) {
        throw new Error("two panels at once");
      }
      await openInfo();
      // About this page in people's words (TEMPRA-134, C-12, C-13): Status "not set", no lint
      // codes, suggested actions or path, and no For agents section (TEMPRA-144).
      await infoPanel
        .locator("dd", { hasText: /^not set$/ })
        .first()
        .waitFor();
      const heads = await infoPanel.locator(".page-info-section > h3").allInnerTexts();
      if (JSON.stringify(heads) !== JSON.stringify(["About this page", "Versions"])) {
        throw new Error(`Page info's sections: ${JSON.stringify(heads)}`);
      }
      const said = await infoPanel.innerText();
      if (/\b[a-z]+_[a-z_]+\b|→|suggested|trust|human-reviewed|unverified/.test(said)) {
        throw new Error(`Page info shows agents' words: ${said}`);
      }
      if ((await infoPanel.getByText(path, { exact: true }).count()) > 0) {
        throw new Error("Page info shows the page's path");
      }
      if (/for agents|nothing for agents/i.test(said)) {
        throw new Error("Page info has a For agents section");
      }
      if (shots) await page.screenshot({ path: `${shots}/page-info.png` });
      await page.getByRole("button", { name: "Close page info" }).click();
      await back("×");
      await openInfo();
      await page.keyboard.press("Escape");
      await back("Escape");
      await openInfo();
      await tool("info").click();
      await back("its own button");
      // A link asks for a panel; a page opened plainly has none (nothing is remembered).
      await openComments();
      await comments.waitFor({ timeout: 5000 });
      await page.goto(`${here}?panel=history`);
      await infoPanel.waitFor({ timeout: 15_000 });
      await page.goto(`${here}?panel=properties`);
      await infoPanel.waitFor({ timeout: 15_000 });
      await page.goto(here);
      await contentsNav.waitFor({ timeout: 15_000 });
      await page.waitForTimeout(300);
      await back("a plain reload");
      // Under 1100px of page the contents keep a narrower column of their own down to 700px
      // (TEMPRA-150), as Linear's docs do: at 1280px and at a 1000px window they are beside the
      // text, not On this page. Below that they hide (On this page under the byline). At 1280px a
      // panel takes their column and the text moves over for it: nothing runs under it
      // (TEMPRA-128, C-5).
      const inline = main.locator(".toc-inline");
      const besideText = async (where: string) => {
        await contentsNav.waitFor({ timeout: 5000 });
        if (await inline.isVisible()) throw new Error(`On this page shows ${where}`);
        const toc = await contentsNav.boundingBox();
        const text = await main.locator(".page-view .doc").boundingBox();
        if (!toc || !text || toc.x < text.x + text.width - 1) {
          throw new Error(`the contents are not beside the text ${where}`);
        }
      };
      await page.setViewportSize({ width: 1000, height: 720 });
      try {
        await besideText("at a 1000px window");
        if (shots) await page.screenshot({ path: `${shots}/contents-1000.png` });
        await page.setViewportSize({ width: 940, height: 720 });
        await contentsNav.waitFor({ state: "hidden", timeout: 5000 });
        await inline.locator("summary").waitFor({ timeout: 5000 });
      } finally {
        await wide();
      }
      await usual();
      try {
        await besideText("at 1280px");
        await openComments();
        await comments.waitFor({ timeout: 5000 });
        const position = () =>
          page.evaluate<string>(
            `getComputedStyle(document.querySelector("aside#panel-comments")).position`,
          );
        if ((await position()) === "fixed") throw new Error("the panel overlays at 1280px");
        await page.waitForTimeout(200);
        const box = await inline.boundingBox();
        const side = await comments.boundingBox();
        if (!box || !side || box.x + box.width > side.x + 1) {
          throw new Error(`On this page runs under the panel: ${JSON.stringify({ box, side })}`);
        }
        if (shots) await page.screenshot({ path: `${shots}/panel-1280.png` });
        // Narrower still, the panel overlays the page.
        await page.setViewportSize({ width: 1180, height: 720 });
        await page.waitForFunction(
          `getComputedStyle(document.querySelector("aside#panel-comments")).position === "fixed"`,
          undefined,
          { timeout: 5000 },
        );
        if (shots) await page.screenshot({ path: `${shots}/panel-narrow.png` });
        await page.keyboard.press("Escape");
        await comments.waitFor({ state: "detached", timeout: 5000 });
      } finally {
        await wide();
      }
      // Copy page, the corner row's split button (TEMPRA-283): the stored file, frontmatter and
      // body, on the clipboard; the top bar has no Copy page; its ⌄ holds View Markdown and
      // Download .md, and no Copy link.
      if ((await sheetBar.getByRole("button", { name: /^Copy page$/ }).count()) > 0) {
        throw new Error("Copy page is still in the top bar");
      }
      await b.context.grantPermissions(["clipboard-read", "clipboard-write"], { origin: base });
      await copyButton().click();
      await main.locator('.page-tools-side button[aria-label="Copied"]').waitFor({ timeout: 5000 });
      const copied = await page.evaluate<string>("navigator.clipboard.readText()");
      if (!copied.startsWith("---\ntype: Note\ntitle: Gate panels")) {
        throw new Error(`Copy page copied: ${copied.slice(0, 80)}`);
      }
      await copyMore().click();
      const items = page.locator(".menu-list");
      const offered = (await items.locator(".menu-item").allInnerTexts()).map((t) =>
        t.replace(/\s+/g, " ").trim(),
      );
      if (JSON.stringify(offered) !== JSON.stringify(["View Markdown", "Download .md"])) {
        throw new Error(`Copy page's ⌄ offers ${JSON.stringify(offered)}`);
      }
      const download = items.getByRole("link", { name: "Download .md" });
      if ((await download.getAttribute("download")) !== path) throw new Error("no Download .md");
      await page.keyboard.press("Escape");
      await items.waitFor({ state: "detached", timeout: 5000 });
      await agentDeletes(path);
    });
    await step(
      "Activity: By page follows an agent's write live with Working now, Every event lists it by seq and tails live, -/ledger opens it, Download is the ledger as JSON lines",
      async () => {
        await markStay();
        await sidebar
          .getByRole("navigation", { name: "Library" })
          .getByRole("link", { name: /^Activity/ })
          .click();
        await page.waitForURL(`${lib}/-/activity`);
        await main
          .getByRole("heading", { level: 1, name: "Activity", exact: true })
          .waitFor({ timeout: 15_000 });
        await main.locator("article.change-row").first().waitFor({ timeout: 10_000 });
        if (shots) await page.screenshot({ path: `${shots}/activity.png` });
        await page.waitForTimeout(500);
        await agentAppends(
          "A sentence for Activity.",
          "gate: an agent writes while Activity is open",
        );
        await main
          .locator("article.change-row", {
            hasText: "gate: an agent writes while Activity is open",
          })
          .first()
          .waitFor({ timeout: 10_000 });
        // The agent is writing now (Option B, TEMPRA-308): Working now names it with the pulsing
        // dot, its page's row has the dot too, and no row says when.
        const working = main.locator(".activity-working-list li").first();
        await working.waitFor({ timeout: 10_000 });
        if (!/is editing/.test(await working.innerText())) {
          throw new Error(`Working now: ${await working.innerText()}`);
        }
        if (!(await working.locator(".change-dot.live").count())) {
          throw new Error("Working now has no pulsing dot");
        }
        const written = main.locator("article.change-row.activity-page", {
          hasText: "gate: an agent writes while Activity is open",
        });
        if (!(await written.first().locator(".change-dot.live").count())) {
          throw new Error("the page being written has no pulsing dot on its row");
        }
        if (
          (await main.locator(".activity-day time, .activity-day .change-row-when").count()) > 0
        ) {
          throw new Error("Activity's rows say when");
        }
        if (
          (await main
            .locator(".activity-day")
            .getByText(/verified/i)
            .count()) > 0
        ) {
          throw new Error("Activity says verified, not checked");
        }
        if (shots) await page.screenshot({ path: `${shots}/activity-live.png` });
        if (!(await stayed())) throw new Error("the page reloaded");

        // Every event: the switch keeps the page, the table lists the agent's write by its seq,
        // the newest row pulses, and a new write joins the top live.
        await main.getByRole("button", { name: "Every event", exact: true }).click();
        await page.waitForURL(`${lib}/-/activity?view=events`);
        const rows = main.locator("table.events-table tbody tr");
        await rows.first().waitFor({ timeout: 15_000 });
        if (!(await stayed())) throw new Error("the switch reloaded the page");
        const stats = await fetch(`${base}/api/v1/libraries/${owner}/${slug}/stats`, {
          headers: auth,
        });
        const head = (await stats.json()) as { seq: number };
        const firstSeq = (await rows.first().locator(".events-seq").innerText()).replace(/\D/g, "");
        if (Number(firstSeq) !== head.seq) {
          throw new Error(`Every event starts at seq ${firstSeq}, the ledger is at ${head.seq}`);
        }
        if (!(await rows.first().innerText()).includes(pagePath)) {
          throw new Error(
            `the newest row is not the agent's write: ${await rows.first().innerText()}`,
          );
        }
        if (shots) await page.screenshot({ path: `${shots}/activity-events.png` });
        // Focus rings (TEMPRA-132): a field, then a button reached from it, show the 2px ring.
        const ringOn = async (what: string) => {
          const ring = await page.evaluate<string>(`(() => {
            const el = document.activeElement;
            // The filter is the design system's SearchField: its input draws the ring itself.
            const s = getComputedStyle(el);
            return el.matches(":focus-visible") + " " + s.outlineStyle + " " + s.outlineWidth;
          })()`);
          if (ring !== "true solid 2px") throw new Error(`${what}'s focus ring: ${ring}`);
        };
        await main.getByLabel("Filter by path or note").focus();
        await ringOn("a text field");
        if (shots) await page.screenshot({ path: `${shots}/focus-field.png` });
        // By keyboard (a click or a script does not show the ring): Tab on to the next pill.
        for (let i = 0; i < 6; i++) {
          await page.keyboard.press("Tab");
          const pill = await page.evaluate<boolean>(
            `!!document.activeElement?.matches("button, a.button")`,
          );
          if (pill) break;
        }
        await ringOn("a button");
        if (shots) await page.screenshot({ path: `${shots}/focus-button.png` });
        await page.evaluate("document.activeElement?.blur()");
        await page.waitForTimeout(500);
        await agentAppends(
          "A sentence for the live ledger.",
          "gate: a write while the ledger is open",
        );
        await main
          .locator("table.events-table tbody tr", {
            hasText: "gate: a write while the ledger is open",
          })
          .first()
          .waitFor({ timeout: 10_000 });
        if (!(await rows.first().locator(".change-dot.live").count())) {
          throw new Error("the newest row does not pulse");
        }
        // The filters: a kind that matches nothing empties the table; Any kind brings it back.
        await main.getByRole("combobox", { name: "Kind" }).selectOption("revert");
        await page.waitForURL(`${lib}/-/activity?view=events&kind=revert`);
        await main
          .getByText(/^No events match( in the latest \d+ requests?)?\.$/)
          .waitFor({ timeout: 5000 });
        await main.getByRole("combobox", { name: "Kind" }).selectOption("");
        await rows.first().waitFor({ timeout: 5000 });
        if (!(await stayed())) throw new Error("the page reloaded");

        // Download: the ledger as JSON lines, every event, the newest included.
        const download = main.getByRole("link", { name: "Download" });
        const href = await download.getAttribute("href");
        if (href !== `/${owner}/${slug}/-/ledger.jsonl`) throw new Error(`Download: ${href}`);
        const jsonl = await ui(`${base}${href}`);
        const lines = (await jsonl.text()).trimEnd().split("\n");
        if (jsonl.status !== 200 || lines.length < head.seq) {
          throw new Error(`ledger.jsonl: ${jsonl.status}, ${lines.length} lines`);
        }
        const last = JSON.parse(lines.at(-1) ?? "{}") as { t?: string; seq?: number };
        if (last.t !== "event" || (last.seq ?? 0) <= head.seq) {
          throw new Error(`ledger.jsonl ends with ${lines.at(-1)}`);
        }

        // The ledger's address opens Every event; the switch goes back to By page.
        await page.goto(`${lib}/-/ledger`);
        await rows.first().waitFor({ timeout: 15_000 });
        const pressed = main.getByRole("button", { name: "Every event", exact: true });
        if ((await pressed.getAttribute("aria-pressed")) !== "true") {
          throw new Error("-/ledger does not open Every event");
        }
        await markStay();
        await main.getByRole("button", { name: "By page", exact: true }).click();
        await page.waitForURL(`${lib}/-/activity`);
        await main.locator("article.change-row").first().waitFor({ timeout: 10_000 });
        if (!(await stayed())) throw new Error("the switch reloaded the page");
      },
    );
    // TEMPRA-80: normal use never comes near the session's limit. A minute of someone skimming
    // within the app: every folder opened, every file hovered (a prefetch each), file after file
    // opened with a glance at each, Activity and back, while an agent writes (the tree's refresh,
    // the feed's catch-up, the open page's reloads). That minute must stay under a quarter of the
    // limit. The busiest minute of the whole run is reported too, and must stay under half: it is
    // the gate's own full page loads, one after another, which nobody does by hand.
    await step(
      "a busy minute of browsing stays under a quarter of the session's limit",
      async () => {
        const t0 = Date.now();
        const perOpen: string[][] = [];
        for (let pass = 0; pass < 4; pass++) {
          // Folders in the tree (not the library's or the person's menus).
          const closed = sidebar
            .getByRole("navigation", { name: "Files" })
            .locator('button[aria-expanded="false"]');
          const n = await closed.count();
          if (n === 0) break;
          for (let i = n - 1; i >= 0; i--) await closed.nth(i).click();
        }
        const files = sidebar.locator("a[data-path$='.md']");
        const titles = await files.evaluateAll((els) =>
          els.map((e) => e.getAttribute("data-path")),
        );
        let opened = 0;
        while (Date.now() - t0 < 60_000) {
          for (const title of titles) {
            await sidebar.locator(`a[data-path="${title}"]`).hover();
            await page.waitForTimeout(80);
          }
          for (const title of titles) {
            if (Date.now() - t0 >= 60_000) break;
            const at = Date.now();
            await sidebar.locator(`a[data-path="${title}"]`).click();
            await page.locator(".body .prose").first().waitFor({ timeout: 15_000 });
            // Skimming: a glance at each (someone reading opens one every several seconds).
            await page.waitForTimeout(1500);
            // What an open costs while no agent writes (the opens before an agent's write).
            if (opened % 4 !== 3) perOpen.push(b.requestsBetween(at));
            if (++opened % 4 === 0) await agentAppends(`A busy reader's sentence ${opened}.`);
          }
          await sidebar
            .getByRole("navigation", { name: "Library" })
            .getByRole("link", { name: /^Activity/ })
            .click();
          await main.locator("article.change-row").first().waitFor({ timeout: 15_000 });
          await page.goBack();
        }
        await page.waitForTimeout(2000); // the feed's catch-up and the tree's refresh settle
        const busy = b.busiestMinute(t0);
        const run = b.busiestMinute();
        const pct = (n: number) => Math.round((100 * n) / SESSION_REQUESTS_PER_MINUTE);
        // TEMPRA-103: what opening a page from the tree costs, once it has been seen before.
        const counts = perOpen.map((r) => r.length).sort((x, y) => x - y);
        const median = counts[Math.floor(counts.length / 2)] ?? 0;
        const sample = perOpen.find((r) => r.length === median) ?? [];
        console.log(
          `  opening a page from the tree: median ${median} requests (${counts[0] ?? 0} to ${counts.at(-1) ?? 0} over ${counts.length} opens)\n    ${sample.join(", ")}`,
        );
        console.log(
          `  a busy minute of browsing (${opened} files opened): ${busy.peak} requests, ${pct(busy.peak)}% of the session limit (${SESSION_REQUESTS_PER_MINUTE}/min)\n    ${busy.what.slice(0, 12).join(", ")}\n  the run's busiest minute (full page loads): ${run.peak} requests, ${pct(run.peak)}%\n    ${run.what.slice(0, 12).join(", ")}`,
        );
        if (busy.peak * 4 > SESSION_REQUESTS_PER_MINUTE) {
          throw new Error(
            `${busy.peak} requests in a minute of browsing is over a quarter of the session limit (${SESSION_REQUESTS_PER_MINUTE})`,
          );
        }
        if (run.peak * 2 > SESSION_REQUESTS_PER_MINUTE) {
          throw new Error(
            `${run.peak} requests in the run's busiest minute is over half the session limit (${SESSION_REQUESTS_PER_MINUTE})`,
          );
        }
      },
    );
    await step("reader images: the page of figures goes", async () => {
      for (const path of [imagesPage, ...imagePaths]) await agentDeletes(path);
    });
    // axe (TEMPRA-133): the gate's pages, light and dark, a page with its Comments panel, and
    // the phone's drawer and sheet, with no serious or critical issue. After the busy minute, so
    // its loads are not counted there.
    await step("axe: no serious or critical issues on the app's pages", async () => {
      const found = await axePages(page, [
        { name: "home", url: `${lib}/`, ready: () => home() },
        {
          name: "page",
          url: `${lib}/gate-keys.md`,
          ready: () => main.locator(".body .prose").waitFor({ timeout: 15_000 }),
        },
        {
          name: "page, Comments",
          url: `${lib}/gate-keys.md?panel=comments`,
          ready: () => comments.getByText("Gate: from the keyboard.").waitFor({ timeout: 15_000 }),
        },
        {
          name: "page, Page info",
          url: `${lib}/gate-keys.md?panel=info`,
          ready: () => infoPanel.waitFor({ timeout: 15_000 }),
        },
        {
          name: "Activity",
          url: `${lib}/-/activity`,
          ready: () => main.locator("article.change-row").first().waitFor({ timeout: 15_000 }),
        },
        {
          name: "Every event",
          url: `${lib}/-/ledger`,
          ready: () => main.locator("table").first().waitFor({ timeout: 15_000 }),
        },
        {
          name: "Settings",
          url: `${lib}/-/settings`,
          ready: () =>
            main
              .getByRole("heading", { level: 2, name: "Members", exact: true })
              .waitFor({ timeout: 15_000 }),
        },
        {
          name: "libraries",
          url: `${base}/`,
          ready: () => main.locator("h1").first().waitFor({ timeout: 15_000 }),
        },
        {
          name: "Invitations",
          url: `${base}/invitations`,
          ready: () => main.locator("h1").first().waitFor({ timeout: 15_000 }),
        },
        {
          name: "Account",
          url: `${base}/account`,
          ready: () => main.locator("h1").first().waitFor({ timeout: 15_000 }),
        },
        {
          name: "Agents",
          url: `${base}/agents`,
          ready: () => main.locator("h1").first().waitFor({ timeout: 15_000 }),
        },
        {
          name: "page, dark",
          url: `${lib}/gate-keys.md`,
          dark: true,
          ready: () => main.locator(".body .prose").waitFor({ timeout: 15_000 }),
        },
        {
          name: "home, phone drawer",
          url: `${lib}/`,
          phone: true,
          ready: async () => {
            await home();
            await page.locator("button.ws-menu").click();
            await page.locator("section.ws-sidebar.open").waitFor({ timeout: 5000 });
          },
        },
        {
          name: "page, phone sheet",
          url: `${lib}/gate-keys.md`,
          phone: true,
          ready: async () => {
            await main.locator(".body .prose").waitFor({ timeout: 15_000 });
            await openComments();
            await comments.waitFor({ timeout: 5000 });
          },
        },
      ]);
      await wide();
      if (found.length > 0) throw new Error(`axe: ${found.join("; ")}`);
    });
  } finally {
    await b.close();
  }
  return problems;
}

/**
 * Sets the signed-in account's theme to System and reloads, so the page follows the scheme the
 * gate emulates: an account that never chose is dark (TEMPRA-285).
 */
async function followSystem(page: import("playwright-core").Page) {
  if ((await page.locator("html:not([data-theme])").count()) > 0) return;
  // As a person does, from the avatar's menu; the choice is saved on the account.
  const account = page.locator(".menu-list.account");
  await page.getByRole("button", { name: "Account menu" }).click();
  const saved = page.waitForResponse(
    (r) => r.url().endsWith("/api/v1/account") && r.request().method() === "PATCH",
    { timeout: 15_000 },
  );
  await account.getByRole("button", { name: "System", exact: true }).click();
  if ((await saved).status() !== 200) throw new Error("setting the theme to System failed");
  await page.keyboard.press("Escape");
  await account.waitFor({ state: "detached", timeout: 5000 });
  await page.reload();
  await page.locator("html:not([data-theme])").waitFor({ timeout: 15_000 });
}

/** A page for axe: where it is, what shows it is ready, and how it is seen. */
interface AxePage {
  name: string;
  url: string;
  ready(): Promise<unknown>;
  dark?: boolean;
  phone?: boolean;
}

/**
 * Runs axe-core over each page and returns its serious and critical violations, one line each
 * (rule, impact, the first elements). axe is evaluated into the page through the DevTools
 * protocol, which the app's CSP (`script-src 'self'`) does not govern; nothing is added to the
 * page's own scripts.
 */
async function axePages(page: import("playwright-core").Page, pages: AxePage[]) {
  const source = await Bun.file(Bun.resolveSync("axe-core/axe.min.js", import.meta.dir)).text();
  const found: string[] = [];
  for (const p of pages) {
    await page.setViewportSize(
      p.phone ? { width: 390, height: 844 } : { width: 1600, height: 900 },
    );
    await page.emulateMedia({ colorScheme: p.dark ? "dark" : "light" });
    await page.goto(p.url);
    await p.ready();
    await page.waitForTimeout(400);
    await page.evaluate(source);
    const violations = await page.evaluate<{ id: string; impact: string; nodes: string[] }[]>(`
      axe
        .run(document, { resultTypes: ["violations"] })
        .then((r) =>
          r.violations
            .filter((v) => v.impact === "serious" || v.impact === "critical")
            .map((v) => ({
              id: v.id,
              impact: v.impact,
              nodes: v.nodes.slice(0, 3).map((n) => n.target.join(" ")),
            })),
        )`);
    for (const v of violations) {
      found.push(`${p.name}: ${v.id} (${v.impact}) at ${v.nodes.join(", ")}`);
    }
  }
  await page.emulateMedia({ colorScheme: null });
  return found;
}

/**
 * The upload link (TEMPRA-196): an agent prepares an upload, the person opens its page signed in,
 * chooses the file in Chromium and sends it; the file is the agent's write, supplied by them, the
 * link works once, and the page passes axe in light and dark.
 */
async function uploadLink(owner: string, slug: string, token: string): Promise<string[]> {
  const lib = `${base}/api/v1/libraries/${owner}/${slug}`;
  const path = "gate-upload/photo.png";
  const png = greyPng(40, 30, 120);
  const prep = await fetch(`${lib}/uploads`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      path,
      size: png.length,
      description: "A grey photo for the gate.",
      note: "Gate: the upload link",
    }),
  });
  if (prep.status !== 201) return [`prepare: ${prep.status} ${await prep.text()}`];
  const { upload_page: link } = (await prep.json()) as { upload_page?: string };
  if (!link) return ["prepare returned no upload_page"];
  const b = await openBrowser();
  if (typeof b === "string") return [b];
  const { page, step, problems } = b;
  const heading = (name: string) =>
    page.getByRole("heading", { level: 1, name }).waitFor({ timeout: 15_000 });
  try {
    await step("signed out, the link signs in and comes back to the page", async () => {
      await b.signInAs("dev@localhost", new URL(link).pathname);
      await heading("Upload a file");
      await page.getByText("gate-upload/photo.png").waitFor({ timeout: 5000 });
    });
    await step("the page is dark with the system light, and passes axe", async () => {
      // A server page has no account to choose by: dark, whatever the system (TEMPRA-285).
      const ready = async () => {
        await heading("Upload a file");
        await page.locator('html[data-theme="dark"]').waitFor({ timeout: 5000 });
      };
      const found = await axePages(page, [{ name: "upload page", url: link, ready }]);
      if (found.length > 0) throw new Error(found.join("; "));
    });
    await step("the person chooses the file and uploads it", async () => {
      await page.getByLabel("File").setInputFiles({
        name: "photo.png",
        mimeType: "image/png",
        buffer: Buffer.from(png),
      });
      await page.getByRole("button", { name: "Upload" }).click();
      await heading("Uploaded");
    });
    await step("the file is the agent's write, supplied by the person", async () => {
      const r = await fetch(`${lib}/files/${path}`, {
        headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
      });
      const f = (await r.json()) as { size?: number; supplied_by?: string };
      if (f.size !== png.length || f.supplied_by !== "dev") {
        throw new Error(`the file reads ${JSON.stringify(f)}`);
      }
    });
    // Beside the browser, whose watcher counts every 4xx as a problem.
    await step("the link works once", async () => {
      const r = await fetch(link, { headers: { Cookie: await b.cookie() }, redirect: "manual" });
      const html = await r.text();
      if (r.status !== 410 || !html.includes("Link expired")) {
        throw new Error(`a spent link answers ${r.status}`);
      }
    });
  } finally {
    await b.close();
  }
  return problems;
}

/**
 * The library's managed agent, @tempra (TEMPRA-222), end to end on the scripted stand-in model
 * (AGENT_MODEL=fake in the gate's .dev.vars; no network): the seeded account has it on. A mention
 * on a page goes through the agent's queue: the Comments panel says "Tempra is replying…", then
 * shows its reply, by Tempra's own round mark on the agent colour, and the thread stays open
 * (TEMPRA-223: people resolve threads); a library thread from the home's "+" asking for a new
 * page, sent with Enter, is answered and marked a request, which MCP `work` lists. The home's
 * Comments panel passes axe.
 */
async function managedAgent(owner: string, slug: string, token: string): Promise<string[]> {
  const shots = process.env.GATE_SCREENSHOTS;
  const lib = `${base}/api/v1/libraries/${owner}/${slug}`;
  const headers = { Authorization: `Bearer ${token}` };
  const members = (await (await fetch(`${lib}/members`, { headers })).json()) as {
    agents?: string[];
  };
  if (!members.agents?.includes("tempra")) {
    return [`the members list offers no @tempra: ${JSON.stringify(members.agents)}`];
  }
  const outline = (await (await fetch(`${lib}/outline`, { headers })).json()) as {
    files: { path: string; kind: string }[];
  };
  const pagePath = outline.files.find((f) => f.kind === "page")?.path;
  if (!pagePath) return ["no page to comment on"];
  const b = await openBrowser();
  if (typeof b === "string") return [b];
  const { page, step, problems } = b;
  const comments = page.locator("#panel-comments");
  /**
   * Comment from the corner's Comments (TEMPRA-283; on the home, its own corner): the box at the
   * panel's top, the text, sent by the Comment button or by Enter (TEMPRA-223).
   */
  const comment = async (box: string, text: string, send: "click" | "enter") => {
    if ((await comments.count()) === 0) {
      await page
        .locator('.page-tools [data-panel="comments"]')
        .filter({ visible: true })
        .first()
        .click();
    }
    await comments.getByRole("button", { name: box }).click();
    const field = comments.locator(".comment-form textarea");
    await field.fill(text);
    if (send === "enter") await field.press("Enter");
    else await comments.locator(".comment-form").getByRole("button", { name: "Comment" }).click();
  };
  try {
    await step("a mention on a page: Tempra is replying…, then its reply", async () => {
      await b.signInAs("dev@localhost", `/${owner}/${slug}/${pagePath}`);
      await page.locator(".doc-title").waitFor({ timeout: 15_000 });
      // The system's theme (dark is the default, TEMPRA-285), so the light and dark screenshots
      // and axe passes below see the scheme they emulate.
      await followSystem(page);
      await page.locator(".doc-title").waitFor({ timeout: 15_000 });
      await comment("Comment on the page…", "@tempra what does this page say?", "click");
      await comments
        .locator(".thread-replying", { hasText: "Tempra is replying…" })
        .first()
        .waitFor({ timeout: 15_000 });
      await comments.getByText("A stand-in answer").waitFor({ timeout: 30_000 });
      await comments.locator(".thread-replying").waitFor({ state: "detached", timeout: 10_000 });
    });
    await step("its reply is by Tempra's own mark, and the thread stays open", async () => {
      // Its comment carries Tempra's round mark: a T on the agent colour (TEMPRA-223).
      const said = comments.locator(".said", { hasText: "A stand-in answer" });
      const mark = said.locator(".said-by .avatar-mark.agent.tempra");
      await mark.waitFor({ timeout: 5000 });
      if (
        (await mark.innerText()).trim() !== "T" ||
        (await mark.getAttribute("aria-hidden")) !== "true"
      ) {
        throw new Error(`Tempra's mark reads ${JSON.stringify(await mark.innerText())}`);
      }
      // Its fill is the agent colour, read against the token itself (a script string: this file
      // has no DOM types).
      const [fill, agentColour] = await page.evaluate<string[]>(`(() => {
        const el = document.querySelector("#panel-comments .avatar-mark.agent.tempra");
        const probe = document.createElement("span");
        el.after(probe);
        probe.style.backgroundColor = "var(--tempra-color-agent)";
        const fill = getComputedStyle(el).backgroundColor;
        const want = getComputedStyle(probe).backgroundColor;
        probe.remove();
        return [fill, want];
      })()`);
      const plain = await page.evaluate<string>(`(() => {
        const el = document.querySelector("#panel-comments .avatar-mark");
        const probe = document.createElement("span");
        probe.className = "avatar-mark agent";
        el.after(probe);
        const c = getComputedStyle(probe).backgroundColor;
        probe.remove();
        return c;
      })()`);
      if (!fill || fill !== agentColour || fill === plain) {
        throw new Error(`Tempra's mark is filled ${fill}, not the agent colour (${agentColour})`);
      }
      // The person's own comment has their mark beside it too.
      await comments.locator(".said .avatar-mark:not(.agent)").first().waitFor({ timeout: 5000 });
      if (shots) {
        await page.screenshot({ path: `${shots}/tempra-reply.png` });
        await page.emulateMedia({ colorScheme: "dark" });
        await page.waitForTimeout(200);
        await page.screenshot({ path: `${shots}/tempra-reply-dark.png` });
        await page.emulateMedia({ colorScheme: "light" });
      }
      // It replied and did not resolve: the thread is still under Open, and open in the API.
      await page.waitForTimeout(1500);
      const card = comments.locator("section.thread.open", { hasText: "A stand-in answer" });
      await card.waitFor({ timeout: 5000 });
      if (await card.evaluate((el) => el.classList.contains("resolved"))) {
        throw new Error("the agent's thread was resolved");
      }
      await card.getByRole("button", { name: "Resolve" }).waitFor({ timeout: 5000 });
      const open = (await (
        await fetch(`${lib}/comments?path=${encodeURIComponent(pagePath)}&status=open`, { headers })
      ).json()) as { threads: { comments: { body: string }[] }[] };
      if (
        !open.threads.some((t) => t.comments.some((c) => c.body.startsWith("A stand-in answer")))
      ) {
        throw new Error("the agent's thread is not open");
      }
    });
    await step(
      "a library thread from the home's corner: answered and marked a request",
      async () => {
        await page.goto(`${base}/${owner}/${slug}/`);
        await page.locator(".home-head .view-title").waitFor({ timeout: 15_000 });
        // The home's corner holds Comments alone (TEMPRA-283), and no +.
        const tools = await page
          .locator(".home-head .page-tools button")
          .evaluateAll((els) => els.map((e) => e.getAttribute("data-panel")));
        if (JSON.stringify(tools) !== JSON.stringify(["comments"])) {
          throw new Error(`the home's corner holds ${JSON.stringify(tools)}`);
        }
        if ((await page.locator(".page-actions").count()) > 0)
          throw new Error("the home's + is back");
        await comment(
          "Comment on the library…",
          "@tempra request: a new page on onboarding",
          "enter",
        );
        await comments
          .locator(".thread-replying", { hasText: "Tempra is replying…" })
          .first()
          .waitFor({ timeout: 15_000 });
        await comments.getByText("marked this thread a request").waitFor({ timeout: 30_000 });
        await comments.locator(".thread-request", { hasText: "Request" }).first().waitFor();
      },
    );
    await step("the request is listed by MCP work", async () => {
      const client = new Client({ name: "gate-agent", version: "1.0.0" });
      await client.connect(
        new StreamableHTTPClientTransport(new URL(`${base}/mcp`), {
          fetch,
          requestInit: { headers },
        }),
      );
      const r = await client.callTool({
        name: "work",
        arguments: { library: `${owner}/${slug}`, kind: "request" },
      });
      const text = (r.content as { type: string; text?: string }[]).map((c) => c.text).join("\n");
      await client.close();
      if (!text.includes("[request] (the library)") || !text.includes("a new page on onboarding")) {
        throw new Error(`work lists: ${text.slice(0, 400)}`);
      }
    });
    await step("the home's Comments panel passes axe, light and dark", async () => {
      const url = `${base}/${owner}/${slug}/?panel=comments`;
      const ready = () => comments.getByRole("heading", { name: "Comments" }).waitFor();
      const found = await axePages(page, [
        { name: "home's comments", url, ready },
        { name: "home's comments (dark)", url, ready, dark: true },
      ]);
      if (found.length > 0) throw new Error(found.join("; "));
    });
  } finally {
    await b.close();
  }
  return problems;
}

/**
 * The upload panel (TEMPRA-200): reads the panel and calls prepare_upload over MCP as an agent's
 * host does, then drives the panel in Chromium from a host made of ext-apps' AppBridge
 * (scripts/panel-host.ts), in a sandboxed iframe under the CSP its `_meta.ui` declares: the
 * panel shows the upload, sends the chosen file across origins to /ul/, and tells the chat; the
 * file is the agent's write, supplied by the person.
 */
async function uploadPanel(token: string): Promise<string[]> {
  const client = new Client({ name: "gate", version: "1.0.0" });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(`${base}/mcp`), {
      fetch,
      requestInit: { headers: { Authorization: `Bearer ${token}` } },
    }),
  );
  const path = "gate-upload/panel.png";
  const png = greyPng(30, 20, 90);
  let html: string;
  let csp: { connectDomains?: string[] };
  let result: Record<string, unknown>;
  const args = { path, size: png.length, description: "A grey photo, from the panel." };
  try {
    const read = await client.readResource({ uri: "ui://tempra/upload" });
    const content = read.contents[0] as {
      text?: string;
      _meta?: { ui?: { csp?: { connectDomains?: string[] } } };
    };
    html = content.text ?? "";
    csp = content._meta?.ui?.csp ?? {};
    if (!csp.connectDomains?.includes(base)) {
      return [`the panel declares connect domains ${JSON.stringify(csp.connectDomains)}`];
    }
    result = (await client.callTool({ name: "prepare_upload", arguments: args })) as Record<
      string,
      unknown
    >;
  } finally {
    await client.close();
  }
  const hostJs = await Bun.build({
    entrypoints: [join(import.meta.dir, "panel-host.ts")],
    target: "browser",
    minify: true,
  });
  if (!hostJs.success || !hostJs.outputs[0]) return [`panel host: ${hostJs.logs.join("; ")}`];
  const hostCode = await hostJs.outputs[0].text();
  const b = await openBrowser();
  if (typeof b === "string") return [b];
  const { page, step, problems } = b;
  const panel = page.frameLocator('iframe[title="Upload panel"]');
  const shots = process.env.GATE_SCREENSHOTS;
  const shoot = (name: string) =>
    shots ? page.screenshot({ path: `${shots}/${name}.png` }) : Promise.resolve();
  try {
    await step("the host draws the panel with the prepared upload", async () => {
      await page.setContent(`<!doctype html><html><body></body></html>`);
      await page.addScriptTag({ content: hostCode, type: "module" });
      await page.waitForFunction('typeof window.startPanel === "function"');
      const call = [html, csp, args, result].map((v) => JSON.stringify(v)).join(", ");
      await page.evaluate(`window.startPanel(${call})`);
      await panel.getByRole("heading", { name: "Upload a file" }).waitFor({ timeout: 15_000 });
      await panel.getByText(path).waitFor({ timeout: 5000 });
      await shoot("upload-panel");
    });
    await step("the person chooses the file; it crosses origins to /ul/", async () => {
      await panel.locator("input[type=file]").setInputFiles({
        name: "panel.png",
        mimeType: "image/png",
        buffer: Buffer.from(png),
      });
      await panel
        .locator(".status", { hasText: "Uploaded panel.png" })
        .waitFor({ timeout: 15_000 });
      // Done: the drop area goes, so nothing invites a second upload on a spent link.
      await panel.locator(".drop").waitFor({ state: "hidden", timeout: 5000 });
      await shoot("upload-panel-done");
    });
    await step(
      "the chat is told, and the file is the agent's write supplied by the person",
      async () => {
        const said = await page.evaluate<string[]>("window.panelMessages");
        if (!said.some((m) => m.startsWith("I uploaded panel.png") && m.includes(path))) {
          throw new Error(`the chat heard ${JSON.stringify(said)}`);
        }
        const r = await fetch(`${base}/api/v1/libraries/dev/mcp/files/${path}`, {
          headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
        });
        const f = (await r.json()) as { size?: number; supplied_by?: string };
        if (f.size !== png.length || f.supplied_by !== "dev") {
          throw new Error(`the file reads ${JSON.stringify(f)}`);
        }
      },
    );
  } finally {
    await b.close();
  }
  return problems;
}

/**
 * The page panel (tempra-dev app/page-panel): an agent writes a page with an image, a diagram, a
 * footnote and links, then `show`s it; the gate's host (scripts/panel-host.ts) draws the panel
 * under the CSP its `_meta.ui` declares. The page reads as the app draws it: the title, the
 * byline, the image from its signed link, the diagram drawn, Inter loaded, the sources; nothing to
 * press, and no link to another library page.
 */
async function pagePanel(token: string): Promise<string[]> {
  // Run in the panel's frame (another origin), so with Playwright's element handles; this file has
  // no DOM types, so the page's objects are typed loosely here.
  // biome-ignore lint/suspicious/noExplicitAny: the panel's DOM, untyped in this file.
  type Dom = any;
  const client = new Client({ name: "gate", version: "1.0.0" });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(`${base}/mcp`), {
      fetch,
      requestInit: { headers: { Authorization: `Bearer ${token}` } },
    }),
  );
  const text = (r: unknown) =>
    ((r as { content?: { type: string; text?: string }[] }).content ?? [])
      .map((c) => c.text ?? "")
      .join("\n");
  const args = { path: "gate-page/margin.md" };
  let html: string;
  let csp: { resourceDomains?: string[] };
  let result: Record<string, unknown>;
  try {
    const png = greyPng(60, 40, 120);
    const prep = await client.callTool({
      name: "prepare_upload",
      arguments: { path: "gate-page/margin-chart.png" },
    });
    const url = (prep.structuredContent as { upload: { url: string } }).upload.url;
    const put = await fetch(url, {
      method: "PUT",
      body: png,
      headers: { "Content-Type": "image/png" },
    });
    if (!put.ok) return [`the page's image: ${put.status} ${await put.text()}`];
    const page = await client.callTool({
      name: "write",
      arguments: {
        path: args.path,
        content: [
          "---",
          "type: Metric",
          "title: Margin",
          "description: Gross margin, as we report it.",
          "status: draft",
          "sources:",
          "  - id: book",
          "    title: The finance book",
          "    resource: https://example.com/book",
          "---",
          "Margin is revenue minus the cost of goods, over revenue.[^book] See [costs](/gate-page/costs.md) and [the web](https://example.com/).",
          "",
          '![A grey chart](/gate-page/margin-chart.png "Margin by month")',
          "",
          "```mermaid",
          "flowchart LR",
          "  R[Revenue] --> M[Margin]",
          "  C[Costs] --> M",
          "```",
          "",
        ].join("\n"),
        note: "gate: a page to show",
      },
    });
    if (page.isError) return [`writing margin.md: ${text(page)}`];
    const read = await client.readResource({ uri: "ui://tempra/page" });
    const content = read.contents[0] as {
      text?: string;
      _meta?: { ui?: { csp?: { resourceDomains?: string[] } } };
    };
    html = content.text ?? "";
    csp = content._meta?.ui?.csp ?? {};
    if (!csp.resourceDomains?.includes(base)) {
      return [`the page panel declares resource domains ${JSON.stringify(csp.resourceDomains)}`];
    }
    result = (await client.callTool({ name: "show", arguments: args })) as Record<string, unknown>;
    if (result.isError) return [`show: ${text(result)}`];
  } finally {
    await client.close();
  }
  const hostJs = await Bun.build({
    entrypoints: [join(import.meta.dir, "panel-host.ts")],
    target: "browser",
    minify: true,
  });
  if (!hostJs.success || !hostJs.outputs[0]) return [`panel host: ${hostJs.logs.join("; ")}`];
  const hostCode = await hostJs.outputs[0].text();
  const b = await openBrowser();
  if (typeof b === "string") return [b];
  const { page, step, problems } = b;
  const panel = page.frameLocator('iframe[title="Page panel"]');
  const shots = process.env.GATE_SCREENSHOTS;
  try {
    await step("the host draws the page as the app does: head, image, diagram, Inter", async () => {
      await page.setViewportSize({ width: 900, height: 1000 });
      await page.setContent("<!doctype html><html><body></body></html>");
      await page.addScriptTag({ content: hostCode, type: "module" });
      await page.waitForFunction('typeof window.startPanel === "function"');
      const frame = { title: "Page panel", width: 760, height: 900 };
      const call = [html, csp, args, result, frame].map((v) => JSON.stringify(v)).join(", ");
      await page.evaluate(`window.startPanel(${call})`);
      await panel.getByRole("heading", { name: "Margin", level: 1 }).waitFor({ timeout: 15_000 });
      await panel.locator(".pp-byline", { hasText: "for @dev" }).waitFor();
      await panel.locator(".pp-byline .chip", { hasText: "Draft" }).waitFor();
      await panel.locator(".prose", { hasText: "Margin is revenue minus" }).first().waitFor();
      await panel.locator(".pp-sources li", { hasText: "The finance book" }).waitFor();
      // The image loads from its signed link under the panel's CSP.
      const img = panel.locator('.prose img[alt="A grey chart"]');
      await img.waitFor({ timeout: 10_000 });
      let loaded = false;
      for (let i = 0; i < 50 && !loaded; i++) {
        loaded = await img.evaluate((i: Dom) => i.complete && i.naturalWidth > 0);
        if (!loaded) await page.waitForTimeout(200);
      }
      if (!loaded) throw new Error("the page's image did not load in the panel");
      await panel.locator(".prose .diagram-svg svg").first().waitFor({ timeout: 15_000 });
      const inter = await panel.locator("body").evaluate(async (b: Dom) => {
        const d = b.ownerDocument;
        await d.fonts.ready;
        return [...d.fonts].some((f: Dom) => f.family.includes("Inter") && f.status === "loaded");
      });
      if (!inter) throw new Error("Inter did not load in the panel");
      if (shots) await page.screenshot({ path: `${shots}/page-panel.png`, fullPage: true });
    });
    await step(
      "read only: no controls but the figures' own, no link to another library page",
      async () => {
        const controls = await panel.locator("textarea, input, button:not(figure button)").count();
        if (controls > 0) throw new Error(`the panel has ${controls} controls`);
        if ((await panel.locator('.prose a[href*="costs"]').count()) > 0) {
          throw new Error("a link to another library page is followed in the panel");
        }
        await panel.locator('.prose a[href="https://example.com/"]').waitFor();
      },
    );
  } finally {
    await b.close();
  }
  return problems;
}

/** Runs the daily maintainers as the app's Export now does, and reads the export from R2. */
async function nightlyExport(owner: string, slug: string, originals: number): Promise<string[]> {
  const lib = `${base}/${owner}/${slug}`;
  const r = await apiAs(devCookie, `/api/v1/libraries/${owner}/${slug}/maintain`, "POST");
  const body = (await r.json().catch(() => null)) as { export?: string | null } | null;
  if (r.status !== 200 || !body?.export) {
    return [`export now: ${r.status} ${JSON.stringify(body).slice(0, 200)}`];
  }
  const listed = (await (
    await apiAs(devCookie, `/api/v1/libraries/${owner}/${slug}/exports`)
  ).json()) as { exports: { date: string }[] };
  if (listed.exports.length === 0) return ["the export list is empty after Export now"];
  const date = new Date().toISOString().slice(0, 10);
  const tar = await ui(`${lib}/-/exports/${date}/bundle.tar`);
  if (!tar.ok) return [`nightly bundle.tar: ${tar.status}`];
  const files = readTar(new Uint8Array(await tar.arrayBuffer()));
  // A nightly folder is the plain format: the pages and attachments (with what the gate wrote,
  // so at least the originals), no index.md or log.md.
  if (files.length < originals) {
    return [`nightly bundle has ${files.length} files, fewer than ${originals}`];
  }
  if (files.some((f) => /(^|\/)(index|log)\.md$/.test(f.path))) {
    return ["nightly bundle holds a synthesized index.md or log.md"];
  }
  const ledger = await ui(`${lib}/-/exports/${date}/ledger.jsonl`);
  if (!ledger.ok || !(await ledger.text()).includes('"t":"event"')) {
    return [`nightly ledger.jsonl: ${ledger.status}`];
  }
  // The daily alarm was set when the library was first used.
  const stats = (await (await ui(`${base}/api/v1/libraries/${owner}/${slug}/stats`)).json()) as {
    next_run: string | null;
  };
  if (!stats.next_run) return ["no daily maintenance alarm scheduled"];
  return [];
}

/**
 * A restore in cf dev (no point-in-time recovery there), as the app's Recovery page asks for it,
 * fails cleanly: a 501 naming the reason, no pre-restore export, the library still answering.
 */
async function restoreUnavailable(owner: string, slug: string): Promise<string[]> {
  const api = `/api/v1/libraries/${owner}/${slug}`;
  const to = new Date(Date.now() - 5 * 60_000).toISOString().replace(/\.\d{3}Z$/, "Z");
  const r = await apiAs(devCookie, `${api}/restore`, "POST", { to });
  const body = await r.text();
  if (r.status !== 501 || !body.includes("point-in-time recovery")) {
    return [`restore in cf dev: ${r.status} ${body.slice(0, 200)}`];
  }
  const exports = await (await apiAs(devCookie, `${api}/exports`)).text();
  if (exports.includes("pre-restore")) return ["a pre-restore export was written"];
  const home = await ui(`${base}/${owner}/${slug}/`);
  if (!home.ok) return [`library after a refused restore: ${home.status}`];
  return [];
}

/**
 * Two accounts cannot see each other (v2 spec: Tenancy): a second user signs up, creates a
 * library with a name the first already uses, and neither reaches the other's.
 */
async function strangers(owner: string, slug: string, token: string): Promise<string[]> {
  const problems: string[] = [];
  const cookie = await signIn("stranger@localhost");
  const created = await apiAs(cookie, "/api/v1/libraries", "POST", { slug });
  const theirs = (await created.json().catch(() => null)) as { owner?: string } | null;
  if (created.status !== 201 || theirs?.owner !== "stranger") {
    problems.push(`stranger creates ${slug}: ${created.status} ${JSON.stringify(theirs)}`);
  }
  const libraries = `${base}/api/v1/libraries`;
  const home = await (await ui(libraries, {}, cookie)).text();
  if (home.includes(`"owner":"${owner}"`)) problems.push("stranger's list shows the dev's");
  // Every page of the dev's library is a 404 to the stranger, as if it did not exist.
  for (const p of [
    "",
    "-/ledger",
    "-/work",
    "-/needs",
    "-/activity",
    "-/settings",
    "-/members",
    "-/transfer",
    "-/recovery",
    "-/connect",
    "-/delete",
    "-/diff/a.md",
    "-/revert/x",
    "-/restore/a.md?to=1",
    "-/export",
    "-/ledger.jsonl",
    "a.md",
  ]) {
    const page = await ui(`${base}/${owner}/${slug}/${p}`, {}, cookie);
    if (page.status !== 404) problems.push(`stranger opens the dev's ${slug}/${p}: ${page.status}`);
  }
  const mine = await (await ui(libraries)).text();
  if (mine.includes('"owner":"stranger"')) problems.push("dev's list shows the stranger's");
  const cross = await fetch(`${base}/api/v1/libraries/stranger/${slug}/tree`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (cross.status !== 404) problems.push(`dev's token on the stranger's ${slug}: ${cross.status}`);

  // Sharing (tempra-dev: v2/sharing): the dev invites the stranger to write; they accept, open
  // it, connect their own agent over OAuth to it, and the agent writes as theirs.
  const lib = `/api/v1/libraries/${owner}/${slug}`;
  const invited = await apiAs(devCookie, `${lib}/invitations`, "POST", {
    to: "@stranger",
    role: "write",
  });
  if (invited.status !== 202) problems.push(`dev invites the stranger: ${invited.status}`);
  const inbox = (await (await apiAs(cookie, "/api/v1/invitations")).json()) as {
    invitations?: { id: string; owner: string }[];
  };
  const invitation = inbox.invitations?.find((i) => i.owner === owner);
  if (!invitation) return [...problems, "the stranger has no invitation"];
  const accepted = await apiAs(cookie, `/api/v1/invitations/${invitation.id}/accept`, "POST");
  if (accepted.status !== 200) problems.push(`the stranger accepts: ${accepted.status}`);
  for (const p of ["", "a.md"]) {
    const page = await ui(`${base}/${owner}/${slug}/${p}`, {}, cookie);
    if (page.status !== 200) problems.push(`the member opens ${slug}/${p}: ${page.status}`);
  }
  const connected = await oauthConnect(cookie, {
    library: `${owner}/${slug}`,
    libraries: "selected",
    new_library: "",
    access: "write",
    prefix: "",
    actor: "claude-ai/connector",
    tiers: "all",
  });
  if ("error" in connected) return [...problems, `the member connects: ${connected.error}`];
  if (!(await mcpSmoke({ url: base, token: connected.token, log: () => {} }))) {
    problems.push("the member's agent works in the shared library over MCP");
  }
  const who = (await (await apiAs(devCookie, `${lib}/agents`)).json()) as {
    contributors?: { person: string | null; agent: { platform: string | null } | null }[];
  };
  if (
    !who.contributors?.some((c) => c.person === "stranger" && c.agent?.platform === "claude.ai")
  ) {
    problems.push(`the member's agent is not among the library's agents: ${JSON.stringify(who)}`);
  }
  // Removed: the member and their agent are out at once.
  const removed = await apiAs(devCookie, `${lib}/members/stranger`, "DELETE");
  if (removed.status !== 204) problems.push(`dev removes the member: ${removed.status}`);
  const after = await ui(`${base}/${owner}/${slug}/`, {}, cookie);
  if (after.status !== 404) problems.push(`a removed member opens ${slug}: ${after.status}`);
  return problems;
}

const b64url = (bytes: Uint8Array) =>
  btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");

/**
 * Connects an MCP client over OAuth with PKCE, as Claude would, as the signed-in person with
 * this cookie, approving consent with these fields; the access token, or what went wrong.
 */
async function oauthConnect(
  cookie: string,
  fields: Record<string, string>,
): Promise<{ token: string } | { error: string }> {
  const redirect = "https://claude.ai/api/mcp/auth_callback";
  const reg = await fetch(`${base}/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      client_name: "Gate",
      redirect_uris: [redirect],
      token_endpoint_auth_method: "none",
    }),
  });
  const { client_id } = (await reg.json()) as { client_id: string };
  const verifier = b64url(crypto.getRandomValues(new Uint8Array(32)));
  const challenge = b64url(
    new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))),
  );
  const authorize = `${base}/authorize?${new URLSearchParams({
    response_type: "code",
    client_id,
    redirect_uri: redirect,
    scope: "tempra:read tempra:write",
    state: "gate",
    code_challenge: challenge,
    code_challenge_method: "S256",
    resource: `${base}/mcp`,
  })}`;
  // Consent stays a server page (TEMPRA-14): posted as a person's browser would.
  const consent = await ui(authorize, {}, cookie);
  const html = await consent.text();
  const handle = /name="handle" value="([^"]+)"/.exec(html)?.[1];
  if (!handle) return { error: `consent page: ${consent.status} ${html.slice(0, 200)}` };
  const consentCookies = consent.headers
    .getSetCookie()
    .map((c) => c.split(";")[0])
    .join("; ");
  const approved = await ui(
    authorize,
    {
      method: "POST",
      headers: { Origin: base },
      body: new URLSearchParams({ handle, decision: "approve", ...fields }),
    },
    `${cookie}; ${consentCookies}`,
  );
  const code = new URL(approved.headers.get("Location") ?? redirect).searchParams.get("code");
  if (!code) return { error: `consent: ${approved.status}` };
  const tok = await fetch(`${base}/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: redirect,
      client_id,
      code_verifier: verifier,
    }),
  });
  const { access_token } = (await tok.json()) as { access_token?: string };
  return access_token ? { token: access_token } : { error: `token: ${tok.status}` };
}

/**
 * A fresh account's first run (v2 spec: Phases and gates, A2), in the browser: sign up, the
 * welcome page, then connect an MCP client through OAuth with PKCE, as Claude Code would, and
 * write through MCP; the open Connect page turns to the agent's write live. Then the account's
 * pages (Agents: the connected app and tokens, account, work queue, import and export, recovery) work, and
 * the library is deleted from its Settings page's Delete section, which ends the connection.
 */
/**
 * The daily cron through cf dev's scheduled handler, run again every few seconds while the queue
 * consumer counts each library (the first run holds deletion until every library has been counted
 * once), until a run reports deletion no longer held and the attachments the gate imported as
 * stored and referenced. Each run logs its result as {"sweep": …} on cf dev's output.
 */
async function blobSweep(): Promise<string[]> {
  type Result = { held?: string; stored: number; referenced: number; recount: string };
  const latest = (): Result | null => {
    const lines = devTail.stdout.split("\n").filter((l) => l.includes('{"sweep":{"libraries"'));
    const line = lines[lines.length - 1];
    if (!line) return null;
    try {
      return (JSON.parse(line.slice(line.indexOf("{"))) as { sweep: Result }).sweep;
    } catch {
      return null;
    }
  };
  let last: Result | null = null;
  for (let i = 0; i < 20; i++) {
    const cron = await fetch(`${base}/cdn-cgi/handler/scheduled?cron=30+4+*+*+*`);
    if (!cron.ok) return [`the scheduled handler answered ${cron.status}`];
    await Bun.sleep(3000);
    last = latest();
    if (last && !last.held && last.referenced > 0) break;
  }
  if (!last) return ["no sweep result in cf dev's output"];
  const problems: string[] = [];
  if (last.held) problems.push(`deletion still held: ${last.held}`);
  if (last.stored === 0 || last.referenced === 0) {
    problems.push(
      `imported attachments not tracked (stored ${last.stored}, referenced ${last.referenced})`,
    );
  }
  return problems;
}

async function freshAccountConnects(): Promise<string[]> {
  const b = await openBrowser();
  if (typeof b === "string") return [b];
  const { page, step, problems } = b;
  try {
    await b.signInAs("newcomer@localhost", "/");
    await page.waitForURL(`${base}/welcome`);
    await page.getByRole("heading", { level: 1, name: "Welcome" }).waitFor({ timeout: 15_000 });
    // A name (TEMPRA-54): the avatar's initials come from it ("AL"), not the handle ("NE").
    await page.locator('input[name="name"]').fill("Ada Lovelace");
    await page.locator('input[name="handle"]').fill("newcomer");
    await page.locator('input[name="library"]').fill("notes");
    // Both fields say they become the library's address, and how they may be written (H-12).
    for (const id of ["welcome-handle-hint", "welcome-library-hint"]) {
      const hint = await page.locator(`#${id}`).innerText();
      if (!/address/.test(hint) || !/[Ll]owercase/.test(hint)) {
        throw new Error(`the ${id} reads "${hint}"`);
      }
    }
    // No guide: the library starts empty, so its home shows how to connect an agent.
    await page.locator('input[name="starter"]').uncheck();
    await page.getByRole("button", { name: "Create" }).click();
    const lib = `${base}/newcomer/notes`;
    const cookie = await b.cookie();
    // First run lands on the new library's home (take 4, board 31; H-12): the steps with the MCP
    // URL, waiting for the first write, Import a bundle. The Connect page waits in a second tab.
    const waiting = page.locator("main.ws-main .empty-library");
    await step(
      "first run lands on the empty library's home, which shows how to connect",
      async () => {
        await page.waitForURL(`${lib}/`);
        await waiting
          .getByRole("heading", { name: "Nothing here yet" })
          .waitFor({ timeout: 15_000 });
        await waiting.locator(".copy-field code", { hasText: `${base}/mcp` }).waitFor();
        await waiting.locator(".empty-wait .change-dot.live").waitFor();
        await waiting.getByText("Waiting for the first write").waitFor();
        const imp = await page
          .getByRole("link", { name: "Import a bundle", exact: true })
          .getAttribute("href");
        if (imp !== "/newcomer/notes/-/settings#transfer")
          throw new Error(`Import a bundle: ${imp}`);
        await page
          .locator("section.ws-sidebar .tree-note", { hasText: "No pages yet." })
          .waitFor({ timeout: 10_000 });
        if (process.env.GATE_SCREENSHOTS) {
          await page.screenshot({ path: `${process.env.GATE_SCREENSHOTS}/empty.png` });
        }
      },
    );
    await step("the avatar's initials come from the name given at first run", async () => {
      const avatar = page.getByRole("button", { name: "Account menu" });
      const shown = (await avatar.locator('span[aria-hidden="true"]').innerText()).trim();
      if (shown !== "AL") throw new Error(`the avatar reads "${shown}", not AL`);
    });
    const connectTab = await b.context.newPage();
    await connectTab.goto(`${lib}/-/settings#connect`);
    await connectTab.getByText("No agent has written yet").waitFor({ timeout: 15_000 });

    const connected = await oauthConnect(cookie, {
      library: "notes",
      new_library: "",
      access: "write",
      prefix: "",
      actor: "claude-code/gate",
      tiers: "all",
    });
    if ("error" in connected) return [connected.error];
    const access_token = connected.token;
    if (!(await mcpSmoke({ url: base, token: access_token }))) return ["MCP over OAuth"];

    await step("the open Connect page shows the agent's write, live", () =>
      connectTab.locator("#status", { hasText: /^Last agent write: / }).waitFor({ timeout: 5000 }),
    );
    await step("the empty library's home fills in live after the first write", async () => {
      // The smoke flow writes and tidies away its note, so the library is empty again: the
      // waiting line has become the agent's last write.
      await waiting.locator(".empty-wait", { hasText: /^Last write by / }).waitFor({
        timeout: 10_000,
      });
      if ((await waiting.locator(".change-dot.live").count()) > 0) {
        throw new Error("the home still waits for the first write");
      }
      await connectTab.close();
    });
    /** A link in the avatar's menu (take 2: the account's pages live there). */
    const accountLink = async (name: string) => {
      await page.getByRole("button", { name: "Account menu" }).click();
      await page.locator(".menu-list").getByRole("link", { name, exact: true }).click();
    };
    /**
     * A section of the library's Settings page, opened through Settings at the library
     * sidebar's foot (TEMPRA-145) unless the page is already open, and scrolled to.
     */
    const libraryLink = async (name: string) => {
      if (!new URL(page.url()).pathname.endsWith("/-/settings")) {
        await page
          .locator(".ws-sidebar")
          .getByRole("navigation", { name: "Library" })
          .getByRole("link", { name: "Settings", exact: true })
          .click();
        await page.waitForURL(`${lib}/-/settings`);
      }
      const heading = page
        .locator(".ws-main")
        .getByRole("heading", { level: 2, name, exact: true });
      await heading.waitFor({ timeout: 15_000 });
      await heading.scrollIntoViewIfNeeded();
    };
    // Agents (2026-10-23): the connected app and tokens in one list, New token in the compose
    // dialog, the secret shown once in a dialog after.
    await step("Agents lists the connected app, from the avatar menu", async () => {
      await accountLink("Agents");
      await page.waitForURL(`${base}/agents`);
      await page.getByRole("cell", { name: /Gate/ }).waitFor({ timeout: 15_000 });
      await page
        .getByText(/^App · connected/)
        .first()
        .waitFor();
    });
    await step("tokens: create one from New token, see it once, revoke it", async () => {
      await page.getByRole("button", { name: "New token", exact: true }).click();
      const compose = page.getByRole("dialog", { name: "New token" });
      await compose.getByRole("textbox", { name: "Name", exact: true }).fill("process:gate");
      await compose.getByRole("button", { name: "Create token" }).click();
      const created = page.getByRole("dialog", { name: "Token created" });
      await created.locator("#token-secret").waitFor({ timeout: 15_000 });
      await created.getByRole("button", { name: "Done" }).click();
      await created.waitFor({ state: "hidden", timeout: 5000 });
      // Revoking asks first (S-4).
      const row = page.getByRole("row", { name: /process:gate/ });
      await row.getByRole("button", { name: "Revoke…" }).click();
      await page.locator("dialog").getByRole("button", { name: "Revoke", exact: true }).click();
      await row.getByText("revoked").waitFor({ timeout: 15_000 });
    });
    await step("account page", async () => {
      await accountLink("Account");
      await page.getByText("this device").waitFor({ timeout: 15_000 });
    });
    // Off a library, Ctrl/Cmd+K searches the person's libraries (TEMPRA-127); Ctrl/Cmd+\ leaves
    // the account's sidebar alone (only a library's own sidebar hides).
    await step("account pages: Ctrl+K finds a library, Ctrl+\\ keeps the sidebar", async () => {
      await page.keyboard.press("Control+\\");
      await page.waitForTimeout(200);
      if (!(await page.locator("section.ws-sidebar").isVisible())) {
        throw new Error("Ctrl+\\ hid the account's sidebar");
      }
      await page.keyboard.press("Control+k");
      const dialog = page.getByRole("dialog", { name: "Search libraries" });
      const box = dialog.getByRole("combobox");
      await box.waitFor({ timeout: 5000 });
      await box.fill("notes");
      await dialog.locator('[role="option"]').first().waitFor({ timeout: 5000 });
      await box.press("Enter");
      await page.waitForURL(`${lib}/`);
    });
    for (const [tab, text] of [
      ["Import & export", "Nightly exports"],
      ["Recovery", "Past restores"],
    ] as const) {
      await step(`Settings section ${tab}`, async () => {
        await page.goto(`${lib}/`);
        await libraryLink(tab);
        // In its section: the phone's top bar (hidden here) names the page too.
        await page.locator(".ws-main").getByText(text).first().waitFor({ timeout: 15_000 });
      });
    }
    await step("export now, from Import & export", async () => {
      await libraryLink("Import & export");
      await page.getByRole("button", { name: "Export now" }).click();
      await page.getByText("Export saved").waitFor({ timeout: 15_000 });
    });

    // Sharing in the app (tempra-dev: v2/sharing): invite from Settings' Members section; the invitee
    // accepts from Invitations; as a reader there is no Verify, at write there is.
    await step("invite a person from Settings' Members section", async () => {
      await page.goto(`${lib}/`);
      await libraryLink("Members");
      await page.locator('#members input[name="to"]').fill("@stranger");
      await page.getByRole("button", { name: "Invite" }).click();
      await page.getByText("Invited @stranger").waitFor({ timeout: 15_000 });
    });
    // The invitee is the same tab under their own session, the cookies swapped: one browser,
    // one context, as for everything else here.
    const { context } = b;
    const asOwner = await context.cookies();
    const switchTo = async (cookies: typeof asOwner) => {
      await context.clearCookies();
      await context.addCookies(cookies);
    };
    let asInvitee: typeof asOwner = [];
    // From the bell (TEMPRA-130, A-2; TEMPRA-189): Accept in the invitation's row adds the
    // library to the person's list at once (the switcher) and opens it, in place (F-2).
    await step("the invitee accepts from the bell and opens the library", async () => {
      await context.clearCookies();
      await b.signInAs("stranger@localhost", "/agents", true);
      const href = new URL(`${lib}/`).pathname;
      await page.locator("main.ws-main h1").first().waitFor({ timeout: 15_000 });
      await page.evaluate("window.__gateStay = true");
      await page
        .locator("header.ws-topbar")
        .getByRole("button", { name: /^Notifications/ })
        .click();
      await page
        .locator(".menu-list.bell-pop div.bell-item")
        .filter({ hasText: "invited you to" })
        .getByRole("button", { name: "Accept", exact: true })
        .click();
      await page.waitForURL(`${lib}/`, { timeout: 15_000 });
      if (!(await page.evaluate("window.__gateStay === true"))) {
        throw new Error("Accept reloaded the app");
      }
      await page.locator(".menu-list.bell-pop").waitFor({ state: "detached", timeout: 5000 });
      await page.getByRole("button", { name: "Switch library" }).click();
      await page.locator(`.menu-list a.menu-lib[href="${href}"]`).waitFor({ timeout: 5000 });
      await page.keyboard.press("Escape");
      asInvitee = await context.cookies();
    });
    // H-11: a read member on an empty library is not offered what only writers can do.
    await step("a read member's empty library says only that nothing is here yet", async () => {
      const empty = page.locator("main.ws-main .empty-library");
      await empty.getByRole("heading", { name: "Nothing here yet" }).waitFor({ timeout: 15_000 });
      await empty.getByText("Pages appear here when an agent writes them.").waitFor();
      for (const gone of [".copy-field", ".empty-steps"]) {
        if ((await empty.locator(gone).count()) > 0) throw new Error(`a reader is shown ${gone}`);
      }
      for (const link of ["Import a bundle", "Other ways to connect"]) {
        if ((await page.getByRole("link", { name: link }).count()) > 0) {
          throw new Error(`a reader is offered ${link}`);
        }
      }
      await page
        .locator("section.ws-sidebar .tree-note", { hasText: "No pages yet." })
        .waitFor({ timeout: 10_000 });
      if (process.env.GATE_SCREENSHOTS) {
        await page.screenshot({ path: `${process.env.GATE_SCREENSHOTS}/empty-reader.png` });
      }
    });
    await step("a note to share", async () => {
      const put = await ui(
        `${base}/api/v1/libraries/newcomer/notes/files/shared.md`,
        {
          method: "PUT",
          headers: { Origin: base, "Content-Type": "text/markdown" },
          body: "---\ntype: Note\ntitle: Shared note\ndescription: For the invited reader.\n---\nRead me.\n",
        },
        cookie,
      );
      if (put.status !== 200) throw new Error(`PUT shared.md: ${put.status}`);
    });
    /** Opens the open page's Page info (TEMPRA-283: a page nobody checked offers Mark as checked
     * there, to a write member only). */
    const properties = async () => {
      await page.locator(".byline").waitFor({ timeout: 15_000 });
      await page
        .locator('.page-tools [data-panel="info"]')
        .filter({ visible: true })
        .first()
        .click();
      const panel = page.locator("aside#panel-info.page-aside");
      await panel.waitFor({ timeout: 15_000 });
      return panel;
    };
    await step("a reader sees the note and no Mark as checked", async () => {
      await page.goto(`${lib}/shared.md`);
      await page.getByText("Read me.").waitFor({ timeout: 15_000 });
      const panel = await properties();
      await panel.getByText("Linked from").waitFor({ timeout: 15_000 });
      // The role loads with the library list; give it the moment it takes.
      await page.waitForTimeout(500);
      if ((await panel.getByRole("button", { name: "Mark as checked" }).count()) !== 0) {
        throw new Error("a read member is offered a check");
      }
      if ((await panel.getByText(/verif/i).count()) !== 0) throw new Error("Page info says verify");
      // Review mode says nobody has checked it, and offers a reader nothing but Done.
      await page.goto(`${lib}/shared.md?review=1`);
      await page
        .getByRole("region", { name: "Review" })
        .getByText("Nobody has checked this page yet")
        .waitFor({ timeout: 15_000 });
      await page.waitForTimeout(500);
      const check = await page.getByRole("button", { name: "Mark as checked" }).count();
      if (check !== 0) throw new Error("a read member is offered Mark as checked");
    });
    await step("the owner gives the member write access", async () => {
      await switchTo(asOwner);
      await page.goto(`${lib}/-/members`);
      await page.getByLabel("Access for @stranger").selectOption("write");
      // A change of access asks first (S-4).
      await page.locator("dialog").getByRole("button", { name: "Change access" }).click();
      await page.getByText("@stranger now has write access").waitFor({ timeout: 15_000 });
    });
    await step("a writer is offered Mark as checked", async () => {
      await switchTo(asInvitee);
      await page.goto(`${lib}/shared.md`);
      const panel = await properties();
      await panel.getByRole("button", { name: "Mark as checked" }).waitFor({ timeout: 15_000 });
    });
    // Deleting the library wipes its Durable Object and ends the connection.
    await step("delete the library from its Settings section", async () => {
      await switchTo(asOwner);
      await page.goto(`${lib}/`);
      await libraryLink("Delete library");
      // The page's other sections load as it opens (Members asks …/members and …/agents): wait
      // for them, as a person would, so no load is still on its way when the library goes.
      await page.locator(".ws-main td.name", { hasText: "@stranger" }).waitFor({ timeout: 15_000 });
      await page.locator('input[name="confirm"]').fill("notes");
      await page.getByRole("button", { name: "Delete library" }).click();
      // The last library gone: first run again.
      await page.waitForURL(`${base}/welcome`, { timeout: 15_000 });
    });
    await step("the deleted library's page is gone", async () => {
      const gone = await ui(`${lib}/`, {}, cookie);
      if (gone.status !== 404) throw new Error(`deleted library page: ${gone.status}`);
    });
    await step("the connection ends with the library", async () => {
      const mcp = await fetch(`${base}/mcp`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${access_token}`,
          "Content-Type": "application/json",
          Accept: "application/json, text/event-stream",
        },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
      });
      if (mcp.status !== 401) throw new Error(`MCP after delete: ${mcp.status}`);
    });
    await step("the avatar's menu opens Account and Agents, and signs out", async () => {
      await switchTo(asOwner);
      const menu = () => page.getByRole("button", { name: /Account menu/ });
      for (const [item, heading] of [
        ["Account", "Account"],
        ["Agents", "Agents"],
      ] as const) {
        await menu().click();
        // The menu's own link: account pages' sidebars name the same pages.
        await page
          .locator(".menu-list.account")
          .getByRole("link", { name: item, exact: true })
          .click();
        await page.waitForURL(`${base}/${item.toLowerCase()}`, { timeout: 15_000 });
        await page
          .getByRole("heading", { level: 1, name: heading, exact: true })
          .waitFor({ timeout: 15_000 });
      }
      // Sign out posts its form from inside the menu: the menu closes only after the click, or
      // the form leaves the page before the browser sends it.
      await menu().click();
      await page
        .locator(".menu-list.account")
        .getByRole("button", { name: "Sign out", exact: true })
        .click();
      await page.waitForURL((u) => u.pathname.startsWith("/sign-in"), { timeout: 15_000 });
      // The session it ended is refused from now on, not only dropped from this browser.
      const me = await fetch(`${base}/api/v1/me`, { headers: { Cookie: cookie } });
      if (me.status !== 401) throw new Error(`still signed in after Sign out: ${me.status}`);
    });
    return problems;
  } finally {
    await b.close();
  }
}

/**
 * The per-account cap on open feed sockets (TEMPRA-80), end to end: one account's token opens
 * sockets until one is refused, which must be with FEED_FULL, at the cap at most (sockets the
 * gate's own browsers and agents still hold count, and a close's release may still be on its way).
 */
async function feedCap(owner: string, slug: string, token: string): Promise<string[]> {
  const url = `${base.replace(/^http/, "ws")}/api/v1/libraries/${owner}/${slug}/feed`;
  const open: WebSocket[] = [];
  const problems: string[] = [];
  try {
    for (let i = 0; i < FEED_SOCKETS_PER_ACCOUNT + 5; i++) {
      const ws = new WebSocket(url, {
        headers: { Authorization: `Bearer ${token}` },
      } as unknown as string[]);
      const outcome = await within(
        10_000,
        `feed socket ${i + 1}`,
        new Promise<"open" | number>((resolve) => {
          ws.onmessage = () => resolve("open");
          ws.onclose = (e) => resolve(e.code);
        }),
      );
      if (outcome === "open") {
        open.push(ws);
        continue;
      }
      if (outcome !== FEED_FULL) problems.push(`socket ${i + 1} closed with ${outcome}`);
      // Other sockets of the account may still hold places, so only the upper bound is exact
      // here; feed-leases.test.ts checks the count itself.
      if (open.length > FEED_SOCKETS_PER_ACCOUNT || open.length === 0) {
        problems.push(
          `refused after ${open.length} sockets; the cap is ${FEED_SOCKETS_PER_ACCOUNT}`,
        );
      }
      console.log(
        `  feed sockets: refused with ${outcome} after ${open.length} (account cap ${FEED_SOCKETS_PER_ACCOUNT}, library cap ${FEED_SOCKETS_PER_LIBRARY})`,
      );
      return problems;
    }
    problems.push(`${open.length} sockets opened and none was refused`);
    return problems;
  } finally {
    for (const ws of open) ws.close(1000, "done");
  }
}

let failed = false;
try {
  await waitForHealth();
  devCookie = await signIn("dev@localhost");
  for (const t of tokens) {
    const headers = { Authorization: `Bearer ${t.token}` };
    const lib = `${base}/api/v1/libraries/${t.owner}/${t.slug}`;
    const original = loadBundle(t.bundle);
    const imp = await fetch(`${lib}/import?source=fixtures/${t.bundle}`, {
      method: "POST",
      headers: { ...headers, "Content-Type": "application/x-tar" },
      body: writeTar(original),
    });
    if (!imp.ok) throw new Error(`import ${t.bundle}: ${imp.status} ${await imp.text()}`);
    const res = (await imp.json()) as { files: number; seq: number; warnings: unknown[] };

    // An OKF bundle in, an OKF bundle out: every file back, and the synthesized index.md files.
    const exp = await fetch(`${lib}/export?format=okf`, { headers });
    if (!exp.ok) throw new Error(`export ${t.bundle}: ${exp.status} ${await exp.text()}`);
    const exported = new Map(
      readTar(new Uint8Array(await exp.arrayBuffer())).map((f) => [f.path, f.bytes]),
    );
    const problems = compareBundle(original, exported);
    for (const f of original) {
      if (/(^|\/)index\.md$/.test(f.path) && !exported.has(f.path)) {
        problems.push(`${f.path}: missing from the OKF export`);
      }
    }
    const pagePaths = original.filter(
      (f) => f.path.endsWith(".md") && !/(^|\/)(index|log)\.md$/.test(f.path),
    ).length;
    const attachments = original.filter((f) => !f.path.endsWith(".md")).length;
    const status = problems.length === 0 ? "PASS" : "FAIL";
    console.log(
      `${status} ${t.bundle}: ${pagePaths} pages, ${attachments} attachments, ${res.seq} events, ${res.warnings.length} files with lint`,
    );
    for (const p of problems) console.log(`  - ${p}`);
    if (problems.length > 0) failed = true;

    const uiProblems = await uiPages(
      t.owner,
      t.slug,
      original.map((f) => f.path),
    );
    console.log(`${uiProblems.length === 0 ? "PASS" : "FAIL"} ${t.bundle}: UI pages render`);
    for (const p of uiProblems) console.log(`  - ${p}`);
    if (uiProblems.length > 0) failed = true;

    if (t === tokens[0]) {
      const pagePaths = original
        .map((f) => f.path)
        .filter((p) => p.endsWith(".md") && !/(^|\/)(index|log)\.md$/.test(p));
      const browser = await browserRenders(t.owner, t.slug, pagePaths, t.token).catch((e) => [
        String(e),
      ]);
      console.log(`${browser.length === 0 ? "PASS" : "FAIL"} ${t.bundle}: the app in a browser`);
      for (const p of browser) console.log(`  - ${p}`);
      if (browser.length > 0) failed = true;
    }
    const exportProblems = await nightlyExport(
      t.owner,
      t.slug,
      original.filter((f) => !/(^|\/)(index|log)\.md$/.test(f.path)).length,
    );
    console.log(
      `${exportProblems.length === 0 ? "PASS" : "FAIL"} ${t.bundle}: nightly export to R2 via the Durable Object`,
    );
    for (const p of exportProblems) console.log(`  - ${p}`);
    if (exportProblems.length > 0) failed = true;
    const restoreProblems = await restoreUnavailable(t.owner, t.slug);
    console.log(
      `${restoreProblems.length === 0 ? "PASS" : "FAIL"} ${t.bundle}: restore refused cleanly without point-in-time recovery`,
    );
    for (const p of restoreProblems) console.log(`  - ${p}`);
    if (restoreProblems.length > 0) failed = true;
  }
  const first = tokens[0];
  const tenancy = first ? await strangers(first.owner, first.slug, first.token) : ["no library"];
  console.log(
    `${tenancy.length === 0 ? "PASS" : "FAIL"} a second account sees nothing of the first, until invited; then it and its agent work there`,
  );
  for (const p of tenancy) console.log(`  - ${p}`);
  if (tenancy.length > 0) failed = true;
  const uploads = first
    ? await uploadLink(first.owner, first.slug, first.token).catch((e) => [String(e)])
    : ["no library"];
  console.log(
    `${uploads.length === 0 ? "PASS" : "FAIL"} the upload link: a person sends the file an agent prepared for`,
  );
  for (const p of uploads) console.log(`  - ${p}`);
  if (uploads.length > 0) failed = true;
  const agent = first
    ? await managedAgent(first.owner, first.slug, first.token).catch((e) => [String(e)])
    : ["no library"];
  console.log(
    `${agent.length === 0 ? "PASS" : "FAIL"} @tempra answers a mention live, files a request from the home, and work lists it`,
  );
  for (const p of agent) console.log(`  - ${p}`);
  if (agent.length > 0) failed = true;
  // A failure outside a step (signing up, the OAuth connection) is the flow's failure, not the
  // gate's: the checks after it still run.
  const fresh = await freshAccountConnects().catch((e) => [String(e)]);
  console.log(
    `${fresh.length === 0 ? "PASS" : "FAIL"} a fresh account signs up, connects over OAuth, writes, uses its pages, deletes`,
  );
  for (const p of fresh) console.log(`  - ${p}`);
  if (fresh.length > 0) failed = true;
  // The daily blob sweep and digest (v2 spec: A3), run through cf dev's scheduled handler; its
  // recounts go through the local queue (TEMPRA-81) until the sweep is no longer held.
  const sweepProblems = await blobSweep();
  console.log(
    `${sweepProblems.length === 0 ? "PASS" : "FAIL"} the daily sweep runs, its recounts land through the queue, and deletion is no longer held`,
  );
  for (const p of sweepProblems) console.log(`  - ${p}`);
  if (sweepProblems.length > 0) failed = true;
  const mcpOk = await mcpSmoke({ url: base, token: mcpToken });
  console.log(`${mcpOk ? "PASS" : "FAIL"} MCP smoke on an empty library`);

  // After the smoke, which wants the library empty.
  const panel = await uploadPanel(mcpToken).catch((e) => [String(e)]);
  console.log(
    `${panel.length === 0 ? "PASS" : "FAIL"} the upload panel: an MCP host draws it, the person's file crosses to /ul/, the chat is told`,
  );
  for (const p of panel) console.log(`  - ${p}`);
  if (panel.length > 0) failed = true;
  const shown = await pagePanel(mcpToken).catch((e) => [String(e)]);
  console.log(
    `${shown.length === 0 ? "PASS" : "FAIL"} the page panel: an MCP host draws one page as the app does, read only`,
  );
  for (const p of shown) console.log(`  - ${p}`);
  if (shown.length > 0) failed = true;
  if (!mcpOk) failed = true;
  // Several agents at once over MCP: a stale edit refused, turns on one page, parallel
  // writes; every write must reach the change feed. Patient, since the gate's earlier steps
  // spend much of the account's write limit.
  const a = agentTokens[0];
  const agents = await runAgents({
    url: base,
    owner: a?.owner ?? "",
    slug: a?.slug ?? "",
    tokens: agentTokens.map((t) => t.token),
    patient: true,
    log: () => {},
  });
  console.log(formatReport(agents).replace(/^(PASS|FAIL)/, "$1 scripted agents:"));
  if (!agents.ok) failed = true;
  // Last: the leases it takes keep counting for a minute after its sockets close.
  const cap = first ? await feedCap(first.owner, first.slug, first.token) : ["no library"];
  console.log(
    `${cap.length === 0 ? "PASS" : "FAIL"} a socket past the account's feed cap is refused`,
  );
  for (const p of cap) console.log(`  - ${p}`);
  if (cap.length > 0) failed = true;
} catch (e) {
  failed = true;
  console.error(e);
  // cf dev's streams end only when it does: stop it first, or this waits forever.
  stopDev();
  await within(10_000, "cf dev's output", drained).catch(() => {});
  console.error(devTail.stderr.slice(-4000));
} finally {
  stopDev();
  await dev.exited;
  if (!values.keep) rmSync(project, { recursive: true, force: true });
}
console.log(failed ? "Gate FAILED" : "Gate passed");
process.exit(failed ? 1 : 0);
