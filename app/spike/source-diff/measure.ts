/**
 * TEMPRA-291's measurement (`bun spike/source-diff/measure.ts` in app/): builds the spike with
 * Vite as the app's build does (an entry and the chunk it imports on demand), serves it with the
 * app shell's CSP (`script-src 'self'`, `style-src 'self'`) and without one, draws the sample in
 * Chromium in each mode, and prints what the CSP refused, whether the drawing matches the one
 * with no CSP, and the chunk's size. `--screenshots <dir>` saves each drawing.
 */
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { gzipSync } from "bun";
import { build, type Plugin, type Rollup } from "vite";

const HERE = import.meta.dir;
const OUT = join(HERE, "dist");
const shots = process.argv.includes("--screenshots")
  ? process.argv[process.argv.indexOf("--screenshots") + 1]
  : undefined;

/** The app shell's CSP (worker/src/ui/spa.ts), as far as this page needs it. */
const CSP =
  "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; font-src 'self'";

/**
 * What the chunk leaves out of Pierre's diffs: Shiki's catalogue of grammars and themes, its
 * WebAssembly engine, Pierre's other highlighter and its own theme catalogue. The spike registers
 * the one grammar and the one theme it uses.
 */
const STUBS: Record<string, string> = {
  "shiki/langs": "export const bundledLanguages = {};",
  "shiki/wasm": "export default undefined;",
  "shiki/engine/oniguruma":
    "export function createOnigurumaEngine() { throw new Error('no wasm'); }",
  "@pierre/theming/themes": "export const themes = { getTheme() { return undefined; } };",
  "@pierre/highlights/themes/loader": "export const themes = {};",
  "@pierre/highlights":
    "export class LiveTokenizer {} export function codeToTokens() { throw new Error('no highlights'); } export function isSupportedLanguage() { return false; }",
};
const stubs: Plugin = {
  name: "spike-stubs",
  enforce: "pre",
  resolveId(id, importer) {
    if (id in STUBS) return `\0stub:${id}`;
    if (id === "@shikijs/langs/markdown") {
      const pierre = Bun.resolveSync("@pierre/diffs", join(HERE, "../.."));
      return Bun.resolveSync("@shikijs/langs/markdown", Bun.resolveSync("shiki/langs", pierre));
    }
    void importer;
    return null;
  },
  load(id) {
    return id.startsWith("\0stub:") ? STUBS[id.slice("\0stub:".length)] : null;
  },
};

async function bundle() {
  const result = (await build({
    root: HERE,
    configFile: false,
    logLevel: "warn",
    mode: "production",
    define: { "process.env.NODE_ENV": JSON.stringify("production") },
    plugins: [stubs],
    build: {
      write: false,
      target: "es2022",
      minify: true,
      modulePreload: false,
      rollupOptions: {
        input: join(HERE, "entry.ts"),
        output: { format: "es", entryFileNames: "entry.js", chunkFileNames: "[name]-[hash].js" },
      },
    },
  })) as Rollup.RollupOutput | Rollup.RollupOutput[];
  const output = (Array.isArray(result) ? result[0] : result) as Rollup.RollupOutput;
  rmSync(OUT, { recursive: true, force: true });
  mkdirSync(OUT, { recursive: true });
  const files: { name: string; bytes: number; gzip: number }[] = [];
  for (const o of output.output) {
    if (o.type !== "chunk") continue;
    writeFileSync(join(OUT, o.fileName), o.code);
    files.push({ name: o.fileName, bytes: o.code.length, gzip: gzipSync(o.code).length });
  }
  writeFileSync(
    join(OUT, "index.html"),
    '<!doctype html><html lang="en"><head><meta charset="utf-8"><title>spike</title></head><body><main id="root"></main><script type="module" src="/entry.js"></script></body></html>',
  );
  return files;
}

type Report = {
  violations: { directive: string; sample: string }[];
  styleElements: number;
  styleAttributes: number;
  adoptedSheets: number;
  rows: number;
  fingerprint: Record<string, unknown>;
  sampleLine?: string;
  loaded?: unknown;
};

async function main() {
  const files = await bundle();
  const server = Bun.serve({
    port: 0,
    fetch(req) {
      const url = new URL(req.url);
      const name = url.pathname === "/" ? "index.html" : url.pathname.slice(1);
      const file = Bun.file(join(OUT, name));
      if (name.includes("/") || !(name.endsWith(".js") || name.endsWith(".html")))
        return new Response("Not found", { status: 404 });
      const type = name.endsWith(".js") ? "text/javascript" : "text/html";
      const headers: Record<string, string> = { "Content-Type": type };
      if (url.searchParams.get("csp") !== "0") headers["Content-Security-Policy"] = CSP;
      return new Response(file, { headers });
    },
  });
  const { chromium } = await import(
    Bun.resolveSync("playwright-core", join(HERE, "../../../worker"))
  );
  const browser = await chromium.launch({
    executablePath: process.env.CHROME_PATH ?? "/opt/pw-browsers/chromium",
  });
  const page = await browser.newPage({ viewport: { width: 900, height: 900 } });
  const consoleCsp: string[] = [];
  page.on("console", (m: { text(): string }) => {
    if (/Content Security Policy/.test(m.text())) consoleCsp.push(m.text().slice(0, 120));
  });
  const loaded = new Set<string>();
  page.on("request", (r: { url(): string }) => {
    const name = new URL(r.url()).pathname.slice(1);
    if (name.endsWith(".js")) loaded.add(name);
  });
  const size = (names: Set<string>) => {
    const picked = files.filter((f) => names.has(f.name));
    return {
      files: picked.map((f) => f.name),
      bytes: picked.reduce((n, f) => n + f.bytes, 0),
      gzip: picked.reduce((n, f) => n + f.gzip, 0),
    };
  };
  const results: Record<string, unknown>[] = [];
  for (const mode of ["plain", "markdown"]) {
    for (const layout of ["unified", "split"]) {
      const run = async (csp: boolean, cssom: 0 | 1 | 2): Promise<Report> => {
        loaded.clear();
        const q = `?mode=${mode}&layout=${layout}&cssom=${cssom}&csp=${csp ? 1 : 0}`;
        await page.goto(`http://localhost:${server.port}/${q}`);
        await page.waitForSelector("body[data-done]", { timeout: 15_000 });
        if (shots) {
          mkdirSync(shots, { recursive: true });
          await page.screenshot({
            path: join(shots, `${mode}-${layout}-csp${csp ? 1 : 0}-cssom${cssom}.png`),
            fullPage: true,
          });
        }
        const report = (await page.evaluate("window.__spike")) as Report;
        report.loaded = size(loaded);
        return report;
      };
      const baseline = await run(false, 0);
      const strict = await run(true, 0);
      const shimmed = await run(true, 1);
      const rewrite = await run(true, 2);
      const same = (r: Report) =>
        JSON.stringify(r.fingerprint) === JSON.stringify(baseline.fingerprint);
      const byDirective = (r: Report) =>
        r.violations.reduce<Record<string, number>>((n, v) => {
          n[v.directive] = (n[v.directive] ?? 0) + 1;
          return n;
        }, {});
      results.push({
        mode,
        layout,
        rows: baseline.rows,
        loaded: baseline.loaded,
        sampleLine: baseline.sampleLine,
        styleElements: baseline.styleElements,
        styleAttributes: baseline.styleAttributes,
        cspViolations: byDirective(strict),
        cspSamples: [...new Set(strict.violations.map((v) => v.sample))].slice(0, 6),
        cspMatchesBaseline: same(strict),
        shimViolations: byDirective(shimmed),
        shimMatchesBaseline: same(shimmed),
        rewriteViolations: byDirective(rewrite),
        rewriteMatchesBaseline: same(rewrite),
        fingerprints: {
          baseline: baseline.fingerprint,
          csp: strict.fingerprint,
          shim: shimmed.fingerprint,
          rewrite: rewrite.fingerprint,
        },
      });
    }
  }
  await browser.close();
  server.stop(true);
  console.log(
    JSON.stringify({ chunks: files, results, consoleCspSample: consoleCsp.slice(0, 3) }, null, 2),
  );
}

await main();
