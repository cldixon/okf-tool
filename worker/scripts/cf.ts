/**
 * Runs the project's `cf` (the Cloudflare CLI, a dev dependency) for scripts, and reads binding
 * details from cloudflare.config.ts. cf resource commands take resource IDs, not names or bindings,
 * so D1 commands get the ID from the config.
 */
import { join } from "node:path";
import config from "../cloudflare.config";

export const WORKER_DIR = new URL("..", import.meta.url).pathname;

/** Where `cf dev` keeps local state (it runs the Wrangler bundler); local D1 commands use it too. */
export const LOCAL_STATE = join(WORKER_DIR, ".wrangler/state");

const resolved = await config;
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
}

/** Runs `cf <args>`, returning stdout (JSON for most commands); throws with cf's output on failure. */
export function cf(args: string[], opts: CfOptions = {}): string {
  const full = ["bunx", "cf", ...args];
  if (opts.local) full.push("--local", "--persist-to", opts.persistTo ?? LOCAL_STATE);
  const p = Bun.spawnSync(full, {
    cwd: opts.cwd ?? WORKER_DIR,
    env: { ...process.env, CF_SEND_TELEMETRY: "false", CI: "1" },
  });
  if (p.exitCode !== 0) {
    throw new Error(`cf ${args.join(" ")} failed:\n${p.stderr.toString()}${p.stdout.toString()}`);
  }
  return p.stdout.toString();
}

/** Applies D1 migrations (./migrations) to the account database, locally or remotely. */
export function applyMigrations(opts: CfOptions = {}): string {
  return cf(["d1", "migrations", "apply", accountsDb().id, "--dir", "migrations"], opts);
}

/** Runs SQL against the account database; returns the rows of the last statement. */
export function d1Sql(sql: string, opts: CfOptions = {}): unknown[][] {
  const out = JSON.parse(cf(["d1", "raw", accountsDb().id, "--sql", sql], opts)) as
    | { results?: { rows?: unknown[][] } }[]
    | { results?: { rows?: unknown[][] } };
  const last = Array.isArray(out) ? out.at(-1) : out;
  return last?.results?.rows ?? [];
}
