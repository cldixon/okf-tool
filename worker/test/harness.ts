/** The real app in process: a bun:sqlite store behind the same callStore the DO uses. */
import { createApp, type Deps } from "../src/app";
import type { TokenInfo } from "../src/auth";
import { type BlobStore, callStore, makeClient } from "../src/client";
import { OkfError } from "../src/store/errors";
import { LibraryStore } from "../src/store/store";
import { bunSqlHandle } from "./sqlite";

export function memoryBlobs(): BlobStore & { map: Map<string, Uint8Array> } {
  const map = new Map<string, Uint8Array>();
  return {
    map,
    async put(hash, bytes) {
      map.set(hash, bytes);
    },
    async get(hash) {
      const b = map.get(hash);
      return b ? { body: b, size: b.length } : null;
    },
    async head(hash) {
      const b = map.get(hash);
      return b ? { size: b.length } : null;
    },
  };
}

const LIB = { id: "lib-1", slug: "demo", do_id: "lib-1" };
export const TOKENS: Record<string, TokenInfo> = {
  writer: {
    id: "t1",
    actor: "claude-code/test",
    scope: "write",
    prefix: null,
    mcp_tiers: "all",
    library: LIB,
  },
  reader: {
    id: "t2",
    actor: "claude-code/reader",
    scope: "read",
    prefix: null,
    mcp_tiers: "all",
    library: LIB,
  },
  scoped: {
    id: "t3",
    actor: "process:scoped",
    scope: "write",
    prefix: "notes",
    mcp_tiers: "all",
    library: LIB,
  },
  process: {
    id: "t4",
    actor: "process:nightly-verify",
    scope: "write",
    prefix: null,
    mcp_tiers: "all",
    library: LIB,
  },
  files: {
    id: "t5",
    actor: "claude-code/files-only",
    scope: "write",
    prefix: null,
    mcp_tiers: "files",
    library: LIB,
  },
};

export function setup() {
  const store = new LibraryStore(bunSqlHandle());
  const blobs = memoryBlobs();
  const client = makeClient((method, args) => callStore(store, blobs, method, args));
  const deps: Deps = {
    authenticate: async (secret) => {
      const t = TOKENS[secret];
      if (!t) throw new OkfError(401, "bad_token", "Unknown bearer token.");
      return t;
    },
    blobs,
    library: () => client,
    libraryByDoId: async (doId) => (doId === LIB.do_id ? client : null),
  };
  const app = createApp(() => deps);
  const req = (path: string, init: RequestInit & { token?: string } = {}) => {
    const headers = new Headers(init.headers);
    if (init.token !== "") headers.set("Authorization", `Bearer ${init.token ?? "writer"}`);
    return app.request(`/api/v1/libraries/demo${path}`, { ...init, headers });
  };
  return { app, req, store, blobs };
}
