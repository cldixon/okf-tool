/**
 * Runs the project's `cf` (the Cloudflare CLI, a dev dependency) for scripts, and reads binding
 * details from cloudflare.config.ts. cf resource commands take resource IDs, not names or bindings,
 * so D1 commands get the ID from the config.
 */
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import config, { deploymentFor } from "../cloudflare.config";
import { retryDelayMs, transientCfError } from "./cf-retry";
import { PROBE_RULE_REF, probeRule } from "./edge-rules";

export const WORKER_DIR = new URL("..", import.meta.url).pathname;

/** Where `cf dev` keeps local state (it runs the Wrangler bundler); local D1 commands use it too. */
export const LOCAL_STATE = join(WORKER_DIR, ".wrangler/state");

/** The deployment: TEMPRA_MODE=staging for staging, otherwise production (cloudflare.config.ts). */
export const MODE = process.env.TEMPRA_MODE || undefined;
const resolved = await config({ isPreview: false, mode: MODE });
const worker = await resolved.worker;
if (!worker) throw new Error("cloudflare.config.ts defines no worker.");

export const WORKER_NAME = worker.name;

/** Every Queue the Worker binds (SWEEP_QUEUE, AGENT_QUEUE, MAIL_QUEUE), by name. */
export function boundQueues(): string[] {
  return Object.values(worker?.env ?? {})
    .map((b) => b as { type?: string; name?: string })
    .filter((b) => b.type === "queue" && !!b.name)
    .map((b) => b.name as string);
}

/**
 * Creates the Queues the Worker binds that do not exist yet, so a deployment's Queues come from
 * cloudflare.config.ts like its other bindings: `bun run deploy` calls it before deploying, since
 * a Worker that binds a missing Queue fails to deploy. Safe to repeat; it never deletes one.
 */
export async function ensureQueues(): Promise<void> {
  const existing = new Set(
    (JSON.parse(await cf(["queues", "list"])) as { queue_name: string }[]).map((q) => q.queue_name),
  );
  for (const name of boundQueues()) {
    if (existing.has(name)) continue;
    console.log(`Creating Queue ${name}`);
    await cf(["queues", "create", "--queue-name", name]);
  }
}

/**
 * Sets the account database's read replication to what cloudflare.config.ts says for this
 * deployment (TEMPRA-85), so the setting lives in the config like the bindings: `bun run deploy`
 * calls it after the migrations. Does nothing when the config leaves it unset or it already
 * matches; safe to repeat.
 */
export async function ensureReadReplication(): Promise<void> {
  const want = deploymentFor(MODE).readReplication;
  if (!want) return;
  const db = accountsDb();
  const info = JSON.parse(await cf(["d1", "get", db.id])) as {
    read_replication?: { mode?: string };
  };
  const have = info.read_replication?.mode ?? "disabled";
  if (have === want) return;
  console.log(`D1 read replication for ${db.name}: ${have} -> ${want}`);
  await cf(["d1", "edit", db.id, "--read-replication-mode", want]);
}

interface RoutingRule {
  id: string;
  name?: string;
  enabled?: boolean;
  matchers?: { type: string; field?: string; value?: string }[];
  actions?: { type: string; value?: string[] }[];
}

/**
 * Makes the zone's incoming mail match `inboundMail` in cloudflare.config.ts for this deployment:
 * Email Routing enabled, each destination registered (Cloudflare mails it a verification link the
 * first time, and refuses a rule to it until the link is clicked, so the rules come on the first
 * run after that), and one rule per address forwarding to it, created or corrected. `"operator"` resolves to OPERATOR_EMAIL; without it the step is skipped.
 * Never deletes a rule or an address it does not manage. A failure here (a token without Email
 * Routing permission, say) is a warning, not a failed deploy: the rules already in place keep
 * working. Safe to repeat.
 */
export async function ensureEmailRouting(): Promise<void> {
  const inbound = deploymentFor(MODE).inboundMail;
  if (!inbound) return;
  const operator = process.env.OPERATOR_EMAIL?.trim();
  if (!operator) {
    console.log("Email Routing: OPERATOR_EMAIL is not set; skipped.");
    return;
  }
  const z = ["-z", inbound.zone];
  let step = "reading the zone's Email Routing settings";
  try {
    // Only to switch routing on once. Reading the settings takes Zone Settings Read, which the
    // rules and addresses do not; a token without it goes on to the rules, routing being on.
    let settings: { enabled?: boolean } | null = null;
    try {
      settings = JSON.parse(await cf(["email-routing", "settings", "get", ...z])) as {
        enabled?: boolean;
      };
    } catch (e) {
      console.log(
        `Email Routing: could not read the zone's settings (${cfReason(e)}); taking routing as on. Zone Settings Read lets deploy switch it on.`,
      );
    }
    if (settings && !settings.enabled) {
      step = "enabling Email Routing";
      console.log(`Email Routing: enabling on ${inbound.zone}`);
      await cf(["email-routing", "enable", ...z]);
    }
    step = "listing the destination addresses (Email Routing Addresses)";
    const addresses = JSON.parse(await cf(["email-routing", "addresses", "list"])) as {
      email: string;
      verified?: string | null;
    }[];
    const known = new Map(addresses.map((a) => [a.email.toLowerCase(), a]));
    if (!known.has(operator.toLowerCase())) {
      step = "registering the operator's address (Email Routing Addresses Edit)";
      console.log(
        "Email Routing: registered the operator's address; Cloudflare mails it a verification link, and the next deploy forwards to it once it is clicked",
      );
      await cf(["email-routing", "addresses", "create", "--email", operator]);
      return;
    }
    // Cloudflare refuses a rule to an unverified destination, so the rules wait for the link.
    if (!known.get(operator.toLowerCase())?.verified) {
      console.log(
        "Email Routing: the operator's address is not verified yet (the link Cloudflare mailed it); rules are left for the next deploy",
      );
      return;
    }
    step = "listing the zone's rules (Email Routing Rules)";
    const rules = JSON.parse(
      await cf(["email-routing", "rules", "list-account", ...z]),
    ) as RoutingRule[];
    step = "creating or correcting a rule (Email Routing Rules Edit)";
    for (const route of inbound.routes) {
      const to = route.to === "operator" ? operator : route.to;
      const matchers = [{ type: "literal", field: "to", value: route.address }];
      const actions = [{ type: "forward", value: [to] }];
      const rule = rules.find((r) =>
        r.matchers?.some(
          (m) => m.type === "literal" && m.field === "to" && m.value === route.address,
        ),
      );
      const fields = [
        "--name",
        `${route.address} to ${route.to}`,
        "--enabled",
        "true",
        "--matchers",
        JSON.stringify(matchers),
        "--actions",
        JSON.stringify(actions),
      ];
      if (!rule) {
        console.log(`Email Routing: forwarding ${route.address} to the ${route.to}`);
        await cf(["email-routing", "rules", "create", ...z, ...fields]);
      } else if (
        !rule.enabled ||
        rule.actions?.length !== 1 ||
        rule.actions[0]?.type !== "forward" ||
        JSON.stringify(rule.actions[0]?.value ?? []) !== JSON.stringify([to])
      ) {
        console.log(`Email Routing: correcting the rule for ${route.address}`);
        await cf(["email-routing", "rules", "update", rule.id, ...z, ...fields]);
      }
    }
  } catch (e) {
    console.log(
      `::warning::Email Routing not applied: ${step} was refused (${cfReason(e)}). The rules in place keep working.`,
    );
  }
}

/** cf's own reason for a failure (an API error such as "[10000] Authentication error"). */
function cfReason(e: unknown): string {
  // The first line of cf's output only names the command; the API's error is a later one.
  const lines = String((e as Error)?.message ?? e)
    .split("\n")
    .map((l) => l.replace(/^[│┌└\s]+/, "").trim());
  return lines.find((l) => /\[\d+\]/.test(l)) ?? lines.find(Boolean) ?? "unknown error";
}

interface ZoneRule {
  id: string;
  ref?: string;
  expression?: string;
  action?: string;
  enabled?: boolean;
  description?: string;
}

/**
 * Makes the zone's custom WAF rule against scanners' probes match `probeRule()` (TEMPRA-290,
 * scripts/edge-rules.ts), when `edgeRules` is set for this deployment: the zone's entry point
 * ruleset for `http_request_firewall_custom` is made with only our rule when it has none, else
 * our rule (found by its `ref`) is added or corrected; other rules are never touched or reordered.
 * A failure (a token without Zone WAF Edit, say) is a warning, not a failed deploy: the Worker
 * answers probes with 404s anyway. Safe to repeat.
 */
export async function ensureEdgeRules(): Promise<void> {
  const edge = deploymentFor(MODE).edgeRules;
  if (!edge) return;
  const z = ["-z", edge.zone];
  const phase = "http_request_firewall_custom";
  const want = probeRule();
  try {
    let ruleset: { id: string; rules?: ZoneRule[] } | null = null;
    try {
      ruleset = JSON.parse(
        await cf(["rulesets", "account-rulesets", "phases", "get", phase, ...z]),
      ) as { id: string; rules?: ZoneRule[] };
    } catch (e) {
      // No entry point yet (10003): it is made below, holding our rule alone.
      if (!/\[10003\]/.test(String((e as Error)?.message ?? e))) throw e;
    }
    if (!ruleset) {
      console.log(`Edge rules: blocking scanners' probes on ${edge.zone}`);
      await cf([
        "rulesets",
        "account-rulesets",
        "phases",
        "update",
        phase,
        ...z,
        "--rules",
        JSON.stringify([want]),
      ]);
      return;
    }
    const have = ruleset.rules?.find((r) => r.ref === PROBE_RULE_REF);
    if (!have) {
      console.log(`Edge rules: adding the rule against scanners' probes on ${edge.zone}`);
      await cf([
        "rulesets",
        "account-rulesets",
        "rules",
        "create",
        ruleset.id,
        ...z,
        "--body",
        JSON.stringify(want),
      ]);
    } else if (
      have.expression !== want.expression ||
      have.action !== want.action ||
      have.enabled !== want.enabled ||
      have.description !== want.description
    ) {
      console.log(`Edge rules: correcting the rule against scanners' probes on ${edge.zone}`);
      await cf([
        "rulesets",
        "account-rulesets",
        "rules",
        "update",
        have.id,
        "--ruleset-id",
        ruleset.id,
        ...z,
        "--body",
        JSON.stringify(want),
      ]);
    }
  } catch (e) {
    console.log(
      `::warning::Edge rules not applied (${cfReason(e)}). The token needs Zone WAF Edit; the Worker still answers probes itself.`,
    );
  }
}

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
  /**
   * Per attempt; a call that times out, or fails with a transient API error, is retried twice.
   * Default 20 s local, 120 s remote.
   */
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
 * and is retried, and so is one that fails with a transient error from Cloudflare's API (a
 * timeout, a reset connection, a 5xx, a 429; TEMPRA-52); every call made through this helper
 * must be safe to repeat.
 */
export async function cf(args: string[], opts: CfOptions = {}): Promise<string> {
  const full = ["bunx", "cf", ...args];
  if (opts.local) full.push("--local", "--persist-to", opts.persistTo ?? LOCAL_STATE);
  const timeout = opts.timeoutMs ?? (opts.local ? 20_000 : 120_000);
  const attempts = 3;
  for (let attempt = 1; ; attempt++) {
    const dir = mkdtempSync(join(tmpdir(), "tempra-cf-"));
    const outFile = join(dir, "out");
    const errFile = join(dir, "err");
    try {
      // Its own process group: cf runs under bunx as a child process, which a kill of bunx alone
      // leaves running (the gate leaked one per call, reparented to init, until the runner ended).
      const p = Bun.spawn(full, {
        detached: true,
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
          break;
        }
        if (Date.now() - started > timeout) break;
      }
      // The whole group, whether cf exited or not: what it started must not outlive the call.
      try {
        process.kill(-p.pid, "SIGKILL");
      } catch {
        // The group is already gone.
      }
      await p.exited;
      const out = readFileSync(outFile, "utf8");
      const err = readFileSync(errFile, "utf8");
      // A command that wants confirmation prints "Aborted." without --force and still exits 0.
      if (/^Aborted\.\s*$/m.test(`${out}\n${err}`)) {
        throw new Error(
          `cf ${args.join(" ")} asked for confirmation (pass --force):\n${err}${out}`,
        );
      }
      if (lingered || p.exitCode === 0) return out;
      const timedOut = !lingered && p.signalCode !== null;
      if (timedOut && attempt < attempts) {
        console.error(
          `cf ${args.slice(0, 3).join(" ")} timed out; retrying (${attempt}/${attempts - 1})`,
        );
        continue;
      }
      if (!timedOut && attempt < attempts && transientCfError(`${err}\n${out}`)) {
        const wait = retryDelayMs(attempt);
        console.error(
          `cf ${args.slice(0, 3).join(" ")} failed with a transient error; retrying in ${wait / 1000} s (${attempt}/${attempts - 1})`,
        );
        await Bun.sleep(wait);
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

/** Runs SQL against a D1 database by id; returns the columns and rows of the last statement. */
export async function d1Raw(
  id: string,
  sql: string,
  opts: CfOptions = {},
): Promise<{ columns: string[]; rows: unknown[][] }> {
  type Result = { results?: { columns?: string[]; rows?: unknown[][] } };
  const out = JSON.parse(await cf(["d1", "raw", id, "--sql", sql], opts)) as Result[] | Result;
  const last = Array.isArray(out) ? out.at(-1) : out;
  return { columns: last?.results?.columns ?? [], rows: last?.results?.rows ?? [] };
}

/** Runs SQL against the account database; returns the rows of the last statement. */
export async function d1Sql(sql: string, opts: CfOptions = {}): Promise<unknown[][]> {
  return (await d1Raw(accountsDb().id, sql, opts)).rows;
}
