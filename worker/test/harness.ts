/**
 * The real Worker in process: Cloudflare's OAuth provider in front of the app, bun:sqlite stores
 * behind the same callStore the DO uses, and in-memory KV, blobs and accounts.
 */
import { mock } from "bun:test";

// `cloudflare:workers` only exists inside workerd; the OAuth library imports WorkerEntrypoint.
mock.module("cloudflare:workers", () => ({ DurableObject: class {}, WorkerEntrypoint: class {} }));
// As in cloudflare.config.ts: the OAuth library enables CIMD only under global_fetch_strictly_public.
Object.assign(globalThis, {
  Cloudflare: { compatibilityFlags: { global_fetch_strictly_public: true } },
});

import type { Accounts, LibraryRef, TokenRow, User } from "../src/accounts";
import { checkSlug, humanActor } from "../src/accounts";
import type { Deps } from "../src/app";
import type { TokenInfo } from "../src/auth";
import { type BlobStore, callStore, type LibraryClient, makeClient } from "../src/client";
import type { RestoreRecord } from "../src/recovery";
import { OkfError } from "../src/store/errors";
import { LibraryStore } from "../src/store/store";
import { bunSqlHandle } from "./sqlite";

const { createWorker } = await import("../src/worker");

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

/**
 * Durable Object point-in-time recovery stand-in: records what was armed. The rewind itself is
 * the platform's; local dev (cf dev) does not implement it either.
 */
export function fakeRecovery(opts: { unsupported?: boolean } = {}) {
  const armed: string[] = [];
  return {
    armed,
    async bookmarkForTime(t: Date) {
      if (opts.unsupported) {
        throw new Error(
          "This Durable Object's storage back-end does not implement point-in-time recovery.",
        );
      }
      return `bookmark@${t.toISOString()}`;
    },
    async currentBookmark() {
      return `undo@${new Date().toISOString()}`;
    },
    async restoreOnNextSession(bookmark: string) {
      armed.push(bookmark);
    },
  };
}

/** Enough of an R2 bucket for the export maintainer and the UI's export list. */
export function memoryBucket() {
  const objects = new Map<string, Uint8Array>();
  const enc = new TextEncoder();
  return {
    objects,
    async put(key: string, body: Uint8Array | string) {
      objects.set(key, typeof body === "string" ? enc.encode(body) : body);
    },
    async get(key: string) {
      const b = objects.get(key);
      return b ? { body: b, size: b.length } : null;
    },
    async list(opts: { prefix: string; delimiter?: string }) {
      const keys = [...objects.keys()].filter((k) => k.startsWith(opts.prefix)).sort();
      if (!opts.delimiter) {
        return { objects: keys.map((key) => ({ key })), delimitedPrefixes: [], truncated: false };
      }
      const prefixes = new Set<string>();
      const direct: { key: string }[] = [];
      for (const k of keys) {
        const rest = k.slice(opts.prefix.length);
        const i = rest.indexOf(opts.delimiter);
        if (i === -1) direct.push({ key: k });
        else prefixes.add(opts.prefix + rest.slice(0, i + 1));
      }
      return { objects: direct, delimitedPrefixes: [...prefixes], truncated: false };
    },
    async delete(keys: string | string[]) {
      for (const k of Array.isArray(keys) ? keys : [keys]) objects.delete(k);
    },
  };
}

/** Enough of Workers KV for the OAuth provider: get (text/json), put with TTL, delete, list. */
export function memoryKV() {
  const data = new Map<string, { value: string; expires: number | null; metadata: unknown }>();
  const live = (k: string) => {
    const e = data.get(k);
    if (e && e.expires !== null && e.expires <= Date.now()) {
      data.delete(k);
      return undefined;
    }
    return e;
  };
  const kv = {
    data,
    async get(key: string, opts?: string | { type?: string }) {
      const e = live(key);
      if (!e) return null;
      const type = typeof opts === "string" ? opts : opts?.type;
      return type === "json" ? JSON.parse(e.value) : e.value;
    },
    async getWithMetadata(key: string, opts?: string | { type?: string }) {
      const value = await kv.get(key, opts);
      return { value, metadata: live(key)?.metadata ?? null };
    },
    async put(
      key: string,
      value: string,
      opts: { expirationTtl?: number; expiration?: number; metadata?: unknown } = {},
    ) {
      const expires = opts.expirationTtl
        ? Date.now() + opts.expirationTtl * 1000
        : opts.expiration
          ? opts.expiration * 1000
          : null;
      data.set(key, { value: String(value), expires, metadata: opts.metadata ?? null });
    },
    async delete(key: string) {
      data.delete(key);
    },
    async list(opts: { prefix?: string; cursor?: string; limit?: number } = {}) {
      const names = [...data.keys()]
        .filter((k) => live(k) && k.startsWith(opts.prefix ?? ""))
        .sort();
      const start = opts.cursor ? Number(opts.cursor) : 0;
      const limit = opts.limit ?? 1000;
      const page = names.slice(start, start + limit);
      const done = start + limit >= names.length;
      return {
        keys: page.map((name) => ({ name, metadata: data.get(name)?.metadata ?? undefined })),
        list_complete: done,
        cursor: done ? undefined : String(start + limit),
      };
    },
  };
  return kv;
}

export const LIB: LibraryRef = { id: "lib-1", slug: "demo", do_id: "lib-1" };

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
  human: {
    id: "t6",
    actor: "human:owner",
    scope: "write",
    prefix: null,
    mcp_tiers: "all",
    library: LIB,
    created_by: "user_1",
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

export function memoryAccounts(): Accounts & {
  users: Map<string, User>;
  libs: LibraryRef[];
  minted: Map<string, TokenRow & { secret: string }>;
} {
  const users = new Map<string, User>();
  const libs: LibraryRef[] = [LIB];
  const minted = new Map<string, TokenRow & { secret: string }>();
  return {
    users,
    libs,
    minted,
    async tokens() {
      return [...minted.values()].reverse().map(({ secret: _, ...row }) => row);
    },
    async createToken(t) {
      const id = `tok_${minted.size + 1}`;
      const secret = `okf_test_${minted.size + 1}`;
      const lib = libs.find((l) => l.id === t.libraryId);
      const email = [...users.values()].find((u) => u.id === t.createdBy)?.email ?? null;
      minted.set(id, {
        id,
        secret,
        library: lib?.slug ?? "",
        actor: t.actor,
        scope: t.scope,
        prefix: t.prefix,
        expires: t.expires,
        mcp_tiers: t.mcpTiers,
        created_by: email,
        revoked: null,
      });
      return { id, secret };
    },
    async revokeToken(id) {
      const t = minted.get(id);
      if (!t || t.revoked) throw new OkfError(404, "not_found", "No such active token.");
      t.revoked = new Date().toISOString();
    },
    async user(email) {
      let u = users.get(email);
      if (!u) {
        u = { id: `user_${users.size + 1}`, email, actor: humanActor(email) };
        users.set(email, u);
      }
      return u;
    },
    async libraries() {
      return [...libs].sort((a, b) => (a.slug < b.slug ? -1 : 1));
    },
    async createLibrary(slugInput) {
      const slug = checkSlug(slugInput);
      if (libs.some((l) => l.slug === slug)) {
        throw new OkfError(409, "library_exists", `A library named ${slug} already exists.`);
      }
      const lib = { id: `lib-${libs.length + 1}`, slug, do_id: `lib-${libs.length + 1}` };
      libs.push(lib);
      return lib;
    },
  };
}

export const ORIGIN = "http://localhost";

export function setup() {
  const blobs = memoryBlobs();
  const stores = new Map<string, LibraryStore>();
  const clients = new Map<string, LibraryClient>();
  const clientFor = (doId: string) => {
    let c = clients.get(doId);
    if (!c) {
      const store = new LibraryStore(bunSqlHandle());
      stores.set(doId, store);
      c = makeClient((method, args) => callStore(store, blobs, method, args));
      clients.set(doId, c);
    }
    return c;
  };
  clientFor(LIB.do_id);
  const accounts = memoryAccounts();
  const bucket = memoryBucket();
  const pitr = fakeRecovery();
  const deps: Deps = {
    health: async () => ({ d1: "ok", r2: "ok", durable_objects: "ok" }),
    maintain: async (doId) => {
      clientFor(doId);
      const { runMaintenance } = await import("../src/maintain");
      return runMaintenance({
        store: stores.get(doId) as LibraryStore,
        blobs,
        bucket,
        libraryId: doId,
        now: new Date(),
      });
    },
    recovery: {
      async restore(doId, target, actor) {
        clientFor(doId);
        const { prepareRestore, restoresPrefix } = await import("../src/recovery");
        let t: { to: string } | { undo: RestoreRecord };
        if ("undo" in target) {
          const obj = await bucket.get(`${restoresPrefix(doId)}${target.undo}.json`);
          if (!obj)
            return { ok: false, status: 404, code: "not_found", message: "No such restore." };
          t = { undo: JSON.parse(new TextDecoder().decode(obj.body)) as RestoreRecord };
        } else {
          t = target;
        }
        return prepareRestore({
          store: stores.get(doId) as LibraryStore,
          blobs,
          bucket,
          recovery: pitr,
          libraryId: doId,
          target: t,
          actor,
          now: new Date(),
        });
      },
      async list(doId) {
        const { listRestores } = await import("../src/recovery");
        return listRestores(
          bucket,
          async (k) => {
            const o = await bucket.get(k);
            return o ? new TextDecoder().decode(o.body) : null;
          },
          doId,
        );
      },
    },
    exports: {
      async list(libraryId) {
        const { listExports } = await import("../src/maintain");
        const folders = (await listExports(bucket, libraryId)).reverse();
        return Promise.all(
          folders.map(async (folder) => {
            const m = await bucket.get(`${folder}manifest.json`);
            return {
              folder,
              manifest: m
                ? (JSON.parse(new TextDecoder().decode(m.body)) as Record<string, unknown>)
                : null,
            };
          }),
        );
      },
      get: (key) => bucket.get(key),
    },
    authenticate: async (secret) => {
      const t = TOKENS[secret];
      if (t) return t;
      const m = [...accounts.minted.values()].find((x) => x.secret === secret);
      if (!m) throw new OkfError(401, "bad_token", "Unknown bearer token.");
      if (m.revoked) throw new OkfError(401, "token_revoked", "This token has been revoked.");
      const lib = accounts.libs.find((l) => l.slug === m.library) as LibraryRef;
      return {
        id: m.id,
        actor: m.actor,
        scope: m.scope,
        prefix: m.prefix,
        mcp_tiers: m.mcp_tiers,
        library: { id: lib.id, slug: lib.slug, do_id: lib.do_id },
      };
    },
    accounts,
    blobs,
    library: (token) => clientFor(token.library.do_id),
    libraryByDoId: async (doId) =>
      accounts.libs.some((l) => l.do_id === doId) ? clientFor(doId) : null,
  };
  const worker = createWorker(() => deps);
  const kv = memoryKV();
  const env = { OAUTH_KV: kv, DEV_ACCESS_EMAIL: "owner@example.com" } as unknown as Env;
  const ctx = {
    waitUntil() {},
    passThroughOnException() {},
    props: {},
  } as unknown as ExecutionContext;

  /** Like Hono's app.request: a path or URL, resolved against http://localhost. */
  const app = {
    request: (input: string | URL | Request, init?: RequestInit) => {
      const request =
        input instanceof Request ? input : new Request(new URL(String(input), ORIGIN), init);
      return worker.fetch(
        request as Request<unknown, IncomingRequestCfProperties>,
        env,
        ctx,
      ) as Promise<Response>;
    },
  };
  const req = (path: string, init: RequestInit & { token?: string } = {}) => {
    const headers = new Headers(init.headers);
    if (init.token !== "") headers.set("Authorization", `Bearer ${init.token ?? "writer"}`);
    return app.request(`/api/v1/libraries/demo${path}`, { ...init, headers });
  };
  const store = () => stores.get(LIB.do_id) as LibraryStore;
  return { app, req, store, blobs, kv, env, accounts, deps, bucket, pitr };
}
