import { d1Accounts } from "./accounts";
import { d1Authenticate } from "./auth";
import { makeClient, r2BlobStore } from "./client";
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
