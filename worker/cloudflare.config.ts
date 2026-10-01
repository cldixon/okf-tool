import { bindings, defineConfig, exports } from "cf/config";

/**
 * The Worker and its bindings, for the `cf` CLI (`cf dev`, `cf build`, `cf deploy`, `cf workers
 * types`). Scripts import this file too (scripts/cf.ts), so keep it free of Worker code imports.
 */
export default defineConfig({
  worker: {
    name: "okf-service",
    entrypoint: "src/index.ts",
    compatibilityDate: "2026-09-01",
    // global_fetch_strictly_public: outbound fetch cannot reach private addresses; required for
    // OAuth Client ID Metadata Documents (the Worker fetches a URL an MCP client names).
    compatibilityFlags: ["nodejs_compat", "global_fetch_strictly_public"],
    observability: { enabled: true },

    // One SQLite-backed Durable Object per library (spec: Backend architecture). Declared as an
    // export; this replaces Wrangler's `migrations` history (its v1 created the same class).
    exports: {
      Library: exports.durableObject({ storage: "sqlite" }),
    },

    env: {
      // Bound by Worker name, which cf/config cannot type; src/index.ts types the stub.
      LIBRARY: bindings.durableObject({ worker: "okf-service", exportName: "Library" }),

      // Account layer (users, libraries, tokens); migrations in ./migrations.
      DB: bindings.d1({ name: "okf-accounts", id: "c36c4e44-2d34-4053-9fee-3ac7f1ad6c0c" }),

      // Attachment blobs (blobs/<sha256>), exports and restore records.
      BLOBS: bindings.r2({ name: "okf-blobs" }),

      // OAuth clients and grants for MCP apps (Cloudflare's OAuth provider library).
      OAUTH_KV: bindings.kv({ id: "0b8fe9060b9645749d11d6083793295a" }),

      // Nightly exports (exports/<library id>/<date>/) older than this are deleted; the newest stays.
      EXPORT_RETENTION_DAYS: bindings.text("30"),

      // Secrets, set per deployment (spec: Deployment): ACCESS_TEAM_DOMAIN and ACCESS_AUD, from the
      // Cloudflare Access application that covers /app/*. Typed in src/env.d.ts. For local dev,
      // copy .dev.vars.sample to .dev.vars.
    },
  },
});
