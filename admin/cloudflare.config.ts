import { bindings, defineConfig } from "cf/config";
import { COMPATIBILITY, deploymentFor } from "../worker/cloudflare.config.ts";

/**
 * The operator's portal (TEMPRA-278, tempra-dev `decisions/an-admin-portal.md`): `tempra-admin` on
 * admin.tempra.dev, `tempra-admin-staging` on admin-staging.tempra.dev, from the `admin` of the
 * app's deployment (worker/cloudflare.config.ts), which it calls through OPERATOR. No previews.
 *
 * Cloudflare Access guards the host. scripts/deploy.ts makes sure of its application first, then
 * deploys with what the Worker needs to check Access's token: the team domain
 * (TEMPRA_ACCESS_TEAM) and the application's audience tag (TEMPRA_ACCESS_AUD). Without them the
 * Worker refuses every request. With no mode (cf dev, types) nothing is attached or bound.
 *
 * Secrets (typed in src/env.d.ts): OPERATOR_EMAIL, the one person let in; ANALYTICS_TOKEN, optional,
 * an Account Analytics Read token for the daily actives (Analytics Engine's SQL API).
 */
export default defineConfig(({ mode }) => {
  const local = !mode;
  if (mode === "preview") throw new Error("The operator's portal has no previews.");
  const app = deploymentFor(mode);
  const admin = app.admin;
  if (!admin) throw new Error(`The ${app.name} deployment has no operator's portal.`);
  const env =
    (globalThis as { process?: { env: Record<string, string | undefined> } }).process?.env ?? {};
  return {
    worker: {
      name: admin.name,
      entrypoint: "src/index.ts",
      ...COMPATIBILITY,
      assets: { htmlHandling: "none", notFoundHandling: "none" },
      domains: local ? [] : [admin.host],
      workersDev: false,
      env: {
        ORIGIN: bindings.text(local ? "http://localhost:8787" : `https://${admin.host}`),
        ACCESS_TEAM: bindings.text(local ? "" : (env.TEMPRA_ACCESS_TEAM ?? "")),
        ACCESS_AUD: bindings.text(local ? "" : (env.TEMPRA_ACCESS_AUD ?? "")),
        // Where the daily actives are read from: the app's metering dataset, on this account.
        USAGE_DATASET: bindings.text(app.usage ?? "tempra_usage"),
        ACCOUNT_ID: bindings.text(local ? "" : (env.CLOUDFLARE_ACCOUNT_ID ?? "")),
        // The app's Worker, its Operator entrypoint (worker/src/index.ts). Not bound locally.
        ...(local
          ? {}
          : { OPERATOR: bindings.worker({ worker: app.name, exportName: "Operator" }) }),
      },
    },
  };
});
