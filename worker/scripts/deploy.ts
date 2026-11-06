/**
 * `bun run deploy`: applies D1 migrations to the account database, creates the Queues the Worker
 * binds that do not exist yet (scripts/cf.ts `ensureQueues`), then runs `cf deploy`.
 * cf takes the database by ID, read from cloudflare.config.ts. Extra arguments go to `cf deploy`;
 * with --dry-run nothing remote is touched, migrations included. `--mode staging` deploys the
 * staging Worker with its own resources (cloudflare.config.ts).
 *
 * The deployment's diagram render Worker (render/, TEMPRA-165: tempra-render, tempra-render-staging,
 * tempra-render-pr-N) is deployed first, with the same arguments, because the main Worker binds to
 * it (RENDER); a dry run builds and checks both.
 *
 *   bun run deploy [--mode staging] [--dry-run] [--message <text>] [...]
 */
import { join } from "node:path";

const args = process.argv.slice(2);
// Production unless told otherwise; the custom domain is attached only with an explicit mode.
if (!args.includes("--mode")) args.push("--mode", "production");
const i = args.indexOf("--mode");
if (args[i + 1]) process.env.TEMPRA_MODE = args[i + 1];
// Imported after TEMPRA_MODE is set: it reads the config for that deployment.
const {
  accountsDb,
  applyMigrations,
  ensureEdgeRules,
  ensureEmailRouting,
  ensureQueues,
  ensureReadReplication,
  WORKER_DIR,
} = await import("./cf");
const { PROPAGATION_DELAYS_MS, workerNotYetVisible } = await import("./cf-retry");

if (!args.includes("--dry-run")) {
  const db = accountsDb();
  console.log(`D1 migrations for ${db.name} (${db.id}):`);
  console.log((await applyMigrations()).trim());
  // The Queues the Worker binds, made if missing (a Worker binding a missing Queue fails to deploy).
  await ensureQueues();
  // The account database's read replication, as the config sets it (TEMPRA-85).
  await ensureReadReplication();
  // Incoming mail on the zone, as the config sets it (hello@tempra.dev to the operator).
  await ensureEmailRouting();
  // The zone's rule against scanners' probes, as the config sets it (TEMPRA-290).
  await ensureEdgeRules();
}
/** Runs `cf deploy` once in `cwd`, streaming its output to the log; resolves to its exit code and output. */
async function deployOnce(cwd: string): Promise<{ code: number; output: string }> {
  const p = Bun.spawn(["bunx", "cf", "deploy", ...args], {
    cwd,
    env: { ...process.env, CF_SEND_TELEMETRY: "false" },
    stdout: "pipe",
    stderr: "pipe",
  });
  let output = "";
  const tee = async (from: ReadableStream<Uint8Array>, to: NodeJS.WriteStream) => {
    const decoder = new TextDecoder();
    for await (const chunk of from) {
      to.write(chunk);
      output += decoder.decode(chunk, { stream: true });
    }
  };
  await Promise.all([tee(p.stdout, process.stdout), tee(p.stderr, process.stderr)]);
  return { code: await p.exited, output };
}

/**
 * Deploys the project in `cwd`. The first deploy of a new Worker can upload it and then fail to
 * attach its domain because the Worker is not visible yet (10007); deploying again is safe, so it
 * is retried for about 60 s.
 */
async function deploy(cwd: string): Promise<number> {
  for (let attempt = 0; ; attempt++) {
    const { code, output } = await deployOnce(cwd);
    const wait = PROPAGATION_DELAYS_MS[attempt];
    if (code === 0 || wait === undefined || !workerNotYetVisible(output)) return code;
    console.error(
      `cf deploy: the new Worker is not visible yet (10007); deploying again in ${wait / 1000} s (${attempt + 1}/${PROPAGATION_DELAYS_MS.length})`,
    );
    await Bun.sleep(wait);
  }
}

// The render Worker first: the main Worker's RENDER binding names it.
console.log("The render Worker (render/):");
const rendered = await deploy(join(WORKER_DIR, "render"));
if (rendered !== 0) process.exit(rendered);
console.log("The main Worker:");
process.exit(await deploy(WORKER_DIR));
