import { createApp } from "./app";
import { d1Authenticate } from "./auth";
import { makeClient, r2BlobStore } from "./client";

export { Library } from "./library";

let authenticate: ReturnType<typeof d1Authenticate> | undefined;

const app = createApp((env) => {
  authenticate ??= d1Authenticate(env.DB);
  return {
    authenticate,
    blobs: r2BlobStore(env.BLOBS),
    library: (token) => {
      const stub = env.LIBRARY.get(env.LIBRARY.idFromName(token.library.do_id));
      return makeClient((method, args) => stub.call(method, args));
    },
  };
});

export default app satisfies ExportedHandler<Env>;
