/**
 * The real Worker in process: Cloudflare's OAuth provider in front of the app, bun:sqlite stores
 * behind the same callStore the DO uses, the account layer's real SQL on bun:sqlite (d1.ts), and
 * in-memory KV and blobs. Requests through `app` are signed in as the demo library's owner.
 */
import { mock } from "bun:test";

// `cloudflare:workers` only exists inside workerd; the OAuth library imports WorkerEntrypoint.
mock.module("cloudflare:workers", () => ({ DurableObject: class {}, WorkerEntrypoint: class {} }));
// As in cloudflare.config.ts: the OAuth library enables CIMD only under global_fetch_strictly_public.
Object.assign(globalThis, {
  Cloudflare: { compatibilityFlags: { global_fetch_strictly_public: true } },
});

import { d1Accounts, type LibraryRef } from "../src/accounts";
import type { Deps } from "../src/app";
import { d1Authenticate, type TokenInfo } from "../src/auth";
import { type BlobStore, callStore, type LibraryClient, makeClient } from "../src/client";
import { sha256Hex } from "../src/okf/hash";
import type { RestoreRecord } from "../src/recovery";
import { d1Sessions, SESSION_COOKIE } from "../src/session";
import { LibraryStore } from "../src/store/store";
import { bunD1 } from "./d1";
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

/** The signed-in owner of the demo library, and their library. */
export const OWNER = { id: "user_1", email: "owner@example.com", handle: "owner" };
export const LIB: LibraryRef = { id: "lib-1", slug: "demo", do_id: "lib-1", owner: "owner" };
/** The demo library's paths. */
export const API = "/api/v1/libraries/owner/demo";
export const UI = "/app/libraries/owner/demo";

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
  const { d1, db } = bunD1();
  const now = new Date().toISOString();
  db.run("INSERT INTO users (id, email, actor, handle, created) VALUES (?, ?, ?, ?, ?)", [
    OWNER.id,
    OWNER.email,
    `human:${OWNER.handle}`,
    OWNER.handle,
    now,
  ]);
  db.run(
    "INSERT INTO libraries (id, slug, owner, visibility, created, do_id) VALUES (?, ?, ?, 'private', ?, ?)",
    [LIB.id, LIB.slug, OWNER.id, now, LIB.do_id],
  );
  const accounts = d1Accounts(d1);
  const sessions = d1Sessions(d1);
  const outbox: { to: string; subject: string; text: string }[] = [];
  // No cache, so a revocation shows at once.
  const d1Auth = d1Authenticate(d1, Date.now, 0);
  /** A session for a user, written straight to D1 (setup stays synchronous). */
  const sessionFor = (userId: string) => {
    const secret = `session-${userId}-${crypto.randomUUID()}`;
    const later = new Date(Date.now() + 86_400_000).toISOString();
    db.run(
      "INSERT INTO sessions (hash, user, created, last_seen, idle_expires, expires) VALUES (?, ?, ?, ?, ?, ?)",
      [sha256Hex(secret), userId, now, now, later, later],
    );
    return secret;
  };
  const ownerSession = sessionFor(OWNER.id);
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
      return d1Auth(secret);
    },
    accounts,
    sessions,
    mailer: {
      async send(msg) {
        outbox.push(msg);
      },
    },
    blobs,
    library: (token) => clientFor(token.library.do_id),
    libraryByDoId: async (doId) =>
      db.query("SELECT 1 FROM libraries WHERE do_id = ?").get(doId) ? clientFor(doId) : null,
  };
  const worker = createWorker(() => deps);
  const kv = memoryKV();
  const env = { OAUTH_KV: kv } as unknown as Env;
  const ctx = {
    waitUntil() {},
    passThroughOnException() {},
    props: {},
  } as unknown as ExecutionContext;

  /**
   * Like Hono's app.request: a path or URL, resolved against http://localhost, sent with the
   * given session's cookie (added to any cookies the request already has); null sends none.
   */
  const client = (session: string | null) => ({
    request: (input: string | URL | Request, init?: RequestInit) => {
      const request =
        input instanceof Request ? input : new Request(new URL(String(input), ORIGIN), init);
      if (session && !(request.headers.get("Cookie") ?? "").includes(SESSION_COOKIE)) {
        const cookie = request.headers.get("Cookie");
        const ours = `${SESSION_COOKIE}=${session}`;
        request.headers.set("Cookie", cookie ? `${cookie}; ${ours}` : ours);
      }
      return worker.fetch(
        request as Request<unknown, IncomingRequestCfProperties>,
        env,
        ctx,
      ) as Promise<Response>;
    },
  });
  /** Requests as the demo library's owner. */
  const app = client(ownerSession);
  /** Requests with no session. */
  const anon = client(null);
  const req = (path: string, init: RequestInit & { token?: string } = {}) => {
    const headers = new Headers(init.headers);
    if (init.token !== "") headers.set("Authorization", `Bearer ${init.token ?? "writer"}`);
    return anon.request(`${API}${path}`, { ...init, headers });
  };

  /**
   * Another account: signed in, owning a library also named demo, with a write token for it
   * and a human: token. Nothing of theirs should ever reach the owner, or the other way round.
   */
  const stranger = async (email = "stranger@example.com") => {
    const user = await accounts.user(email);
    const lib = await accounts.createLibrary("demo", user);
    clientFor(lib.do_id);
    const writer = await accounts.createToken({
      libraryId: lib.id,
      actor: "claude-code/stranger",
      scope: "write",
      prefix: null,
      expires: null,
      mcpTiers: "all",
      createdBy: user.id,
    });
    const human = await accounts.createToken({
      libraryId: lib.id,
      actor: user.actor,
      scope: "write",
      prefix: null,
      expires: null,
      mcpTiers: "all",
      createdBy: user.id,
    });
    return {
      user,
      lib,
      app: client(sessionFor(user.id)),
      writer: writer.secret,
      human: human.secret,
    };
  };
  const store = () => stores.get(LIB.do_id) as LibraryStore;
  return {
    app,
    anon,
    req,
    store,
    blobs,
    kv,
    env,
    accounts,
    sessions,
    outbox,
    db,
    deps,
    bucket,
    pitr,
    stranger,
    sessionFor,
  };
}
