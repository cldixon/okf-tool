import { d1Accounts } from "./accounts";
import { d1Authenticate } from "./auth";
import { makeClient, r2BlobStore } from "./client";
import { listExports } from "./maintain";
import { createWorker } from "./worker";

export { Library } from "./library";

let authenticate: ReturnType<typeof d1Authenticate> | undefined;

export default createWorker((env) => {
  authenticate ??= d1Authenticate(env.DB);
  const client = (doId: string) => {
    const stub = env.LIBRARY.get(env.LIBRARY.idFromName(doId));
    return makeClient((method, args) => stub.call(method, args));
  };
  return {
    authenticate,
    accounts: d1Accounts(env.DB),
    blobs: r2BlobStore(env.BLOBS),
    maintain: (doId) => env.LIBRARY.get(env.LIBRARY.idFromName(doId)).maintain(),
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
          const r = await env.LIBRARY.get(env.LIBRARY.idFromName("_healthz")).ping();
          if (r !== "ok") throw new Error("unexpected reply");
        }),
      ]);
      return { d1, r2, durable_objects: durableObjects };
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
