/**
 * `bun run deploy`: applies D1 migrations to the account database, then runs `cf deploy`.
 * cf takes the database by ID, read from cloudflare.config.ts. Extra arguments go to `cf deploy`;
 * with --dry-run nothing remote is touched, migrations included.
 *
 *   bun run deploy [--dry-run] [--message <text>] [...]
 */
import { accountsDb, applyMigrations, WORKER_DIR } from "./cf";

const args = process.argv.slice(2);
if (!args.includes("--dry-run")) {
  const db = accountsDb();
  console.log(`D1 migrations for ${db.name} (${db.id}):`);
  console.log(applyMigrations().trim());
}
const deploy = Bun.spawn(["bunx", "cf", "deploy", ...args], {
  cwd: WORKER_DIR,
  env: { ...process.env, CF_SEND_TELEMETRY: "false" },
  stdout: "inherit",
  stderr: "inherit",
});
process.exit(await deploy.exited);
