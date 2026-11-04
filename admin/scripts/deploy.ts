/**
 * Deploys the operator's portal (TEMPRA-278):
 *
 *   OPERATOR_EMAIL=… bun run deploy --mode production|staging [--dry-run]
 *
 * 1. Cloudflare Access (scripts/access.ts): the one-time PIN login, the policy allowing only
 *    OPERATOR_EMAIL, the application over the portal's host with 2-hour sessions. If this fails
 *    (most often: the API token lacks the Access permissions), it stops and deploys nothing.
 * 2. `cf deploy` with the team domain and the application's audience tag, which the Worker checks
 *    every token against.
 * 3. The Worker's OPERATOR_EMAIL secret, and ANALYTICS_TOKEN when it is set here.
 *
 * With --dry-run it reads Access and says what it would change, and `cf deploy --dry-run` builds
 * the Worker; nothing is written. The app's Worker (worker/) must be deployed first: OPERATOR
 * binds to its Operator entrypoint. Needs CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID.
 */
import { join } from "node:path";
import { parseArgs } from "node:util";
import { deploymentFor } from "../../worker/cloudflare.config";
import { cloudflareApi, ensureAccess } from "./access";

const { values } = parseArgs({
  args: process.argv.slice(2),
  options: { mode: { type: "string" }, "dry-run": { type: "boolean" } },
});
const mode = values.mode ?? "production";
const dryRun = values["dry-run"] ?? false;
if (mode !== "production" && mode !== "staging") {
  console.error("Usage: bun run deploy --mode production|staging [--dry-run]");
  process.exit(1);
}
const admin = deploymentFor(mode).admin;
if (!admin) throw new Error(`The ${mode} deployment has no operator's portal.`);
const account = process.env.CLOUDFLARE_ACCOUNT_ID ?? "";
const token = process.env.CLOUDFLARE_API_TOKEN ?? "";
const operator = (process.env.OPERATOR_EMAIL ?? "").trim();
if (!account || !token)
  throw new Error("CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN are needed.");
if (!operator) throw new Error("OPERATOR_EMAIL is needed: the one person Access lets in.");

const api = cloudflareApi(account, token);
let ensured: Awaited<ReturnType<typeof ensureAccess>>;
try {
  ensured = await ensureAccess(
    api,
    { name: admin.name, host: admin.host, operator, sessionDuration: "2h" },
    dryRun,
  );
} catch (e) {
  console.error(
    `Cloudflare Access for ${admin.host} could not be ensured, so nothing is deployed.`,
  );
  console.error(String(e instanceof Error ? e.message : e));
  process.exit(1);
}
console.log(
  ensured.changes.length
    ? `Access${dryRun ? " (dry run, would)" : ""}: ${ensured.changes.join("; ")}.`
    : "Access: as configured.",
);
if (!dryRun && !ensured.aud) {
  console.error("Access gave no audience tag for the application; nothing is deployed.");
  process.exit(1);
}

const p = Bun.spawn(["bunx", "cf", "deploy", "--mode", mode, ...(dryRun ? ["--dry-run"] : [])], {
  cwd: join(import.meta.dir, ".."),
  env: {
    ...process.env,
    CF_SEND_TELEMETRY: "false",
    TEMPRA_ACCESS_TEAM: ensured.team,
    TEMPRA_ACCESS_AUD: ensured.aud,
  },
  stdout: "inherit",
  stderr: "inherit",
});
const code = await p.exited;
if (code !== 0 || dryRun) process.exit(code);

/** A secret on the portal's Worker, through the API (the value only in the request body). */
async function secret(name: string, text: string) {
  const r = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${account}/workers/scripts/${admin?.name}/secrets`,
    {
      method: "PUT",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ name, text, type: "secret_text" }),
    },
  );
  if (!r.ok) throw new Error(`Setting ${name} on ${admin?.name}: ${r.status}`);
  console.log(`Set ${name} on ${admin?.name}`);
}
await secret("OPERATOR_EMAIL", operator.toLowerCase());
const analytics = process.env.ANALYTICS_TOKEN ?? "";
if (analytics) await secret("ANALYTICS_TOKEN", analytics);
else console.log("ANALYTICS_TOKEN is not set here; the portal's secret is left as it is.");
