import { createApp } from "./app";
import { d1Authenticate } from "./auth";
import { makeClient, r2BlobStore } from "./client";

export { Library } from "./library";

let authenticate: ReturnType<typeof d1Authenticate> | undefined;

const app = createApp((env) => {
  authenticate ??= d1Authenticate(env.DB);
  const client = (doId: string) => {
    const stub = env.LIBRARY.get(env.LIBRARY.idFromName(doId));
    return makeClient((method, args) => stub.call(method, args));
  };
  return {
    authenticate,
    blobs: r2BlobStore(env.BLOBS),
    library: (token) => client(token.library.do_id),
    // Checked against D1 first, so a forged download URL cannot create Durable Objects.
    libraryByDoId: async (doId) => {
      const row = await env.DB.prepare("SELECT 1 AS ok FROM libraries WHERE do_id = ?")
        .bind(doId)
        .first();
      return row ? client(doId) : null;
    },
  };
});

export default app satisfies ExportedHandler<Env>;
