import { bindings, defineConfig, exports, triggers } from "cf/config";

/**
 * The Worker and its bindings, for the `cf` CLI (`cf dev`, `cf build`, `cf deploy`, `cf workers
 * types`). Scripts import this file too (scripts/cf.ts), so keep it free of Worker code imports.
 *
 * `--mode staging` gives a separate Worker with its own D1, R2 and KV (v2 spec: Operations);
 * anything else is production (and local dev).
 */

interface Deployment {
  name: string;
  d1: { name: string; id: string };
  r2: string;
  kv: string;
  /**
   * The address sign-in links and alerts come from. Empty until a domain is onboarded for
   * Cloudflare Email Service (v2 spec: open question 9); then the EMAIL binding is added.
   */
  mailFrom: string;
}

const PRODUCTION: Deployment = {
  name: "okf-service",
  d1: { name: "okf-accounts", id: "c36c4e44-2d34-4053-9fee-3ac7f1ad6c0c" },
  r2: "okf-blobs",
  kv: "0b8fe9060b9645749d11d6083793295a",
  // mail.tempra.dev is onboarded for Cloudflare Email Sending.
  mailFrom: "noreply@mail.tempra.dev",
};

/** Staging: no Cloudflare Access, so sign-in is by email link only (v2 spec: Operations). */
const STAGING: Deployment = {
  name: "okf-service-staging",
  d1: { name: "okf-accounts-staging", id: "e158a54a-c209-48d6-9265-9a688cffedb8" },
  r2: "okf-blobs-staging",
  kv: "f205ae5ac0af4c3aa1f3a8848ff903f5",
  mailFrom: "noreply@mail.tempra.dev",
};

export default defineConfig(({ mode }) => {
  const d = mode === "staging" ? STAGING : PRODUCTION;
  if (!d.d1.id || !d.kv) {
    throw new Error(
      `The ${d.name} deployment's D1 and KV ids are not set in cloudflare.config.ts.`,
    );
  }
  return {
    worker: {
      name: d.name,
      entrypoint: "src/index.ts",
      compatibilityDate: "2026-09-01",
      // global_fetch_strictly_public: outbound fetch cannot reach private addresses; required for
      // OAuth Client ID Metadata Documents (the Worker fetches a URL an MCP client names).
      compatibilityFlags: ["nodejs_compat", "global_fetch_strictly_public"],
      observability: { enabled: true },

      // The daily blob sweep and operator digest (v2 spec: A3), after the libraries' 03:00 exports.
      triggers: [triggers.scheduled({ schedule: "30 4 * * *" })],

      // One SQLite-backed Durable Object per library (spec: Backend architecture). Declared as an
      // export; this replaces Wrangler's `migrations` history (its v1 created the same class).
      exports: {
        Library: exports.durableObject({ storage: "sqlite" }),
      },

      env: {
        // Bound by Worker name, which cf/config cannot type; src/index.ts types the stub.
        LIBRARY: bindings.durableObject({ worker: d.name, exportName: "Library" }),

        // Account layer (users, libraries, tokens, sessions); migrations in ./migrations.
        DB: bindings.d1(d.d1),

        // Attachment blobs (blobs/<sha256>), exports and restore records.
        BLOBS: bindings.r2({ name: d.r2 }),

        // OAuth clients and grants for MCP apps (Cloudflare's OAuth provider library).
        OAUTH_KV: bindings.kv({ id: d.kv }),

        // Nightly exports (exports/<library id>/<date>/) older than this are deleted; the newest stays.
        EXPORT_RETENTION_DAYS: bindings.text("30"),

        // Storage per library, SQLite plus attachments (v2 spec: Limits).
        LIBRARY_STORAGE_MB: bindings.text("100"),

        // Per-minute limits (v2 spec: Limits): writes per account, requests per token or app. The
        // per-account numbers in limits.ts match; overrides above them need a separate limiter.
        WRITE_LIMITER: bindings.rateLimit({ namespace: "1001", simple: { limit: 60, period: 60 } }),
        REQUEST_LIMITER: bindings.rateLimit({
          namespace: "1002",
          simple: { limit: 600, period: 60 },
        }),

        // Metering: one data point per request, write and email (v2 spec: Metering).
        USAGE: bindings.analyticsEngineDataset({ name: "okf_usage" }),

        // The daily digest goes to OPERATOR_EMAIL, a secret (typed in src/env.d.ts); unset sends none.
        MAIL_FROM: bindings.text(d.mailFrom),
        ...(d.mailFrom
          ? { EMAIL: bindings.sendEmail({ allowedSenderAddresses: [d.mailFrom] }) }
          : {}),

        // Secrets, set per deployment (spec: Deployment): ACCESS_TEAM_DOMAIN and ACCESS_AUD, from the
        // Cloudflare Access application that covers /app/*. Typed in src/env.d.ts. For local dev,
        // copy .dev.vars.sample to .dev.vars.
      },
    },
  };
});
