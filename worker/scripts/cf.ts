/**
 * Runs the project's `cf` (the Cloudflare CLI, a dev dependency) for scripts, and reads binding
 * details from cloudflare.config.ts. cf resource commands take resource IDs, not names or bindings,
 * so D1 commands get the ID from the config.
 */
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import config from "../cloudflare.config";

export const WORKER_DIR = new URL("..", import.meta.url).pathname;

/** Where `cf dev` keeps local state (it runs the Wrangler bundler); local D1 commands use it too. */
export const LOCAL_STATE = join(WORKER_DIR, ".wrangler/state");

/** The deployment: OKF_MODE=staging for staging, otherwise production (cloudflare.config.ts). */
export const MODE = process.env.OKF_MODE || undefined;
const resolved = await config({ isPreview: false, mode: MODE });
const worker = await resolved.worker;
if (!worker) throw new Error("cloudflare.config.ts defines no worker.");

export const WORKER_NAME = worker.name;

/** The account database (binding DB). */
export function accountsDb(): { name: string; id: string } {
  const db = worker?.env?.DB as { type?: string; name?: string; id?: string } | undefined;
  if (db?.type !== "d1" || !db.id || !db.name) {
    throw new Error("cloudflare.config.ts must bind DB to a D1 database with a name and an id.");
  }
  return { name: db.name, id: db.id };
}

export interface CfOptions {
  /** Run against local dev state instead of the account. */
  local?: boolean;
  /** Local state directory; defaults to LOCAL_STATE. */
  persistTo?: string;
  cwd?: string;
  /** Per attempt; a call that times out is retried twice. Default 20 s local, 120 s remote. */
  timeoutMs?: number;
}

/** Whether `text` is a complete JSON document (cf prints its result as one at the end). */
function completeJson(text: string): boolean {
  if (!text.trim()) return false;
  try {
    JSON.parse(text);
    return true;
  } catch {
    return false;
  }
}

/**
 * Runs `cf <args>`, resolving to stdout (JSON for most commands); rejects with cf's output on
 * failure. cf (beta) sometimes finishes its work and prints its result, then never exits: a
 * confirmation prompt it already answered keeps it alive (seen on `d1 migrations apply`, and
 * now and then on `d1 raw`). So once stdout holds a complete JSON result and cf has been quiet
 * for a moment, the result counts and the process is stopped. A call that still hangs times out
 * and is retried; every call made through this helper must be safe to repeat.
 */
export async function cf(args: string[], opts: CfOptions = {}): Promise<string> {
  const full = ["bunx", "cf", ...args];
  if (opts.local) full.push("--local", "--persist-to", opts.persistTo ?? LOCAL_STATE);
  const timeout = opts.timeoutMs ?? (opts.local ? 20_000 : 120_000);
  const attempts = 3;
  for (let attempt = 1; ; attempt++) {
    const dir = mkdtempSync(join(tmpdir(), "okf-cf-"));
    const outFile = join(dir, "out");
    const errFile = join(dir, "err");
    try {
      const p = Bun.spawn(full, {
        cwd: opts.cwd ?? WORKER_DIR,
        env: { ...process.env, CF_SEND_TELEMETRY: "false", CI: "1" },
        stdin: "ignore",
        stdout: Bun.file(outFile),
        stderr: Bun.file(errFile),
      });
      let exited = false;
      p.exited.then(() => {
        exited = true;
      });
      const started = Date.now();
      let lastOut = "";
      let quietSince = Date.now();
      let lingered = false;
      while (!exited) {
        await Bun.sleep(250);
        if (exited) break;
        const out = readFileSync(outFile, "utf8");
        if (out !== lastOut) {
          lastOut = out;
          quietSince = Date.now();
        } else if (completeJson(out) && Date.now() - quietSince > 1500) {
          lingered = true;
          p.kill(9);
          break;
        }
        if (Date.now() - started > timeout) {
          p.kill(9);
          break;
        }
      }
      await p.exited;
      const out = readFileSync(outFile, "utf8");
      if (lingered || p.exitCode === 0) return out;
      const err = readFileSync(errFile, "utf8");
      const timedOut = !lingered && p.signalCode !== null;
      if (timedOut && attempt < attempts) {
        console.error(
          `cf ${args.slice(0, 3).join(" ")} timed out; retrying (${attempt}/${attempts - 1})`,
        );
        continue;
      }
      const why = timedOut ? "timed out" : `exited ${p.exitCode}`;
      throw new Error(`cf ${args.join(" ")} ${why}:\n${err}${out}`);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
}

/** Applies D1 migrations (./migrations) to the account database, locally or remotely. */
export function applyMigrations(opts: CfOptions = {}): Promise<string> {
  return cf(["d1", "migrations", "apply", accountsDb().id, "--dir", "migrations"], opts);
}

/** Runs SQL against the account database; returns the rows of the last statement. */
export async function d1Sql(sql: string, opts: CfOptions = {}): Promise<unknown[][]> {
  const out = JSON.parse(await cf(["d1", "raw", accountsDb().id, "--sql", sql], opts)) as
    | { results?: { rows?: unknown[][] } }[]
    | { results?: { rows?: unknown[][] } };
  const last = Array.isArray(out) ? out.at(-1) : out;
  return last?.results?.rows ?? [];
}
