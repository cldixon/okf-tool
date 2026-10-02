import { d1Accounts } from "./accounts";
import { d1Authenticate } from "./auth";
import { makeClient, r2BlobStore } from "./client";
import type { Library } from "./library";
import { exportsPrefix, listExports } from "./maintain";
import { listRestores, RESTORE_ID, restoresPrefix } from "./recovery";
import { d1Sessions } from "./session";
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

let authenticate: ReturnType<typeof d1Authenticate> | undefined;

export default createWorker((env) => {
  authenticate ??= d1Authenticate(env.DB);
  const client = (doId: string) => {
    const stub = libraryStub(env, doId);
    return makeClient((method, args) => stub.call(method, args));
  };
  return {
    authenticate,
    accounts: d1Accounts(env.DB),
    sessions: d1Sessions(env.DB),
    // No mail provider until A3 (v2 spec: Open questions); local dev uses DEV_SIGNIN=1.
    mailer: null,
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
}) satisfies ExportedHandler<Env>;
