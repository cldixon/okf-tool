/**
 * `bun run deploy`: applies D1 migrations to the account database, then runs `cf deploy`.
 * cf takes the database by ID, read from cloudflare.config.ts. Extra arguments go to `cf deploy`;
 * with --dry-run nothing remote is touched, migrations included. `--mode staging` deploys the
 * staging Worker with its own resources (cloudflare.config.ts).
 *
 *   bun run deploy [--mode staging] [--dry-run] [--message <text>] [...]
 */
const args = process.argv.slice(2);
const i = args.indexOf("--mode");
if (i !== -1 && args[i + 1]) process.env.OKF_MODE = args[i + 1];
// Imported after OKF_MODE is set: it reads the config for that deployment.
const { accountsDb, applyMigrations, WORKER_DIR } = await import("./cf");

if (!args.includes("--dry-run")) {
  const db = accountsDb();
  console.log(`D1 migrations for ${db.name} (${db.id}):`);
  console.log((await applyMigrations()).trim());
}
const deploy = Bun.spawn(["bunx", "cf", "deploy", ...args], {
  cwd: WORKER_DIR,
  env: { ...process.env, CF_SEND_TELEMETRY: "false" },
  stdout: "inherit",
  stderr: "inherit",
});
process.exit(await deploy.exited);

export {};
