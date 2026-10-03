import { d1Accounts } from "./accounts";
import type { Deps } from "./app";
import { d1Authenticate } from "./auth";
import { makeClient, r2BlobStore } from "./client";
import type { Library } from "./library";
import { DEFAULT_STORAGE_MB } from "./limits";
import { exportsPrefix, listExports } from "./maintain";
import { listRestores, RESTORE_ID, restoresPrefix } from "./recovery";
import { d1Sessions } from "./session";
import type { Mailer } from "./signin";
import { d1Orphans, digestText, sweep } from "./sweep";
import { createWorker } from "./worker";

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
 * set in cloudflare.config.ts (mailFrom); without it there is no mailer.
 */
type MailBinding = {
  send(m: { from: string; to: string; subject: string; text: string }): Promise<unknown>;
};

function mailerFor(env: Env): Mailer | null {
  const binding = (env as unknown as { EMAIL?: MailBinding }).EMAIL;
  const from = env.MAIL_FROM;
  if (!binding || !from) return null;
  return {
    async send(m) {
      await binding.send({ from, ...m });
    },
  };
}

const storageLimitBytes = (env: Env) =>
  (Number(env.LIBRARY_STORAGE_MB) || DEFAULT_STORAGE_MB) * 1048576;

let authenticate: ReturnType<typeof d1Authenticate> | undefined;

const depsFor = (env: Env): Deps => {
  authenticate ??= d1Authenticate(env.DB);
  const client = (doId: string) => {
    const stub = libraryStub(env, doId);
    return makeClient((method, args) => stub.call(method, args));
  };
  return {
    authenticate,
    accounts: d1Accounts(env.DB),
    sessions: d1Sessions(env.DB),
    mailer: mailerFor(env),
    async rateLimit(kind, key) {
      const limiter = kind === "write" ? env.WRITE_LIMITER : env.REQUEST_LIMITER;
      return (await limiter.limit({ key })).success;
    },
    meter(e) {
      try {
        env.USAGE.writeDataPoint({
          blobs: [e.kind, e.account, e.library ?? ""],
          doubles: [1, e.bytes ?? 0],
          indexes: [e.account.slice(0, 96)],
        });
      } catch {}
    },
    blobs: r2BlobStore(env.BLOBS),
    maintain: (doId) => libraryStub(env, doId).maintain(),
    async destroyLibrary(doId) {
      // destroy() ends by restarting the object, which fails the call by design.
      await libraryStub(env, doId)
        .destroy()
        .catch(() => {});
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
        const outcome = await stub.prepareRestore(t, actor);
        if (outcome.ok) {
          // abort() fails the call by design; the next request starts the restored library.
          await stub.restart().catch(() => {});
        }
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
    library: (token) => client(token.library.do_id),
    // Checked against D1 first, so a forged download URL cannot create Durable Objects.
    libraryByDoId: async (doId) => {
      const row = await env.DB.prepare("SELECT 1 AS ok FROM libraries WHERE do_id = ?")
        .bind(doId)
        .first();
      return row ? client(doId) : null;
    },
  };
};

const worker = createWorker(depsFor);

export default {
  fetch: worker.fetch,

  /** The daily blob sweep and operator digest (v2 spec: A3); cron in cloudflare.config.ts. */
  async scheduled(_controller, env) {
    const result = await sweep({
      libraries: async () =>
        (
          await env.DB.prepare(
            "SELECT l.do_id AS id, COALESCE(u.handle, '?') || '/' || l.slug AS path FROM libraries l LEFT JOIN users u ON u.id = l.owner",
          ).all<{ id: string; path: string }>()
        ).results,
      inventory: (id) => libraryStub(env, id).inventory(),
      bucket: {
        list: (o) => env.BLOBS.list(o),
        delete: (keys) => env.BLOBS.delete(keys),
      },
      orphans: d1Orphans(env.DB),
      storageLimitBytes: storageLimitBytes(env),
      now: new Date(),
    });
    console.log(JSON.stringify({ sweep: result }));
    const mailer = mailerFor(env);
    if (result.attention.length && env.OPERATOR_EMAIL && mailer) {
      await mailer.send({
        to: env.OPERATOR_EMAIL,
        subject: `OKF digest: ${result.attention.length} to look at`,
        text: digestText(result),
      });
    }
  },
} satisfies ExportedHandler<Env>;
