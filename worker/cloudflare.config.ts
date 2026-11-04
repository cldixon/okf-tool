import { bindings, defineConfig, exports, triggers } from "cf/config";

/**
 * The Worker and its bindings, for the `cf` CLI (`cf dev`, `cf build`, `cf deploy`, `cf workers
 * types`). Scripts import this file too (scripts/cf.ts), so keep it free of Worker code imports.
 *
 * `--mode staging` gives a separate Worker with its own D1, R2 and KV (v2 spec: Operations);
 * `--mode production` is production; `--mode preview` is one pull request's Worker, named by
 * TEMPRA_PR with its resource ids in TEMPRA_PREVIEW_D1_ID and TEMPRA_PREVIEW_KV_ID (scripts/preview.ts
 * sets them); no mode is local dev (`cf dev`), type generation and dry runs.
 */

export interface Deployment {
  name: string;
  /**
   * The diagram render Worker this deployment binds to as RENDER (TEMPRA-165, render/): its own
   * per deployment, deployed before this one by scripts/deploy.ts.
   */
  render: string;
  /** The custom domain that serves everything: the app, /api, /mcp and OAuth. */
  host: string;
  /**
   * Former hosts kept attached (TEMPRA-276, tempra-dev `decisions/the-app-at-tempra-dev.md`): a
   * browser's page load there is sent to the same path on `host`; agents, OAuth and downloads are
   * served in place, since existing connections are bound to them (src/hosts.ts).
   */
  aliases?: string[];
  /** Hosts that only redirect to `host` with a 301 (www). */
  redirects?: string[];
  /**
   * The landing page's Worker (site/, `tempra-site`), bound as SITE: `/` for people signed out
   * and the site's own paths (src/site.ts). Unset: signed-out `/` goes to sign-in.
   */
  site?: string;
  d1: { name: string; id: string };
  /**
   * The account database's read replication (TEMPRA-85, tempra-dev `v2/read-replication.md`), a
   * setting on the database rather than a binding: `bun run deploy` applies it when it differs
   * (scripts/cf.ts `ensureReadReplication`). Unset leaves the database as it is (previews).
   */
  readReplication?: "auto" | "disabled";
  r2: string;
  kv: string;
  /** The blob sweep's Queue (TEMPRA-81): recounts, the bucket listing and the drift scan. */
  queue: string;
  /** The managed agent's Queue (TEMPRA-222): one message per turn of @tempra. */
  agentQueue: string;
  /**
   * Outgoing mail's Queue (TEMPRA-89): invitations, notification batches, quota notices, the
   * waitlist's and the operator's mail, sent by the consumer with retries. Sign-in links stay out.
   */
  mailQueue: string;
  /** The address sign-in links and the digest come from (Cloudflare Email Service). */
  mailFrom: string;
  /**
   * Incoming mail (Cloudflare Email Routing on the zone): each address forwarded to a mailbox.
   * `"operator"` is the operator's own address, read from OPERATOR_EMAIL when `bun run deploy`
   * runs (CI passes it from a secret), so no personal address is in the repository. Deploy
   * enables routing on the zone, registers the destination (Cloudflare mails it a verification
   * link, once) and creates or corrects each rule (scripts/cf.ts `ensureEmailRouting`). Unset: no
   * incoming mail is managed (staging and previews share the production zone's routing).
   */
  inboundMail?: { zone: string; routes: { address: string; to: "operator" }[] };
  /** Analytics Engine dataset for metering; tempra_usage unless set. */
  usage?: string;
  /**
   * Rate-limit namespace ids for WRITE_LIMITER, REQUEST_LIMITER and SESSION_LIMITER. Namespaces
   * are account-wide, so each deployment needs its own or its counters are shared with
   * production (TEMPRA-76). Production's (1001, 1002, 1003) unless set.
   */
  limiters?: { write: string; request: string; session: string };
  /** False: no daily sweep and digest. */
  cron?: false;
  /**
   * The operator's portal (TEMPRA-278, admin/): its Worker and host, behind Cloudflare Access. It
   * calls this Worker's `Operator` entrypoint; /waitlist sends the operator there. Unset: none.
   */
  admin?: { name: string; host: string };
}

const PRODUCTION: Deployment = {
  name: "tempra",
  render: "tempra-render",
  // The app at the apex, the landing page its signed-out home (TEMPRA-276).
  host: "tempra.dev",
  aliases: ["app.tempra.dev"],
  redirects: ["www.tempra.dev"],
  site: "tempra-site",
  d1: { name: "tempra-accounts", id: "60dcce9c-4a20-44db-8d49-1ee040225c4d" },
  readReplication: "auto",
  r2: "tempra-blobs",
  kv: "9e57232de5b940e4b2319f31da509f42",
  queue: "tempra-sweep",
  agentQueue: "tempra-agent",
  mailQueue: "tempra-mail",
  // mail.tempra.dev is onboarded for Cloudflare Email Sending.
  mailFrom: "noreply@mail.tempra.dev",
  // The contact address on the landing page's Terms and Privacy.
  inboundMail: { zone: "tempra.dev", routes: [{ address: "hello@tempra.dev", to: "operator" }] },
  admin: { name: "tempra-admin", host: "admin.tempra.dev" },
};

const STAGING: Deployment = {
  name: "tempra-staging",
  render: "tempra-render-staging",
  host: "staging.tempra.dev",
  // Production's landing page, so staging shows what tempra.dev will.
  site: "tempra-site",
  d1: { name: "tempra-accounts-staging", id: "d66e1ceb-591e-419d-ba51-9cc32b87f658" },
  readReplication: "auto",
  r2: "tempra-blobs-staging",
  kv: "b63bffc9b65743a99783013effb89324",
  queue: "tempra-sweep-staging",
  agentQueue: "tempra-agent-staging",
  mailQueue: "tempra-mail-staging",
  mailFrom: "noreply@mail.tempra.dev",
  // One level under the zone, so the zone's certificate covers it.
  admin: { name: "tempra-admin-staging", host: "admin-staging.tempra.dev" },
  // Staging's traffic and counters stay out of production's (TEMPRA-76). Datasets are created on
  // first write and namespaces are only ids, so neither needs a resource made.
  usage: "tempra_usage_staging",
  limiters: { write: "2001", request: "2002", session: "2003" },
};

/**
 * Pull request N's preview (tempra-dev library: delivery/preview-deployments): its own Worker and
 * resources on pr-N.tempra.dev, created and deleted by scripts/preview.ts. The ids are known only
 * once the resources exist, so they come from the environment.
 */
export function previewDeployment(pr: string, ids: { d1?: string; kv?: string } = {}): Deployment {
  if (!/^[1-9][0-9]*$/.test(pr)) throw new Error(`Not a pull request number: ${pr || "(unset)"}`);
  return {
    name: `tempra-pr-${pr}`,
    render: `tempra-render-pr-${pr}`,
    host: `pr-${pr}.tempra.dev`,
    site: "tempra-site",
    d1: { name: `tempra-accounts-pr-${pr}`, id: ids.d1 ?? "" },
    r2: `tempra-blobs-pr-${pr}`,
    kv: ids.kv ?? "",
    queue: `tempra-sweep-pr-${pr}`,
    agentQueue: `tempra-agent-pr-${pr}`,
    mailQueue: `tempra-mail-pr-${pr}`,
    mailFrom: "noreply@mail.tempra.dev",
    // Previews are short-lived; the daily sweep and digest run on staging and production only,
    // and their traffic stays out of the usage data.
    cron: false,
    usage: "tempra_usage_preview",
    // One pair for every preview: each has its own D1, so keys rarely meet, and never production's.
    limiters: { write: "3001", request: "3002", session: "3003" },
  };
}

/**
 * SESSION_LIMITER's limit; scripts/gate.ts measures the app against it. Kept here, not in Worker
 * code, because this file must not import the Worker.
 */
export const SESSION_REQUESTS_PER_MINUTE = 2400;

/** The CLI's environment; the Worker's tsconfig has no Node types, so it is reached by hand. */
const env: Record<string, string | undefined> =
  (globalThis as { process?: { env: Record<string, string | undefined> } }).process?.env ?? {};

const COMPATIBILITY = {
  compatibilityDate: "2026-09-01",
  // global_fetch_strictly_public: outbound fetch cannot reach private addresses; required for
  // OAuth Client ID Metadata Documents (the Worker fetches a URL an MCP client names).
  compatibilityFlags: ["nodejs_compat", "global_fetch_strictly_public"],
  observability: { enabled: true },
};

/**
 * The deployment a mode names: production for none (local dev, types, dry runs) and for
 * "production". render/cloudflare.config.ts reads it too, for its name and bucket.
 */
export function deploymentFor(mode: string | undefined): Deployment {
  return mode === "preview"
    ? previewDeployment(env.TEMPRA_PR ?? "", {
        d1: env.TEMPRA_PREVIEW_D1_ID,
        kv: env.TEMPRA_PREVIEW_KV_ID,
      })
    : mode === "staging"
      ? STAGING
      : PRODUCTION;
}

/** Compatibility settings both Workers share. */
export { COMPATIBILITY };

export default defineConfig(({ mode }) => {
  const d = deploymentFor(mode);
  // No mode: local dev, type generation and dry runs. `cf dev` would send local requests to the
  // custom domain, so the domain is attached only with an explicit --mode.
  const local = !mode;
  if (!d.d1.id || !d.kv) {
    throw new Error(
      `The ${d.name} deployment's D1 and KV ids are not set in cloudflare.config.ts.`,
    );
  }
  return {
    worker: {
      name: d.name,
      entrypoint: "src/index.ts",
      ...COMPATIBILITY,

      // The static files (TEMPRA-174): the app's bundle under /_app/, the design stylesheet and
      // fonts under /_design/, /favicon.svg, written by the app's build (app/build.ts) with a
      // `_headers` file; the directory is `assetsDirectory` in wrangler.config.ts. Cloudflare
      // serves a request that matches a file before the Worker runs, so they are neither in the
      // Worker's script nor counted or metered by it; anything else reaches the Worker.
      assets: { htmlHandling: "none", notFoundHandling: "none" },

      // The deployment's host, its aliases and its redirects (TEMPRA-276, src/hosts.ts); no
      // workers.dev, so no other origin. In CI, cf deploy takes over a domain another Worker
      // holds (the landing page held tempra.dev and www until TEMPRA-276).
      domains: local ? [] : [d.host, ...(d.aliases ?? []), ...(d.redirects ?? [])],
      workersDev: false,

      // The daily blob sweep, operator digest and people's digests (v2 spec: A3), after the
      // libraries' 03:00 exports; every 5 minutes, batched notification mail (TEMPRA-74). The
      // Worker tells them apart by schedule (src/index.ts).
      triggers: [
        ...(d.cron === false
          ? []
          : [
              triggers.scheduled({ schedule: "30 4 * * *" }),
              triggers.scheduled({ schedule: "*/5 * * * *" }),
            ]),
        // The blob sweep's fan-out (TEMPRA-81). No dead-letter queue: a message that runs out of
        // retries leaves its state in D1 (a library uncounted or pending, a listing or scan
        // cursor), and the next day's cron sends it again.
        triggers.queue({ name: d.queue, maxBatchSize: 10, maxRetries: 3, retryDelay: 60 }),
        // The managed agent's turns (TEMPRA-222), one at a time and at once: a person waits on
        // each. A failed turn is retried once, then says in its thread that it could not answer.
        // No dead-letter queue.
        triggers.queue({
          name: d.agentQueue,
          maxBatchSize: 1,
          maxBatchTimeout: 0,
          maxRetries: 1,
          retryDelay: 5,
        }),
        // Outgoing mail (TEMPRA-89): batches of up to 10 sent one after another, at most two
        // consumers at once, so a burst is paced under Email Service's rate limit. A transient
        // failure is retried with backoff (the consumer sets each delay: 30 s, 2, 8, 15 minutes);
        // the last failure is counted for the operator's digest. No dead-letter queue.
        triggers.queue({
          name: d.mailQueue,
          maxBatchSize: 10,
          maxBatchTimeout: 1,
          maxConcurrency: 2,
          maxRetries: 4,
          retryDelay: 30,
        }),
      ],

      // One SQLite-backed Durable Object per library (spec: Backend architecture). Declared as an
      // export; this replaces Wrangler's `migrations` history (its v1 created the same class).
      // One more per account (TEMPRA-80): leases on its open change-feed sockets, for the
      // per-account cap; it holds no sockets and sleeps between connects.
      exports: {
        Library: exports.durableObject({ storage: "sqlite" }),
        AccountFeeds: exports.durableObject({ storage: "sqlite" }),
        // The operator's portal's RPC entrypoint (TEMPRA-278), bound by admin/ as OPERATOR.
        Operator: exports.worker(),
      },

      env: {
        // Bound by Worker name, which cf/config cannot type; src/index.ts types the stub.
        LIBRARY: bindings.durableObject({ worker: d.name, exportName: "Library" }),
        ACCOUNT_FEEDS: bindings.durableObject({ worker: d.name, exportName: "AccountFeeds" }),

        // Account layer (users, libraries, tokens, sessions); migrations in ./migrations.
        DB: bindings.d1(d.d1),

        // Attachment blobs (blobs/<sha256>), exports and restore records.
        BLOBS: bindings.r2({ name: d.r2 }),

        // The blob sweep's Queue: this Worker sends and consumes (src/index.ts queue()).
        SWEEP_QUEUE: bindings.queue({ name: d.queue }),
        // The managed agent's Queue (TEMPRA-222): comments that ask @tempra send, the Worker
        // consumes (src/index.ts queue(), by the batch's queue name).
        AGENT_QUEUE: bindings.queue({ name: d.agentQueue }),
        // Outgoing mail (TEMPRA-89, src/mail-queue.ts): producers send, the Worker consumes.
        MAIL_QUEUE: bindings.queue({ name: d.mailQueue }),

        // Cloudflare Images (TEMPRA-153, images.ts): attachments scaled for models and readers,
        // cached in BLOBS under variants/. No resource to create; the account needs the Images
        // product enabled. Locally cf dev transforms with its own stand-in.
        IMAGES: bindings.images(),

        // OAuth clients and grants for MCP apps (Cloudflare's OAuth provider library).
        OAUTH_KV: bindings.kv({ id: d.kv }),

        // Nightly exports (exports/<library id>/<date>/) older than this are deleted; the newest stays.
        EXPORT_RETENTION_DAYS: bindings.text("30"),

        // Who may create an account (v2 spec: A4): open, invite or closed. Local dev and the gate
        // override it in .dev.vars.
        SIGNUP: bindings.text("invite"),

        // Storage per library, SQLite plus attachments (v2 spec: Limits).
        LIBRARY_STORAGE_MB: bindings.text("100"),

        // Per-minute limits (v2 spec: Limits): writes per account, requests per token or app. The
        // per-account numbers in limits.ts match; overrides above them need a separate limiter.
        WRITE_LIMITER: bindings.rateLimit({
          namespace: d.limiters?.write ?? "1001",
          simple: { limit: 60, period: 60 },
        }),
        REQUEST_LIMITER: bindings.rateLimit({
          namespace: d.limiters?.request ?? "1002",
          simple: { limit: 600, period: 60 },
        }),
        // Requests per browser session (TEMPRA-80): every page, API call and feed upgrade made
        // with the session cookie, set well above what the app does while someone reads fast
        // (the gate checks a busy browse stays under a quarter of it).
        SESSION_LIMITER: bindings.rateLimit({
          namespace: d.limiters?.session ?? "1003",
          simple: { limit: SESSION_REQUESTS_PER_MINUTE, period: 60 },
        }),

        // Metering: one data point per request, write and email (v2 spec: Metering).
        USAGE: bindings.analyticsEngineDataset({ name: d.usage ?? "tempra_usage" }),

        // The daily digest goes to OPERATOR_EMAIL, a secret (typed in src/env.d.ts); unset sends none.
        MAIL_FROM: bindings.text(d.mailFrom),
        // Links in mail sent from the crons, which have no request to take an origin from.
        APP_ORIGIN: bindings.text(local ? "http://localhost:8787" : `https://${d.host}`),
        // Hosts besides APP_ORIGIN's (TEMPRA-276, src/hosts.ts): aliases served for agents and
        // OAuth with browsers' page loads sent on, and hosts that only redirect.
        ALIAS_HOSTS: bindings.text(local ? "" : (d.aliases ?? []).join(",")),
        REDIRECT_HOSTS: bindings.text(local ? "" : (d.redirects ?? []).join(",")),
        // The landing page (site/), by service binding: signed-out `/` and the site's paths.
        // Not bound locally: cf dev runs this Worker alone.
        ...(local || !d.site ? {} : { SITE: bindings.worker({ worker: d.site }) }),
        // The operator's portal (TEMPRA-278), where /waitlist sends the operator; "" for none.
        ADMIN_ORIGIN: bindings.text(local || !d.admin ? "" : `https://${d.admin.host}`),
        ...(d.mailFrom
          ? { EMAIL: bindings.sendEmail({ allowedSenderAddresses: [d.mailFrom] }) }
          : {}),

        // The diagram render Worker (TEMPRA-165, render/), by service binding to its Renderer
        // entrypoint. Not bound locally: `cf dev` runs this Worker alone, and src/render.ts
        // answers "render unavailable" without it.
        ...(local ? {} : { RENDER: bindings.worker({ worker: d.render, exportName: "Renderer" }) }),

        // Secrets (typed in src/env.d.ts): OPERATOR_EMAIL, ANTHROPIC_API_KEY (the managed agent's
        // model, TEMPRA-222). For local dev, copy .dev.vars.sample to .dev.vars.
      },
    },
  };
});
