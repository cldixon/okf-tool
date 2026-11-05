import { WorkerEntrypoint } from "cloudflare:workers";
import type { AccountFeeds } from "./account-feeds";
import { d1Accounts } from "./accounts";
import type { Deps } from "./app";
import { d1Authenticate } from "./auth";
import { AuthCache, invalidatingAccounts } from "./authcache";
import { d1BlobRefs } from "./blobrefs";
import { makeClient, r2BlobStore, recordingBlobStore } from "./client";
import { agentSpendThisMonth } from "./costs";
import { routedDb, withD1Session } from "./d1session";
import { type Caller, callerOf, FEED_SOCKETS_PER_ACCOUNT } from "./feed";
import { deleteVariants, imagesService, r2VariantCache } from "./images";
import type { SiteService } from "./legal";
import { type Library, refuseFeed } from "./library";
import { healthDigest } from "./library-health";
import { d1SentLog, handleMailMessage, type MailJob, type Outbox, queueOutbox } from "./mail-queue";
import { bindingMailer, type MailBinding } from "./mail-template";
import { exportsPrefix, listExports } from "./maintain";
import type { AgentJob, ManagedDeps } from "./managed/agent";
import { d1AgentBudget } from "./managed/budget";
import { anthropicModel, handleAgentMessage } from "./managed/consumer";
import { fakeModel } from "./managed/fake";
import type { ModelClient } from "./managed/turn";
import { d1Notifications } from "./notify";
import { devMailer, flushMail } from "./notify-mail";
import { operatorOps } from "./operator";
import { counterName, Quota, quotaBackend, quotaGuarded } from "./quota";
import { listRestores, RESTORE_ID, restoresPrefix } from "./recovery";
import { type RenderService, servicePoster, serviceRenderer } from "./render";
import { d1Sessions } from "./session";
import type { Mailer } from "./signin";
import {
  digestText,
  handleSweepMessage,
  isSweepMessage,
  pruneAccounts,
  type SweepMessage,
  type SweepQueue,
  sweep,
} from "./sweep";
import { rpcLine } from "./timing";
import { usagePoint } from "./usage";
import { createWorker } from "./worker";

export { AccountFeeds } from "./account-feeds";
export { Library } from "./library";

/**
 * A library's Durable Object by name. cloudflare.config.ts binds LIBRARY by Worker name, which
 * cf/config cannot type, so the stub's RPC methods are typed here.
 */
function libraryStub(env: Env, name: string): DurableObjectStub<Library> {
  const ns = env.LIBRARY as DurableObjectNamespace<Library>;
  return ns.get(ns.idFromName(name));
}

/**
 * Cloudflare Email Service (v2 spec: A3). The EMAIL binding exists only once a sending domain is
 * set in cloudflare.config.ts (mailFrom); without it there is no mailer. From "Tempra"
 * (TEMPRA-287, `bindingMailer`).
 */
function mailerFor(env: Env): Mailer | null {
  const binding = (env as unknown as { EMAIL?: MailBinding }).EMAIL;
  const from = env.MAIL_FROM;
  if (!binding || !from) return null;
  return bindingMailer(binding, from);
}

/**
 * Mail nobody waits on goes through MAIL_QUEUE (TEMPRA-89, mail-queue.ts): wherever mail can be
 * sent, and in local dev, where the consumer keeps it in the dev outbox.
 */
function mailOutbox(env: Env): Outbox | null {
  if (env.DEV_SIGNIN !== "1" && !mailerFor(env)) return null;
  const q = env.MAIL_QUEUE as Queue<MailJob>;
  return queueOutbox(async (job) => {
    await q.send(job);
  });
}

/** What the MAIL_QUEUE consumer sends through: the binding, or the dev outbox locally. */
const mailSender = (env: Env): Mailer | null =>
  env.DEV_SIGNIN === "1" ? devMailer : mailerFor(env);

/** The blob sweep's Queue (TEMPRA-81). */
function sweepQueue(env: Env): SweepQueue {
  const q = env.SWEEP_QUEUE as Queue<SweepMessage>;
  return {
    send: async (m) => {
      await q.send(m);
    },
    sendBatch: async (ms) => {
      if (ms.length) await q.sendBatch(ms.map((body) => ({ body })));
    },
  };
}

/** The managed agent's Queue and its "replying" presence (TEMPRA-222). */
function managedDeps(env: Env): ManagedDeps {
  const q = env.AGENT_QUEUE as Queue<AgentJob>;
  return {
    enqueue: async (job) => {
      await q.send(job);
    },
    announce: async (doId, message) => {
      await libraryStub(env, doId).announce(message);
    },
  };
}

/**
 * The model the agent runs on: Claude with the deployment's key, a scripted stand-in in local dev
 * when `.dev.vars` asks for one (never where DEV_SIGNIN is off), else none.
 */
function agentModel(env: Env): ModelClient | null {
  if (env.AGENT_MODEL === "fake" && env.DEV_SIGNIN === "1") return fakeModel();
  return env.ANTHROPIC_API_KEY ? anthropicModel(env.ANTHROPIC_API_KEY) : null;
}

/**
 * What authorization read from D1 in this isolate, up to 30 s old (authcache.ts, TEMPRA-84):
 * tokens, sessions and app connections, dropped by the changes this isolate makes.
 */
const authCache = new AuthCache();
let authenticate: ReturnType<typeof d1Authenticate> | undefined;
/** The monthly quotas' tally (TEMPRA-232): one per isolate, so it outlives a request. */
let quota: Quota | undefined;

const depsFor = (env: Env): Deps => {
  // Each query in the request's D1 session (TEMPRA-85, d1session.ts), the binding outside one.
  const db = routedDb(env.DB);
  authenticate ??= d1Authenticate(db, Date.now, authCache.ms, authCache.tokens);
  quota ??= new Quota(
    quotaBackend(
      db,
      // The account's AccountFeeds object by user id, apart from its feed leases (by handle).
      (userId) => {
        const ns = env.ACCOUNT_FEEDS as DurableObjectNamespace<AccountFeeds>;
        return ns.get(ns.idFromName(counterName(userId)));
      },
      mailOutbox(env),
      d1Notifications(db),
    ),
    { origin: env.APP_ORIGIN },
  );
  // `caller` is the agent behind the calls, for presence on the feed (TEMPRA-219); null for a
  // person, and for the Worker's own calls (downloads, maintenance).
  const client = (doId: string, caller: Caller | null = null) => {
    const stub = libraryStub(env, doId);
    return makeClient(async (method, args, who) => {
      // A slow round trip is logged beside the object's own line (TEMPRA-190, timing.ts).
      const t = Date.now();
      const result = await (who ? stub.call(method, args, who) : stub.call(method, args));
      const line = rpcLine(method, doId, Date.now() - t);
      if (line) console.log(line);
      return result;
    }, caller);
  };
  const meter: Deps["meter"] = (e) => {
    try {
      env.USAGE.writeDataPoint(usagePoint(e));
    } catch {}
  };
  return {
    authenticate,
    accounts: invalidatingAccounts(d1Accounts(db), authCache),
    sessions: d1Sessions(db, Date.now, authCache),
    authCache,
    mailer: mailerFor(env),
    outbox: mailOutbox(env),
    notifications: d1Notifications(db),
    managed: managedDeps(env),
    async rateLimit(kind, key) {
      const limiter =
        // Renders share WRITE_LIMITER's 60 a minute under their own `render:` keys (TEMPRA-166).
        kind === "write" || kind === "render"
          ? env.WRITE_LIMITER
          : kind === "session"
            ? env.SESSION_LIMITER
            : env.REQUEST_LIMITER;
      return (await limiter.limit({ key })).success;
    },
    meter,
    // Not bound in local dev (cloudflare.config.ts): every render answers "render unavailable".
    site: (env as unknown as { SITE?: SiteService }).SITE ?? null,
    renderDiagram: serviceRenderer((env as unknown as { RENDER?: RenderService }).RENDER, meter),
    posterFrame: servicePoster((env as unknown as { RENDER?: RenderService }).RENDER, meter),
    // Each blob put is recorded in D1 first, so the sweep never lists the bucket (TEMPRA-81).
    blobs: recordingBlobStore(r2BlobStore(env.BLOBS), d1BlobRefs(db)),
    // Scaled copies under variants/ in the same bucket (TEMPRA-153); reads only, so no recording.
    images: imagesService({
      blobs: r2BlobStore(env.BLOBS),
      transformer: env.IMAGES ?? null,
      cache: r2VariantCache(env.BLOBS),
    }),
    maintain: (doId) => libraryStub(env, doId).maintain(),
    async destroyLibrary(doId) {
      // destroy() ends by restarting the object, which fails the call by design.
      await libraryStub(env, doId)
        .destroy()
        .catch(() => {});
      // Its references go; blobs it was the last to reference start their 31 days (TEMPRA-91).
      await d1BlobRefs(db).forget(doId, new Date());
      for (const prefix of [exportsPrefix(doId), restoresPrefix(doId)]) {
        let cursor: string | undefined;
        do {
          const page = await env.BLOBS.list({ prefix, cursor });
          if (page.objects.length) await env.BLOBS.delete(page.objects.map((o) => o.key));
          cursor = page.truncated ? page.cursor : undefined;
        } while (cursor);
      }
    },
    health: async () => {
      const check = async (fn: () => Promise<unknown>) => {
        try {
          await fn();
          return "ok";
        } catch (e) {
          return e instanceof Error ? e.message : String(e);
        }
      };
      const [d1, r2, durableObjects] = await Promise.all([
        check(() => env.DB.prepare("SELECT 1").first()),
        check(() => env.BLOBS.list({ limit: 1 })),
        check(async () => {
          const r = await libraryStub(env, "_healthz").ping();
          if (r !== "ok") throw new Error("unexpected reply");
        }),
      ]);
      return { d1, r2, durable_objects: durableObjects };
    },
    recovery: {
      async restore(doId, target, actor) {
        const stub = libraryStub(env, doId);
        let t: Parameters<typeof stub.prepareRestore>[0];
        if ("undo" in target) {
          const obj = RESTORE_ID.test(target.undo)
            ? await env.BLOBS.get(`${restoresPrefix(doId)}${target.undo}.json`)
            : null;
          if (!obj)
            return { ok: false, status: 404, code: "not_found", message: "No such restore." };
          t = { undo: await obj.json() };
        } else {
          t = { to: target.to };
        }
        // A restore can drop references (TEMPRA-91): deletion is held from before it is armed
        // until a recount after the restart, carrying this token, has replaced the library's rows.
        const token = crypto.randomUUID();
        await d1BlobRefs(db).pend(doId, token);
        const outcome = await stub.prepareRestore(t, actor);
        if (outcome.ok) {
          // abort() fails the call by design; the next request starts the restored library.
          await stub.restart().catch(() => {});
        }
        // Sent either way (a refused restore changed nothing; the recount says so). If it is
        // lost, the daily cron sends it again for the pending library.
        await sweepQueue(env)
          .send({ kind: "recount", library: doId, token })
          .catch((e) =>
            console.error(JSON.stringify({ recount_not_sent: doId, error: String(e) })),
          );
        return outcome;
      },
      list: (doId) =>
        listRestores(env.BLOBS, async (k) => (await env.BLOBS.get(k))?.text() ?? null, doId),
    },
    exports: {
      async list(libraryId) {
        const folders = (await listExports(env.BLOBS, libraryId)).reverse();
        return Promise.all(
          folders.map(async (folder) => {
            const m = await env.BLOBS.get(`${folder}manifest.json`);
            return { folder, manifest: m ? ((await m.json()) as Record<string, unknown>) : null };
          }),
        );
      },
      async get(key) {
        if (!key.startsWith("exports/")) return null;
        const obj = await env.BLOBS.get(key);
        return obj ? { body: obj.body, size: obj.size } : null;
      },
    },
    quota,
    // Every surface's writes pass the monthly quotas first (TEMPRA-232); reads go straight on.
    library: (token, surface) =>
      quotaGuarded(quota, token, client(token.library.do_id, callerOf(token, surface))),
    feed: async (doId, request, { prefix, account }) => {
      // A place under the account's cap first (feed-leases.ts), then the library's own cap.
      const lease = crypto.randomUUID();
      const ns = env.ACCOUNT_FEEDS as DurableObjectNamespace<AccountFeeds>;
      const counter = ns.get(ns.idFromName(account));
      if (!(await counter.acquire({ id: lease, doId }, FEED_SOCKETS_PER_ACCOUNT))) {
        return refuseFeed("This account has too many live connections; polling instead.");
      }
      const url = new URL("https://library/feed");
      if (prefix) url.searchParams.set("prefix", prefix);
      url.searchParams.set("lease", lease);
      // Whose lease it is, so the library releases it when the socket closes.
      url.searchParams.set("account", account);
      return libraryStub(env, doId).fetch(new Request(url, request));
    },
    // Checked against D1 first, so a forged download URL cannot create Durable Objects.
    libraryByDoId: async (doId) => {
      const row = await db
        .prepare("SELECT 1 AS ok FROM libraries WHERE do_id = ?")
        .bind(doId)
        .first();
      return row ? client(doId) : null;
    },
  };
};

const worker = createWorker(depsFor);

/**
 * The operator's portal's way in (TEMPRA-278, operator.ts): RPC over the admin Worker's OPERATOR
 * service binding, with no route. Cloudflare Access signed the operator in before the admin Worker
 * calls; each method checks the email it passes is OPERATOR_EMAIL again, and refuses otherwise.
 */
export class Operator extends WorkerEntrypoint<Env> {
  private ops(operator: string) {
    const env = this.env;
    const expected = env.OPERATOR_EMAIL?.trim().toLowerCase();
    if (!expected || operator.trim().toLowerCase() !== expected) {
      throw new Error("Not the operator.");
    }
    const d = depsFor(env);
    return operatorOps(d, env.APP_ORIGIN);
  }
  people(operator: string) {
    return this.ops(operator).people();
  }
  invite(operator: string, email: string) {
    return this.ops(operator).invite(email);
  }
  decide(operator: string, email: string, decision: "invited" | "dismissed") {
    if (decision !== "invited" && decision !== "dismissed") throw new Error("Approve or dismiss.");
    return this.ops(operator).decide(email, decision);
  }
  activity(operator: string) {
    return this.ops(operator).activity();
  }
}

/** The 5-minute cron that sends batched notification mail; any other is the daily one. */
const NOTIFY_CRON = "*/5 * * * *";

export default {
  /** Each request in one D1 session, its bookmark carried to the browser (TEMPRA-85). */
  fetch: (request, env, ctx) =>
    withD1Session(env.DB, request, async () => worker.fetch(request, env, ctx)),

  /**
   * The crons in cloudflare.config.ts: every 5 minutes the batched notification mail (TEMPRA-74);
   * daily the blob sweep and the operator digest (v2 spec: A3). People's digests went with
   * TEMPRA-189.
   */
  async scheduled(controller, env) {
    // Queued on MAIL_QUEUE (TEMPRA-89); local dev's consumer keeps it in the dev outbox.
    const outbox = mailOutbox(env);
    const mail = {
      accounts: d1Accounts(env.DB),
      notifications: d1Notifications(env.DB),
      outbox,
      origin: env.APP_ORIGIN,
      now: new Date(),
    };
    if (controller.cron === NOTIFY_CRON) {
      const sent = await flushMail(mail);
      if (sent.mails || sent.skipped) console.log(JSON.stringify({ notify_mail: sent }));
      return;
    }
    const result = await sweep({
      refs: d1BlobRefs(env.DB),
      queue: sweepQueue(env),
      // A blob's scaled copies (images.ts) go with it.
      bucket: {
        delete: async (keys) => {
          await env.BLOBS.delete(keys);
          await deleteVariants(env.BLOBS, keys);
        },
      },
      // Each library's own health row (TEMPRA-92): the digest wakes no library.
      health: (now) => healthDigest(env.DB, now),
      prune: () => pruneAccounts(env.DB, new Date()),
      now: new Date(),
    });
    // @tempra's spend this month (TEMPRA-233); a failed read only leaves the line out.
    try {
      result.agentSpend = await agentSpendThisMonth(env.DB, new Date());
    } catch (e) {
      console.error(JSON.stringify({ agent_spend: String(e) }));
    }
    // The waitlist (v2 spec: Accounts and sign-in): the digest counts who waits, past the notice cap.
    const waiting = (await d1Accounts(env.DB).waitlist()).length;
    if (waiting) result.attention.push(`${waiting} waiting on the waitlist: /waitlist`);
    // Notification mail that failed yesterday (bounces, as far as sending tells us).
    const yesterday = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
    const failed = await mail.notifications.failures(yesterday);
    if (failed)
      result.attention.push(`${failed} mails failed to send on ${yesterday}, after their retries`);
    console.log(JSON.stringify({ sweep: result }));
    if (result.attention.length && env.OPERATOR_EMAIL && outbox) {
      await outbox.send({
        key: `digest:${new Date().toISOString().slice(0, 10)}`,
        kind: "operator",
        to: env.OPERATOR_EMAIL,
        subject: `Tempra digest: ${result.attention.length} to look at`,
        text: digestText(result),
      });
    }
  },

  /**
   * Three queues, told apart by name: outgoing mail (TEMPRA-89), the managed agent's turns
   * (TEMPRA-222), and the blob sweep's
   * fan-out (TEMPRA-81): dispatch pages, library recounts, the one-time bucket listing and the
   * drift scan, each message on its own, retried on failure.
   */
  async queue(batch, env, ctx) {
    if (batch.queue.startsWith("tempra-mail")) {
      // One mail after another, so a batch paces itself; a failure backs off on its own.
      const d = {
        mailer: mailSender(env),
        sent: d1SentLog(env.DB),
        recordFailure: (day: string) => d1Notifications(env.DB).recordFailure(day),
        meter: (e: { kind: "email"; account: string }) => {
          try {
            env.USAGE.writeDataPoint(usagePoint(e));
          } catch {}
        },
        now: () => new Date(),
      };
      for (const msg of batch.messages) {
        const out = await handleMailMessage(d, msg.body, msg.attempts);
        if ("retry" in out) msg.retry({ delaySeconds: out.retry });
        else msg.ack();
      }
      return;
    }
    if (batch.queue.startsWith("tempra-agent")) {
      const d = depsFor(env);
      const turn = {
        ...d,
        model: agentModel(env),
        budget: d1AgentBudget(env.DB),
        origin: env.APP_ORIGIN,
        waitUntil: (p: Promise<unknown>) => ctx.waitUntil(p),
      };
      for (const msg of batch.messages) {
        const next = await handleAgentMessage(turn, msg.body, msg.attempts);
        if (next === "retry") msg.retry();
        else msg.ack();
      }
      return;
    }
    const deps = {
      refs: d1BlobRefs(env.DB),
      queue: sweepQueue(env),
      libraryHashes: (library: string) => libraryStub(env, library).blobRefs(),
      bucket: {
        list: (o: { prefix: string; cursor?: string; limit: number }) => env.BLOBS.list(o),
      },
      now: () => new Date(),
    };
    for (const msg of batch.messages) {
      if (!isSweepMessage(msg.body)) {
        console.error(JSON.stringify({ sweep_message_unknown: msg.body }));
        msg.ack();
        continue;
      }
      try {
        const outcome = await handleSweepMessage(msg.body, deps);
        // A recount that adds or removes rows outside a backfill is drift (TEMPRA-91).
        if (outcome.kind !== "dispatch") console.log(JSON.stringify({ sweep: outcome }));
        msg.ack();
      } catch (e) {
        console.error(JSON.stringify({ sweep_message: msg.body, error: String(e) }));
        msg.retry();
      }
    }
  },
} satisfies ExportedHandler<Env, SweepMessage | AgentJob | MailJob>;
