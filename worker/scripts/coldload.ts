/**
 * Cold loads of a page in Chromium against a fresh `cf dev` (the Svelte port's before
 * and after numbers, TEMPRA-176): each run a new browser context (empty cache), timed from
 * navigation to the reader's first block in the DOM, with the page's own timings (document,
 * script, DOMContentLoaded, first and largest contentful paint) and the bytes of script fetched.
 *
 *   bun scripts/coldload.ts [--runs 5] [--port 8798]
 */
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { chromium } from "playwright-core";
import { writeTar } from "../src/util/tar";
import { loadBundle } from "../test/fixtures";
import { WORKER_DIR } from "./cf";
import { seed } from "./seed";

const { values } = parseArgs({
  options: {
    runs: { type: "string" },
    port: { type: "string" },
    path: { type: "string" },
    selector: { type: "string" },
  },
});
const runs = Number(values.runs ?? 5);
const port = Number(values.port ?? 8798);
const base = `http://127.0.0.1:${port}`;

mkdirSync(join(WORKER_DIR, ".gate"), { recursive: true });
const project = mkdtempSync(join(WORKER_DIR, ".gate", "cold-"));
for (const f of ["cloudflare.config.ts", "wrangler.config.ts", "package.json", "tsconfig.json"])
  copyFileSync(join(WORKER_DIR, f), join(project, f));
for (const d of ["src", "migrations", "node_modules"])
  symlinkSync(join(WORKER_DIR, d), join(project, d));
writeFileSync(join(project, ".dev.vars"), "DEV_SIGNIN=1\nSIGNUP=open\n");
const state = join(project, ".wrangler/state");
const t = await seed({ slug: "acme-retail", persistTo: state });

const dev = Bun.spawn(["bunx", "cf", "dev", "--port", String(port)], {
  detached: true,
  cwd: project,
  env: { ...process.env, CF_SEND_TELEMETRY: "false", CI: "1" },
  stdout: "ignore",
  stderr: "ignore",
});
try {
  for (let i = 0; ; i++) {
    if (i > 120) throw new Error("cf dev did not start");
    if (
      await fetch(`${base}/healthz`).then(
        (r) => r.ok,
        () => false,
      )
    )
      break;
    await Bun.sleep(500);
  }
  const lib = `${base}/api/v1/libraries/${t.owner}/${t.slug}`;
  const imp = await fetch(`${lib}/import?source=fixtures/acme_retail`, {
    method: "POST",
    headers: { Authorization: `Bearer ${t.token}`, "Content-Type": "application/x-tar" },
    body: writeTar(loadBundle("acme_retail")),
  });
  if (!imp.ok) throw new Error(`import: ${imp.status}`);
  const asked = await fetch(`${base}/sign-in`, {
    method: "POST",
    headers: { Origin: base },
    body: new URLSearchParams({ email: "dev@localhost", next: "/" }),
  });
  const token = /[?&]t=([0-9a-f]{64})/.exec((await asked.text()).replace(/&#38;/g, "&"))?.[1];
  const done = await fetch(`${base}/sign-in/link`, {
    method: "POST",
    headers: { Origin: base },
    body: new URLSearchParams({ t: token ?? "", next: "/" }),
    redirect: "manual",
  });
  const cookie = done.headers.get("Set-Cookie")?.split(";")[0] ?? "";
  const path = values.path ?? "tables/orders.md";
  const url = `${base}/${t.owner}/${t.slug}/${path}`;
  const browser = await chromium.launch({
    executablePath: process.env.CHROME_PATH || "/opt/pw-browsers/chromium",
  });
  const times: number[] = [];
  const paints: number[] = [];
  for (let i = 0; i <= runs; i++) {
    const context = await browser.newContext({ extraHTTPHeaders: { Cookie: cookie } });
    const page = await context.newPage();
    // Script strings, as in the gate (this file has no DOM types): when the reader's first block
    // is in the DOM, the first contentful paint and the largest one.
    await page.addInitScript(`(() => {
      new PerformanceObserver((l) => {
        for (const e of l.getEntries()) window.__lcp = e.startTime;
      }).observe({ type: "largest-contentful-paint", buffered: true });
      new PerformanceObserver((l) => {
        for (const e of l.getEntries()) if (e.name === "first-contentful-paint") window.__fcp = e.startTime;
      }).observe({ type: "paint", buffered: true });
      new MutationObserver((_, o) => {
        if (document.querySelector(".prose [data-block]")) {
          window.__drawn = performance.now();
          o.disconnect();
        }
      }).observe(document, { childList: true, subtree: true });
    })()`);
    let script = 0;
    const csp: string[] = [];
    page.on("console", (m) => {
      if (/Content Security Policy|Refused to/.test(m.text()) || m.type() === "error")
        csp.push(m.text());
    });
    page.on("response", async (r) => {
      if (r.request().resourceType() === "script") script += (await r.body()).length;
    });
    const start = Date.now();
    await page.goto(url);
    await page.waitForSelector(values.selector ?? ".prose [data-block]", { timeout: 20_000 });
    const ms = Date.now() - start;
    // The largest paint is final once the page settles.
    await page.waitForTimeout(500);
    const t = await page.evaluate<Record<string, number | string>>(`(() => {
      const nav = performance.getEntriesByType("navigation")[0];
      const js = performance.getEntriesByType("resource").find((r) => r.name.includes("/_app/app."));
      const ms = (n) => Math.round(n ?? -1);
      return {
        doc: ms(nav.responseEnd),
        js: ms(js?.responseEnd),
        dcl: ms(nav.domContentLoadedEventEnd),
        drawn: ms(window.__drawn),
        fcp: ms(window.__fcp),
        lcp: ms(window.__lcp),
      };
    })()`);
    // The first run warms cf dev (its first request compiles the Worker); it is not counted.
    if (i > 0) {
      times.push(ms);
      paints.push(Number(t.lcp));
    }
    console.log(
      `${i === 0 ? "warm-up" : `run ${i}`}: ${ms} ms to the first block, ${JSON.stringify(t)}, ${(script / 1024).toFixed(0)} KB of script${csp.length ? `, CSP: ${csp.join(" | ")}` : ""}`,
    );
    await context.close();
  }
  const median = (xs: number[]) => xs.sort((a, b) => a - b)[Math.floor(xs.length / 2)];
  console.log(
    `median ${median(times)} ms to the first block (min ${times[0]}, max ${times.at(-1)}); median largest contentful paint ${median(paints)} ms (min ${paints[0]}, max ${paints.at(-1)})`,
  );
  await browser.close();
} finally {
  try {
    process.kill(-dev.pid, "SIGKILL");
  } catch {}
  rmSync(project, { recursive: true, force: true });
}
