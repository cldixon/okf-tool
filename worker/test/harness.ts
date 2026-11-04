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
import { AuthCache, invalidatingAccounts } from "../src/authcache";
import { d1BlobRefs } from "../src/blobrefs";
import {
  type BlobStore,
  type CallFn,
  callStore,
  type LibraryClient,
  makeClient,
  recordingBlobStore,
} from "../src/client";
import { routedDb, withD1Session } from "../src/d1session";
import { callerOf, Presence, type PresenceMessage, readingOf } from "../src/feed";
import { sha256Hex } from "../src/format/hash";
import {
  d1SentLog,
  handleMailMessage,
  type MailJob,
  type Outbox,
  queueOutbox,
} from "../src/mail-queue";
import { d1Notifications } from "../src/notify";
import { Quota, QuotaCounter, quotaBackend, quotaGuarded } from "../src/quota";
import type { RestoreRecord } from "../src/recovery";
import { d1Sessions, SESSION_COOKIE } from "../src/session";
import type { ReadSurface } from "../src/store/reads";
import { RowTally } from "../src/store/sql";
import { LibraryStore } from "../src/store/store";
import type { UsageEvent } from "../src/usage";
import { bunD1 } from "./d1";
import { bunSqlHandle } from "./sqlite";

const { createWorker } = await import("../src/worker");

export function memoryBlobs(): BlobStore & {
  map: Map<string, Uint8Array>;
  /** Every `get`, in order, with its range when it had one (TEMPRA-183, TEMPRA-185). */
  gets: { hash: string; range?: { offset: number; length: number } }[];
} {
  const map = new Map<string, Uint8Array>();
  const gets: { hash: string; range?: { offset: number; length: number } }[] = [];
  return {
    map,
    gets,
    async put(hash, bytes) {
      map.set(hash, bytes);
    },
    async get(hash, range) {
      gets.push(range ? { hash, range } : { hash });
      const b = map.get(hash);
      if (!b) return null;
      const body = range ? b.subarray(range.offset, range.offset + range.length) : b;
      return { body, size: b.length };
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
export const UI = "/owner/demo";

export const TOKENS: Record<string, TokenInfo> = {
  writer: {
    id: "t1",
    actor: "claude-code/test",
    scope: "write",
    prefix: null,
    mcp_tiers: "all",
    library: LIB,
    role: "owner",
  },
  reader: {
    id: "t2",
    actor: "claude-code/reader",
    scope: "read",
    prefix: null,
    mcp_tiers: "all",
    library: LIB,
    role: "owner",
  },
  scoped: {
    id: "t3",
    actor: "process:scoped",
    scope: "write",
    prefix: "notes",
    mcp_tiers: "all",
    library: LIB,
    role: "owner",
  },
  process: {
    id: "t4",
    actor: "process:nightly-verify",
    scope: "write",
    prefix: null,
    mcp_tiers: "all",
    library: LIB,
    role: "owner",
  },
  human: {
    id: "t6",
    actor: "human:owner",
    scope: "write",
    prefix: null,
    mcp_tiers: "all",
    library: LIB,
    created_by: "user_1",
    role: "owner",
  },
  files: {
    id: "t5",
    actor: "claude-code/files-only",
    scope: "write",
    prefix: null,
    mcp_tiers: "files",
    library: LIB,
    role: "owner",
  },
};

export const ORIGIN = "http://localhost";

export function setup(
  opts: {
    /** The auth cache a deployment has (TEMPRA-84); off, every request asks D1. */ authCache?: boolean;
  } = {},
) {
  const blobs = memoryBlobs();
  /** Storage per library; tests lower it to see the limit. */
  const limits = { storageBytes: undefined as number | undefined };
  const stores = new Map<string, LibraryStore>();
  const calls = new Map<string, CallFn>();
  /**
   * The presence each library's object would send its feed sockets (TEMPRA-219), as the Library
   * DO makes it: after the call, throttled, for agents only.
   */
  const presence: { doId: string; message: PresenceMessage }[] = [];
  const callFor = (doId: string) => {
    let c = calls.get(doId);
    if (!c) {
      // Rows counted as the DO counts them, as near as bun:sqlite tells (TEMPRA-228).
      const rows = new RowTally();
      const store = new LibraryStore(bunSqlHandle(undefined, rows));
      stores.set(doId, store);
      const hub = new Presence();
      c = async (method, args, caller) => {
        const result = await callStore(store, blobs, method, args, {
          storageLimitBytes: limits.storageBytes,
          references: (hashes) => d1BlobRefs(d1).reference(doId, hashes, new Date()),
          reading: caller ? readingOf(caller) : null,
          rows,
        });
        const message = caller && result.ok ? hub.message(caller, method, result.value) : null;
        if (message) presence.push({ doId, message });
        return result;
      };
      calls.set(doId, c);
    }
    return c;
  };
  const clients = new Map<string, LibraryClient>();
  /** The library's client without a caller (the Worker's own calls), or for a token's caller. */
  const clientFor = (doId: string, token?: TokenInfo, surface?: ReadSurface) => {
    const caller = token ? callerOf(token, surface) : null;
    if (caller) return makeClient(callFor(doId), caller);
    let c = clients.get(doId);
    if (!c) {
      c = makeClient(callFor(doId));
      clients.set(doId, c);
    }
    return c;
  };
  clientFor(LIB.do_id);
  const { d1: base, db, sessions: d1Starts } = bunD1();
  /** Every D1 statement prepared, in order, so a test can count a request's round trips. */
  const queries: string[] = [];
  const prepare = base.prepare.bind(base);
  base.prepare = (sql: string) => {
    queries.push(sql);
    return prepare(sql);
  }; /** As deployed: each query in the request's D1 session (TEMPRA-85, d1session.ts). */
  const d1 = routedDb(base);

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
  const authCache = opts.authCache ? new AuthCache() : undefined;
  const accounts = authCache ? invalidatingAccounts(d1Accounts(d1), authCache) : d1Accounts(d1);
  const sessions = d1Sessions(d1, Date.now, authCache);
  const notifications = d1Notifications(d1);
  const outbox: {
    to: string;
    subject: string;
    text: string;
    html?: string;
    headers?: Record<string, string>;
  }[] = [];
  /** Metered usage, as the Worker would write it to Analytics Engine. */
  const usage: UsageEvent[] = [];
  /**
   * Queued mail (TEMPRA-89) as MAIL_QUEUE delivers it, at once: each message through the real
   * consumer, with its dedupe keys in D1 and a mailer that lands in `outbox`.
   */
  const mailQueue: MailJob[] = [];
  const queuedMail: Outbox = queueOutbox(async (job) => {
    mailQueue.push(job);
    await handleMailMessage(
      {
        mailer: {
          async send(msg) {
            outbox.push(msg);
          },
        },
        sent: d1SentLog(d1),
        recordFailure: (day) => notifications.recordFailure(day),
        meter: (e) => usage.push(e),
        now: () => new Date(),
      },
      job,
      1,
    );
  });
  // No cache, so a revocation shows at once.
  const d1Auth = authCache
    ? d1Authenticate(d1, Date.now, authCache.ms, authCache.tokens)
    : d1Authenticate(d1, Date.now, 0);
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
  /**
   * The web as the Worker's outbound fetch sees it (TEMPRA-157): a handler per URL, anything
   * else 404s; `fetched` lists what was asked for. Nothing leaves the process.
   */
  const web = new Map<string, (init?: RequestInit) => Response | Promise<Response>>();
  const fetched: string[] = [];
  /**
   * The monthly quotas (TEMPRA-232) as the Worker runs them, with each account's object a
   * QuotaCounter on bun:sqlite. Every count flushes at once, so tests see exact totals; `clock`
   * moves the quotas' time (a month on, for the reset).
   */
  const clock = { now: () => Date.now() };
  const counters = new Map<string, QuotaCounter>();
  const counter = (account: string) => {
    let c = counters.get(account);
    if (!c) {
      c = new QuotaCounter(bunSqlHandle());
      counters.set(account, c);
    }
    const it = c;
    return {
      quotaAdd: async (month: string, add: { writes: number; requests: number }) =>
        it.add(month, add),
      quotaMark: async (month: string, keys: string[]) => it.mark(month, keys),
    };
  };
  const quota = new Quota(
    quotaBackend(d1, counter, queuedMail, notifications),
    // With the auth cache, an isolate as deployed: the account's limits and storage kept a
    // minute (REFRESH_MS), so a warm isolate asks D1 nothing for the quotas either.
    {
      origin: ORIGIN,
      now: () => clock.now(),
      flushMs: 0,
      ...(opts.authCache ? {} : { refreshMs: 0 }),
    },
  );
  const deps: Deps = {
    fetch: async (url, init) => {
      fetched.push(url);
      const h = web.get(url);
      return h ? h(init) : new Response("not found", { status: 404 });
    },
    health: async () => ({ d1: "ok", r2: "ok", durable_objects: "ok" }),
    maintain: async (doId) => {
      clientFor(doId);
      const { runMaintenance } = await import("../src/maintain");
      return runMaintenance({
        store: stores.get(doId) as LibraryStore,
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
    authCache,
    sessions,
    notifications,
    async destroyLibrary(doId) {
      stores.delete(doId);
      clients.delete(doId);
      const { exportsPrefix } = await import("../src/maintain");
      const { restoresPrefix } = await import("../src/recovery");
      for (const k of [...bucket.objects.keys()]) {
        if (k.startsWith(exportsPrefix(doId)) || k.startsWith(restoresPrefix(doId))) {
          bucket.objects.delete(k);
        }
      }
      await d1BlobRefs(d1).forget(doId, new Date());
    },
    mailer: {
      async send(msg) {
        outbox.push(msg);
      },
    },
    outbox: queuedMail,
    meter: (e) => usage.push(e),
    blobs: recordingBlobStore(blobs, d1BlobRefs(d1)),
    quota,
    library: (token, surface) =>
      quotaGuarded(quota, token, clientFor(token.library.do_id, token, surface)),
    libraryByDoId: async (doId) =>
      db.query("SELECT 1 FROM libraries WHERE do_id = ?").get(doId) ? clientFor(doId) : null,
  };
  const worker = createWorker(() => deps);
  const kv = memoryKV();
  // Tests sign up new accounts freely; sign-in tests set SIGNUP to try the other modes.
  const env = { OAUTH_KV: kv, SIGNUP: "open" } as unknown as Env;
  /** What requests left running after their response (ctx.waitUntil), for tests to await. */
  const waits: Promise<unknown>[] = [];
  const settled = async () => {
    while (waits.length > 0) await Promise.allSettled(waits.splice(0));
  };
  const ctx = {
    waitUntil(p: Promise<unknown>) {
      waits.push(p);
    },
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
      // One D1 session per request, its bookmark carried back, as the Worker's fetch does.
      return withD1Session(
        base,
        request,
        async () =>
          worker.fetch(
            request as Request<unknown, IncomingRequestCfProperties>,
            env,
            ctx,
          ) as Promise<Response>,
      );
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
    authCache,
    sessions,
    notifications,
    outbox,
    mailQueue,
    db,
    queries,
    deps,
    bucket,
    pitr,
    web,
    fetched,
    usage,
    limits,
    quota,
    clock,
    counters,
    /** The account layer's D1 (bun:sqlite behind D1's API). */
    d1,
    /** Where each request's D1 session started, in order (TEMPRA-85). */
    d1Starts,
    stranger,
    sessionFor,
    /** Presence the libraries' objects would have sent, in order (TEMPRA-219). */
    presence,
    /** The cookie secret `app` sends. */
    ownerSession,
    /** Awaits what requests left running after their responses. */
    settled,
  };
}
