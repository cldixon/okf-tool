import { type Doc, parseMarkdown } from "@tempra/editor/doc";
import { type Context, Hono } from "hono";
import { routePath } from "hono/route";
import { registerAccountApi } from "./account-api";
import { type Accounts, checkNewToken, humanActor, type MemberRole, type User } from "./accounts";
import { tokenAgent } from "./agents";
import type { Authenticate, TokenInfo } from "./auth";
import type { AuthCache } from "./authcache";
import {
  type BlobStore,
  bundleFiles,
  describeBlob,
  imagesWithDimensions,
  type LibraryClient,
  mediaFor,
  putBlob,
  WORKER_ATTACHMENT_CAP,
  withDimensions,
} from "./client";
import { bundleStream, exportFormat } from "./export-bundle";
import { type FetchFn, fetchBlob } from "./fetch-source";
import { splitFrontmatter } from "./format/page";
import { normalizePath, underPrefix } from "./format/paths";
import type { JsonObject } from "./format/types";
import type { Images } from "./images";
import { registerInboxApi } from "./inbox-api";
import { registerLegalRoutes, type SiteService } from "./legal";
import { deleteLibrary } from "./lifecycle";
import type { Outbox } from "./mail-queue";
import type { ManagedDeps } from "./managed/agent";
import { managedAgents, type Notifications, notifying, postComment } from "./notify";
import { messagePage, wantsPage } from "./oauth/pages";
import { type GrantProps, registerAppRoutes } from "./oauth/routes";
import { withCostHeader, withCosts } from "./op-costs";
import { fromThisSite } from "./origin";
import type { RestoreOutcome, RestoreRecord } from "./recovery";
import type { PosterFrame, RenderContext, RenderDiagram } from "./render";
import { readCookie, SESSION_COOKIE, type Sessions } from "./session";
import { type Mailer, registerSignInRoutes } from "./signin";
import { threadKind } from "./store/comments";
import { StoreError } from "./store/errors";
import type { ReadSurface } from "./store/reads";
import {
  type AttachFacts,
  type BlobRef,
  checkFacts,
  type ExportFormat,
  type FileView,
  type PageContent,
  type RequestContext,
  type WriteOp,
  type WriteResult,
} from "./store/store";
import {
  type AccountGrant,
  authorizeLibrary,
  createLibraryForGrant,
  type Found,
  requireOwner,
  sessionToken,
} from "./tenancy";
import { registerUiRoutes } from "./ui/routes";
import { STARTER, STARTER_PATH } from "./ui/starter";
import {
  checkLength,
  checkMedia,
  checkOrigin,
  prepareUpload,
  readCapped,
  type UploadGrant,
} from "./uploads";
import {
  type Admission,
  admit,
  admitSession,
  RETRY_AFTER_S,
  tokenAdmission,
  type UsageDeps,
} from "./usage";
import { maybeGunzip, readTar } from "./util/tar";
import { registerWaitlistRoutes } from "./waitlist";

/** What the app needs from the platform; production wires D1, the DO and R2, tests fakes. */
export interface Deps extends UsageDeps {
  authenticate: Authenticate;
  /** Users, libraries and tokens in D1, always scoped to one account. */
  accounts: Accounts;
  /** Magic links and browser sessions (v2 spec: Accounts and sign-in). */
  sessions: Sessions;
  /**
   * The isolate's auth cache (authcache.ts, TEMPRA-84), which `sessions`, `authenticate` and
   * `accounts` share in a deployment; absent, every request asks D1.
   */
  authCache?: AuthCache;
  /**
   * Sends now: links a person waits on (sign-in, a new email's confirmation), retried once in the
   * request; without one, only local dev with DEV_SIGNIN=1 can sign in.
   */
  mailer?: Mailer | null;
  /**
   * Queues mail nobody waits on (TEMPRA-89, mail-queue.ts): invitations, notification batches,
   * quota notices, the waitlist's and the operator's; the MAIL_QUEUE consumer sends them with
   * retries. None: no such mail.
   */
  outbox?: Outbox | null;
  /**
   * The token's library, its calls made as the token's caller (feed.ts `callerOf`): `surface` is
   * where they come from, for read history (TEMPRA-220); the app for a session, the REST API for
   * a bearer token, unless the caller says MCP.
   */
  library(token: TokenInfo, surface?: ReadSurface): LibraryClient;
  /** The library a signed download URL names, or null when no such library exists. */
  libraryByDoId(doId: string): Promise<LibraryClient | null>;
  blobs: BlobStore;
  /**
   * Attachment images scaled for models and readers (images.ts, the IMAGES binding); absent,
   * images go out as stored when they are small enough.
   */
  images?: Images;
  /**
   * Outbound fetch for attaching from a URL (TEMPRA-157, fetch-source.ts); absent, the global
   * fetch. Tests pass a double.
   */
  fetch?: FetchFn;
  /**
   * The landing page's Worker (site/, the SITE service binding; TEMPRA-276, legal.ts): `/` for
   * people signed out and the site's own paths. Absent (local dev, tests), signed-out `/` goes to
   * sign-in and /terms and /privacy redirect to tempra.dev.
   */
  site?: SiteService | null;
  /** Checks for /healthz: each dependency's name and "ok" or what failed. */
  health?: () => Promise<Record<string, string>>;
  /** Nightly exports in R2 (spec: Backups and recovery), for the UI. */
  exports?: ExportStore;
  /** Runs a library's daily maintainers now, by its Durable Object name. */
  maintain?: (doId: string) => Promise<unknown>;
  /** Point-in-time restore of a library, by its Durable Object name (spec: Backups and recovery). */
  recovery?: RecoveryDeps;
  /** Wipes a library's storage: its Durable Object, R2 exports and restore records (lifecycle.ts). */
  destroyLibrary?: (doId: string) => Promise<void>;
  /**
   * Hands a WebSocket upgrade to the library's Durable Object, which holds the change feed
   * (feed.ts); `prefix` limits it to a directory. `account` is whose cap on open sockets it
   * counts against (TEMPRA-80).
   */
  feed?: (
    doId: string,
    request: Request,
    opts: { prefix: string; account: string },
  ) => Promise<Response>;
  /** The inbox, read cursors and mail settings in D1 (notify.ts); absent, nobody is notified. */
  notifications?: Notifications | null;
  /** The managed agent's queue and its "replying" presence (TEMPRA-222); absent, @tempra is plain text. */
  managed?: ManagedDeps | null;
  /**
   * Draws a Mermaid source to SVG (and PNG) through the render Worker (render.ts, TEMPRA-165);
   * absent, or with no RENDER binding, it answers "render unavailable".
   */
  renderDiagram?: RenderDiagram;
  /** A video's frame for a poster through the render Worker (TEMPRA-208); absent, unavailable. */
  posterFrame?: PosterFrame;
  /**
   * How long a write's answer waits for its diagrams' verdicts from the render service
   * (render-lint.ts, TEMPRA-167); RENDER_LINT_BUDGET_MS unless set.
   */
  renderBudgetMs?: number;
}

export interface RecoveryDeps {
  /** Arms the restore and restarts the library into it; `undo` names an earlier restore. */
  restore(
    doId: string,
    target: { to: string } | { undo: string },
    actor: string,
  ): Promise<RestoreOutcome>;
  /** The library's restores, newest first. */
  list(doId: string): Promise<RestoreRecord[]>;
}

export interface ExportStore {
  /** A library's export folders, newest first, with their manifests. */
  list(libraryId: string): Promise<{ folder: string; manifest: Record<string, unknown> | null }[]>;
  get(key: string): Promise<{ body: ReadableStream | Uint8Array; size: number } | null>;
}

type Env = {
  Bindings: Cloudflare.Env;
  Variables: { token: TokenInfo; lib: LibraryClient; deps: Deps };
};
type C = Context<Env>;

/** Keeps work going after the response (ctx.waitUntil); without an execution context, it runs on. */
const afterResponse =
  (c: C) =>
  (p: Promise<unknown>): void => {
    try {
      c.executionCtx.waitUntil(p);
    } catch {}
  };

/** A library's routes: {owner} is its owner's handle (v2 spec: Tenancy and authorization). */
const BASE = "/api/v1/libraries/:owner/:lib";

function tail(c: C, marker: string): string {
  const path = c.req.path;
  const i = path.indexOf(marker);
  const rest = i === -1 ? "" : path.slice(i + marker.length);
  return rest
    .split("/")
    .map((s) => {
      try {
        return decodeURIComponent(s);
      } catch {
        return s;
      }
    })
    .join("/");
}

function num(c: C, name: string): number | undefined {
  const v = c.req.query(name);
  if (v === undefined || v === "") return undefined;
  const n = Number(v);
  if (!Number.isInteger(n))
    throw new StoreError(400, "bad_param", `\`${name}\` must be an integer.`);
  return n;
}

function bool(c: C, name: string): boolean | undefined {
  const v = c.req.query(name);
  if (v === undefined || v === "") return undefined;
  return v === "true" || v === "1";
}

/** How long the library list waits on one library's summary before listing it unavailable. */
export const SUMMARY_MS = 5000;

/** `run()`, refused after `ms`: one slow library never holds a list of them. */
async function within<T>(ms: number, run: () => Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`timed out after ${ms} ms`)), ms);
  });
  try {
    return await Promise.race([run(), late]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

function etag(header: string | undefined): string | null {
  if (!header) return null;
  return header.trim().replace(/^W\//, "").replace(/^"|"$/g, "") || null;
}

function requestContext(c: C, note?: unknown): RequestContext {
  const header = c.req.header("X-Note");
  return {
    actor: c.var.token.actor,
    request_id: crypto.randomUUID(),
    note: typeof note === "string" && note ? note : header ? decodeURIComponent(header) : null,
    by: actedBy(c.var.token),
  };
}

/** The person and agent behind a token, for the ledger (tempra-dev: agents act for a person). */
export function actedBy(t: TokenInfo): RequestContext["by"] {
  if (!t.created_by) return null;
  return t.agent ? { person: t.created_by, agent: t.agent } : { person: t.created_by };
}

/** Content writes: write, edit, move, delete, attach, revert, import, verify. */
function requireWrite(c: C, ...paths: string[]) {
  const t = c.var.token;
  if (t.scope !== "write") throw readOnly(t);
  underTokenPrefix(t, paths);
}

/**
 * Comments (tempra-dev: v2/sharing): a separate permission from writing content, which every
 * caller that reaches the library has, read included; a prefix still limits where.
 */
function requireComment(c: C, path: string) {
  underTokenPrefix(c.var.token, [path]);
}

function readOnly(t: TokenInfo): StoreError {
  return new StoreError(
    403,
    "read_only",
    t.role === "read"
      ? "You have read access to this library: you can read and comment, not change it."
      : "This token is read-only: it can read and comment, not change content.",
  );
}

function underTokenPrefix(t: TokenInfo, paths: string[]) {
  if (t.prefix === null) return;
  const prefix = t.prefix;
  for (const p of paths) {
    const n = normalizePath(p) ?? "";
    if (!underPrefix(n, prefix)) {
      throw new StoreError(403, "outside_prefix", `This token may only write under ${prefix}/.`);
    }
  }
}

async function json<T>(c: C): Promise<T> {
  try {
    return (await c.req.json()) as T;
  } catch {
    throw new StoreError(400, "bad_json", "The request body must be JSON.");
  }
}

function isMarkdownRequest(c: C, path: string): boolean {
  const type = (c.req.header("Content-Type") ?? "").toLowerCase();
  if (type.startsWith("application/json") || type.startsWith("text/markdown")) return true;
  if (path.endsWith(".md")) return true;
  return false;
}

/** A batch op as sent over the wire; attachments reference an uploaded blob by hash. */
type WireOp =
  | {
      op: "write";
      path: string;
      content: PageContent;
      if_match?: string;
      if_none_match?: boolean;
    }
  | { op: "edit"; path: string; edits: { old: string; new: string }[]; if_match?: string }
  | { op: "move"; path: string; to: string }
  | { op: "delete"; path: string; if_match?: string }
  | {
      op: "attach";
      path: string;
      blob: string;
      media?: string;
      if_match?: string;
      if_none_match?: boolean;
    };

/**
 * `POST …/files/{path}?from=<url>`, or a JSON body `{ source_url, description?, note? }`
 * (TEMPRA-157): the Worker fetches a public https file and attaches it at `path`, as MCP `attach`
 * with `source_url` does, with the URL and fetch time in the ledger. A write: it counts against
 * the caller's write limit like any POST, and the fetch is metered as `fetch`.
 */
async function attachFromUrl(c: C, path: string): Promise<Response> {
  requireWrite(c, path);
  const type = (c.req.header("Content-Type") ?? "").toLowerCase();
  const body = type.startsWith("application/json")
    ? await json<{
        source_url?: unknown;
        description?: unknown;
        credit?: unknown;
        licence?: unknown;
        note?: unknown;
      }>(c)
    : {};
  const from = c.req.query("from") ?? body.source_url;
  if (typeof from !== "string" || from === "") {
    throw new StoreError(
      400,
      "bad_attach",
      "POST /files/{path} attaches from a URL: pass ?from=<https URL> or a JSON body { source_url }; or POST /files/{path}/move.",
    );
  }
  const clean = normalizePath(path);
  if (!clean || clean.endsWith(".md")) {
    throw new StoreError(400, "bad_attachment", "Markdown files are pages, not attachments.");
  }
  const facts = queryFacts(c, body);
  const d = c.var.deps;
  const got = await fetchBlob(
    {
      fetch: d.fetch ?? ((u, i) => fetch(u, i)),
      blobs: d.blobs,
      selfHosts: [new URL(c.req.url).hostname],
    },
    from,
    clean,
  );
  d.meter?.({
    kind: "fetch",
    account: tokenAdmission(c.var.token).account,
    library: c.var.token.library.id,
    bytes: got.bytes.byteLength,
  });
  const ifMatch = etag(c.req.header("If-Match"));
  const ifNoneMatch = c.req.header("If-None-Match")?.trim() === "*";
  const res = await c.var.lib.apply(requestContext(c, body.note), [
    {
      op: "attach",
      path: clean,
      blob: got.blob,
      if_match: ifMatch,
      if_none_match: ifNoneMatch,
      source: got.source,
      ...facts,
    },
  ]);
  return writeResponse(c, res);
}

/**
 * An attachment's description, credit and licence (TEMPRA-170) from the query string, else a
 * JSON body: how REST writes them beside the bytes.
 */
function queryFacts(
  c: C,
  body: { description?: unknown; credit?: unknown; licence?: unknown } = {},
): AttachFacts {
  return checkFacts({
    description: c.req.query("description") ?? body.description,
    credit: c.req.query("credit") ?? body.credit,
    licence: c.req.query("licence") ?? body.licence,
  });
}

export function createApp(deps: (env: Cloudflare.Env) => Deps) {
  const app = new Hono<Env>();

  app.onError((err, c) => {
    if (err instanceof StoreError) {
      // Over a per-minute limit: when to try again, for scripts and the app's quiet backoff.
      if (err.status === 429) c.header("Retry-After", String(RETRY_AFTER_S));
      if (err.status === 429 && !c.req.path.startsWith("/api/")) {
        const res = messagePage("Slow down", err.message, 429);
        res.headers.set("Retry-After", String(RETRY_AFTER_S));
        return res;
      }
      if (wantsPage(c.req.raw)) {
        const title =
          err.status === 404
            ? "Not found"
            : err.status === 403
              ? "Not allowed"
              : "Something went wrong";
        return messagePage(title, err.message, err.status);
      }
      return c.json(err.toJSON(), err.status as 400);
    }
    console.error(err);
    // A person's page load gets a page, never raw JSON (V-1); the API and MCP keep JSON.
    if (wantsPage(c.req.raw)) {
      return messagePage(
        "Something went wrong",
        "Tempra could not answer this page. Try again in a moment.",
        500,
      );
    }
    return c.json({ error: "Internal error.", code: "internal" }, 500);
  });

  app.notFound((c) =>
    wantsPage(c.req.raw)
      ? messagePage("Not found", "There is no page at this address.", 404)
      : c.json({ error: "No such route.", code: "no_route" }, 404),
  );

  // Spec: Observability. Public, and says only which dependency failed.
  app.get("/healthz", async (c) => {
    const health = deps(c.env).health;
    const checks = health ? await health() : {};
    const ok = Object.values(checks).every((v) => v === "ok");
    return c.json({ ok, checks }, ok ? 200 : 503);
  });

  // The static assets' prefixes (TEMPRA-174): a file there is served before the Worker runs, so
  // what reaches it is a name no build wrote (an old hash, a typo). A plain 404, never a page or a
  // handle's redirect, and before the session's limit.
  app.get("/_app/*", (c) => c.notFound());
  app.get("/_design/*", (c) => c.notFound());

  // Everything below (pages, the API, downloads, feed upgrades) counts against a browser
  // session's limit when it carries the session cookie and no bearer token (TEMPRA-80). The
  // static files (/_app/, /_design/, /favicon.svg) are Workers static assets served before the
  // Worker runs (TEMPRA-174), so they never get here. A request with a token is limited per token
  // instead.
  app.use("*", async (c, next) => {
    const secret =
      c.req.header("Authorization") === undefined ? readCookie(c.req.raw, SESSION_COOKIE) : null;
    if (secret) await admitSession(deps(c.env), secret);
    await next();
  });

  app.use(`${BASE}/*`, async (c, next) => {
    const d = deps(c.env);
    const [owner, slug] = [c.req.param("owner"), c.req.param("lib")];
    // A session finds its person, the library and their membership in one D1 query (TEMPRA-192).
    const who = await principal(c, d, { owner, slug });
    const ref = await authorizeLibrary(d.accounts, who, owner, slug, who.found);
    const token = "token" in who ? who.token : sessionToken(who.user, ref);
    // A person signed in to the app is metered here but limited only per session (above), so
    // agents spending the account's write budget never lock its owner out of the UI.
    const write = c.req.method !== "GET" && c.req.method !== "HEAD";
    await admit(d, tokenAdmission(token), write, "token" in who);
    c.set("deps", d);
    c.set("token", token);
    c.set("lib", notifying(d, token, d.library(token), afterResponse(c)));
    // What the request cost its library's object, metered under its route (TEMPRA-228).
    const { cost } = await withCosts(() => next());
    if (cost.calls > 0) {
      const op = `${c.req.method} ${routePath(c, -1).slice(BASE.length) || "/"}`;
      const { account, library } = tokenAdmission(token);
      d.meter?.({ kind: "cost", account, library, op, cost });
      if (c.res.status !== 101) c.res = withCostHeader(c.req.raw, c.res, cost);
    }
  });

  // ------------------------------------------------------------------ files

  app.get(`${BASE}/files/*`, async (c) => {
    const path = tail(c, "/files/");
    const wantsJson = (c.req.header("Accept") ?? "").includes("application/json");
    const view = await c.var.lib.read(path, {
      at: num(c, "at"),
      computed: bool(c, "computed"),
      // The reader's images: each one's hash and size (TEMPRA-162).
      images: wantsJson,
    });
    c.header("X-Seq", String(view.seq));
    if (view.kind === "attachment" && wantsJson) {
      c.header("ETag", `"${view.hash}"`);
      return c.json(await fileJson(c.var.lib, c.var.deps.blobs, view));
    }
    if (view.kind === "attachment") {
      c.header("ETag", `"${view.hash}"`);
      c.header("Content-Type", view.media ?? "application/octet-stream");
      c.header("Content-Length", String(view.size));
      c.header("Content-Disposition", `attachment; filename="${view.path.split("/").pop()}"`);
      c.header("Content-Security-Policy", "default-src 'none'; sandbox");
      c.header("X-Content-Type-Options", "nosniff");
      if (c.req.method === "HEAD") return c.body(null);
      const obj = await c.var.deps.blobs.get(view.hash);
      if (!obj) throw new StoreError(500, "blob_missing", `Bytes for ${view.path} are missing.`);
      return c.body(obj.body as ReadableStream);
    }
    if (view.kind === "page") c.header("ETag", `"${view.hash}"`);
    if (wantsJson) return c.json(await fileJson(c.var.lib, c.var.deps.blobs, view));
    return c.body(view.markdown, 200, { "Content-Type": "text/markdown; charset=utf-8" });
  });

  // A file's page in one request (TEMPRA-191): the file as `files/{path}` describes it in JSON,
  // the head, and for a page its sources, links and versions, read together at one seq. The
  // app asked for these five separately; the separate routes stay for agents and the API.
  app.get(`${BASE}/page/*`, async (c) => {
    const { file, ...rest } = await c.var.lib.page(tail(c, "/page/"), { at: num(c, "at") });
    c.header("X-Seq", String(file.seq));
    return c.json({ file: await fileJson(c.var.lib, c.var.deps.blobs, file), ...rest });
  });

  // The app's read of the page it shows (TEMPRA-220, tempra-dev: v2/read-history): one per page
  // a person opens, so its prefetches, the shell's boot data and its background re-checks (all
  // GETs, never counted for a session) do not count. A session's alone: a token's reads are
  // counted as they happen. Answers the page's read history with this read in it.
  app.post(`${BASE}/read/*`, async (c) => {
    if (!c.var.token.id.startsWith("session:")) {
      throw new StoreError(
        400,
        "app_only",
        "This route is the app's. Reads through the API and MCP are counted as they happen.",
      );
    }
    return c.json(await c.var.lib.viewed(tail(c, "/read/")));
  });

  app.put(`${BASE}/files/*`, async (c) => {
    const path = tail(c, "/files/");
    requireWrite(c, path);
    const ifMatch = etag(c.req.header("If-Match"));
    const ifNoneMatch = c.req.header("If-None-Match")?.trim() === "*";
    let op: WriteOp;
    const xblob = c.req.header("X-Blob");
    if (xblob) {
      op = {
        op: "attach",
        path,
        blob: await describeBlob(
          c.var.deps.blobs,
          xblob,
          mediaFor(path, c.req.header("Content-Type")),
          path,
        ),
        if_match: ifMatch,
        if_none_match: ifNoneMatch,
        ...queryFacts(c),
      };
    } else if (isMarkdownRequest(c, path)) {
      const type = (c.req.header("Content-Type") ?? "").toLowerCase();
      const content: PageContent = type.startsWith("application/json")
        ? await json<{ frontmatter: JsonObject; doc: Doc }>(c)
        : await c.req.text();
      op = { op: "write", path, content, if_match: ifMatch, if_none_match: ifNoneMatch };
    } else {
      const bytes = new Uint8Array(await c.req.arrayBuffer());
      const blob = await putBlob(
        c.var.deps.blobs,
        bytes,
        mediaFor(path, c.req.header("Content-Type")),
        path,
      );
      op = {
        op: "attach",
        path,
        blob,
        if_match: ifMatch,
        if_none_match: ifNoneMatch,
        ...queryFacts(c),
      };
    }
    const res = await c.var.lib.apply(requestContext(c), [op]);
    return writeResponse(c, res);
  });

  app.patch(`${BASE}/files/*`, async (c) => {
    const path = tail(c, "/files/");
    requireWrite(c, path);
    const body = await json<{ edits: { old: string; new: string }[]; note?: string }>(c);
    const res = await c.var.lib.apply(requestContext(c, body.note), [
      { op: "edit", path, edits: body.edits, if_match: etag(c.req.header("If-Match")) },
    ]);
    return writeResponse(c, res);
  });

  app.delete(`${BASE}/files/*`, async (c) => {
    const path = tail(c, "/files/");
    requireWrite(c, path);
    const res = await c.var.lib.apply(requestContext(c), [
      { op: "delete", path, if_match: etag(c.req.header("If-Match")) },
    ]);
    return writeResponse(c, res);
  });

  app.post(`${BASE}/files/*`, async (c) => {
    const path = tail(c, "/files/");
    if (!path.endsWith("/move")) return attachFromUrl(c, path);
    const from = path.slice(0, -"/move".length);
    const body = await json<{ to: string; note?: string }>(c);
    if (typeof body.to !== "string") throw new StoreError(400, "bad_move", "Send { to }.");
    requireWrite(c, from, body.to);
    const res = await c.var.lib.apply(requestContext(c, body.note), [
      { op: "move", path: from, to: body.to },
    ]);
    return writeResponse(c, res);
  });

  // An upload URL (TEMPRA-158), as MCP's prepare_upload gives one: with a path, the PUT attaches
  // the bytes there; without, it stores them and answers with their hash for X-Blob.
  app.post(`${BASE}/uploads`, async (c) => {
    const body = await json<{
      path?: unknown;
      media?: unknown;
      origin?: unknown;
      if_match?: unknown;
      description?: unknown;
      credit?: unknown;
      licence?: unknown;
      note?: unknown;
    }>(c);
    const path = typeof body.path === "string" && body.path !== "" ? body.path : null;
    if (path) requireWrite(c, path);
    else requireWrite(c);
    const media = typeof body.media === "string" && body.media ? body.media : null;
    const facts = path ? checkFacts(body) : {};
    const ctx = requestContext(c, body.note);
    const prepared = await prepareUpload(c.var.lib, new URL(c.req.url).origin, {
      path,
      media: media ?? (path ? mediaFor(path) : null),
      ...(path ? { origin: checkOrigin(body.origin) } : {}),
      if_match: typeof body.if_match === "string" ? body.if_match : undefined,
      ...facts,
      note: ctx.note ?? null,
      actor: ctx.actor,
      by: ctx.by,
      token: c.var.token,
    });
    return c.json(prepared, 201);
  });

  app.post(`${BASE}/batch`, async (c) => {
    const body = await json<{ ops: WireOp[]; note?: string }>(c);
    if (!Array.isArray(body.ops)) throw new StoreError(400, "bad_batch", "Send { ops: [...] }.");
    requireWrite(c, ...body.ops.flatMap((o) => (o.op === "move" ? [o.path, o.to] : [o.path])));
    const ops: WriteOp[] = [];
    for (const o of body.ops) {
      if (o.op === "attach") {
        ops.push({
          op: "attach",
          path: o.path,
          blob: await describeBlob(c.var.deps.blobs, o.blob, o.media ?? mediaFor(o.path), o.path),
          if_match: o.if_match,
          if_none_match: o.if_none_match,
        });
      } else ops.push(o as WriteOp);
    }
    const res = await c.var.lib.apply(requestContext(c, body.note), ops);
    return c.json(res);
  });

  // ------------------------------------------------------------------ queries

  app.get(`${BASE}/tree`, async (c) =>
    c.json(
      await c.var.lib.tree({
        prefix: c.req.query("prefix"),
        depth: num(c, "depth"),
        at: num(c, "at"),
      }),
    ),
  );

  // The whole library's index in one small answer, for the app's file tree (TEMPRA-19): every
  // file's path, kind, title and sequence, no bodies or other frontmatter.
  app.get(`${BASE}/outline`, async (c) => c.json(await c.var.lib.outline({ at: num(c, "at") })));

  app.get(`${BASE}/pages`, async (c) => {
    if (c.req.query("type") !== undefined) {
      throw new StoreError(
        400,
        "bad_param",
        "`type` is not a filter: pages have no special type. Filter by `tag` or `prefix`.",
      );
    }
    return c.json(
      await c.var.lib.pages({
        tag: c.req.query("tag"),
        status: c.req.query("status"),
        trust: c.req.query("trust"),
        stale: bool(c, "stale"),
        prefix: c.req.query("prefix"),
        at: num(c, "at"),
        limit: num(c, "limit"),
        offset: num(c, "offset"),
        // Hot and cold pages by their reads over 30 days (TEMPRA-220).
        sort: c.req.query("sort") === "reads" ? "reads" : undefined,
        min_reads: num(c, "min_reads"),
        max_reads: num(c, "max_reads"),
      }),
    );
  });

  app.get(`${BASE}/search`, async (c) =>
    c.json(
      await c.var.lib.search(c.req.query("q") ?? "", {
        prefix: c.req.query("prefix"),
        limit: num(c, "limit"),
      }),
    ),
  );

  app.get(`${BASE}/grep`, async (c) =>
    c.json(
      await c.var.lib.grep(c.req.query("pattern") ?? "", {
        regex: bool(c, "regex"),
        prefix: c.req.query("prefix"),
        limit: num(c, "limit"),
        at: num(c, "at"),
      }),
    ),
  );

  app.get(`${BASE}/links/*`, async (c) =>
    c.json(await c.var.lib.links(tail(c, "/links/"), { at: num(c, "at") })),
  );

  // ------------------------------------------------------------------ ledger

  app.get(`${BASE}/events`, async (c) =>
    c.json(
      await c.var.lib.events({
        since: num(c, "since"),
        prefix: c.req.query("prefix"),
        actor: c.req.query("actor"),
        limit: num(c, "limit"),
      }),
    ),
  );

  app.get(`${BASE}/requests`, async (c) =>
    c.json(
      await c.var.lib.requests({
        before: num(c, "before"),
        prefix: c.req.query("prefix"),
        actor: c.req.query("actor"),
        from: c.req.query("from"),
        to: c.req.query("to"),
        limit: num(c, "limit"),
      }),
    ),
  );

  app.get(`${BASE}/requests/:id`, async (c) => c.json(await c.var.lib.request(c.req.param("id"))));

  app.get(`${BASE}/history/*`, async (c) => c.json(await c.var.lib.history(tail(c, "/history/"))));

  app.post(`${BASE}/revert`, async (c) => {
    const body = await json<{ path?: string; to_seq?: number; request_id?: string; note?: string }>(
      c,
    );
    // Revert is one of the owner's recovery tools (TEMPRA-124, tempra-dev:
    // decisions/read-and-comment-only), as restore is: the owner and their agents alone.
    requireOwner(c.var.token.role, "revert changes");
    let target: { path: string; to_seq: number } | { request_id: string };
    if (typeof body.request_id === "string") {
      if (c.var.token.prefix !== null) {
        throw new StoreError(
          403,
          "outside_prefix",
          "Prefix-scoped tokens revert one path at a time.",
        );
      }
      requireWrite(c);
      target = { request_id: body.request_id };
    } else if (typeof body.path === "string" && Number.isInteger(body.to_seq)) {
      requireWrite(c, body.path);
      target = { path: body.path, to_seq: body.to_seq as number };
    } else {
      throw new StoreError(400, "bad_revert", "Send { path, to_seq } or { request_id }.");
    }
    return c.json(await c.var.lib.revert(requestContext(c, body.note), target));
  });

  // ------------------------------------------------------------------ import and export

  app.post(`${BASE}/import`, async (c) => {
    // Import is one of the owner's recovery tools (TEMPRA-124), checked before the body is read.
    requireOwner(c.var.token.role, "import a bundle");
    const strip = num(c, "strip") ?? 0;
    const type = (c.req.header("Content-Type") ?? "").toLowerCase();
    let raw: { path: string; bytes: Uint8Array }[];
    if (type.startsWith("multipart/form-data")) {
      raw = [];
      const form = await c.req.formData();
      for (const [name, value] of form.entries()) {
        if (typeof value === "string") continue;
        raw.push({ path: name, bytes: new Uint8Array(await (value as Blob).arrayBuffer()) });
      }
    } else {
      raw = readTar(await maybeGunzip(new Uint8Array(await c.req.arrayBuffer())));
    }
    const files = await bundleFiles(c.var.deps.blobs, raw, strip);
    requireWrite(c, ...files.map((f) => f.path));
    const source = c.req.query("source") ?? "upload";
    const res = await c.var.lib.import(requestContext(c), files, source);
    return c.json(res);
  });

  // A tar of the library's files; `format=okf` makes it a bundle that conforms to Google's OKF.
  app.get(`${BASE}/export`, async (c) => {
    const format = exportFormat(c.req.query("format"));
    const who = tokenAdmission(c.var.token);
    return exportTar(
      c.var.lib,
      c.var.deps,
      num(c, "at"),
      c.var.token.library.slug,
      { account: who.account, library: who.library },
      format,
    );
  });

  // ------------------------------------------------------------------ tier 2 extras

  app.get(`${BASE}/sources/*`, async (c) =>
    c.json(await c.var.lib.sources(tail(c, "/sources/"), { at: num(c, "at") })),
  );

  app.get(`${BASE}/diff`, async (c) => {
    const path = c.req.query("path");
    if (!path) throw new StoreError(400, "bad_param", "Send `path`.");
    return c.json(await c.var.lib.diff(path, { from: num(c, "from"), to: num(c, "to") }));
  });

  app.get(`${BASE}/stats`, async (c) => c.json(await c.var.lib.stats()));

  // Who has worked in the library: people and each of their agents, from the ledger's records
  // of who acted (TEMPRA-75), named from D1. Agents act for their person ("Claude for @alice").
  app.get(`${BASE}/agents`, async (c) => {
    const rows = await c.var.lib.contributors();
    const accounts = c.var.deps.accounts;
    const agents = new Map(
      (await accounts.agents(rows.flatMap((r) => (r.agent ? [r.agent] : [])))).map((a) => [
        a.id,
        a,
      ]),
    );
    const people = await accounts.people(rows.map((r) => r.person));
    return c.json({
      contributors: rows.map((r) => {
        const a = r.agent ? agents.get(r.agent) : undefined;
        return {
          person: people.get(r.person)?.handle ?? null,
          // The person's name, for their round mark's initials only (TEMPRA-54).
          person_name: people.get(r.person)?.name ?? null,
          agent: r.agent
            ? {
                id: r.agent,
                name: a?.name ?? null,
                platform: a?.platform ?? null,
                client: a?.client ?? null,
              }
            : null,
          actor: r.actor,
          requests: r.requests,
          first_seq: r.first_seq,
          last_seq: r.last_seq,
          last_ts: r.last_ts,
        };
      }),
    });
  });

  // The change feed (tempra-dev: app/live): a WebSocket on which the library's Durable Object
  // pushes every committed event. Authorized and counted once, here, when it opens; a session
  // must open it from this site's own pages. GET /events?since=N is the catch-up.
  app.get(`${BASE}/feed`, async (c) => {
    if (c.req.header("Upgrade")?.toLowerCase() !== "websocket") {
      throw new StoreError(426, "upgrade_required", "Open the feed as a WebSocket.");
    }
    const token = c.var.token;
    if (token.id.startsWith("session:") && !fromThisSite(c.req.raw)) {
      throw new StoreError(403, "cross_origin", "Open the feed from this site's own pages.");
    }
    const feed = c.var.deps.feed;
    if (!feed) throw new StoreError(501, "unavailable", "The change feed is not wired here.");
    const account = token.person || token.library.owner || token.library.id;
    c.var.deps.meter?.({ kind: "feed", account, library: token.library.id });
    return feed(token.library.do_id, c.req.raw, { prefix: c.req.query("prefix") ?? "", account });
  });

  // Counts for the library's home page: pages, attachments, types, open work.
  app.get(`${BASE}/summary`, async (c) => c.json(await c.var.lib.summary()));

  // The daily health summary (TEMPRA-66): open work by kind and the newest unverified changes.
  app.get(`${BASE}/health`, async (c) => c.json(await c.var.lib.health()));

  // Needs you (layout take 3): what only the person asking can do here (replies waiting on
  // them, pages to verify), with the agents' housekeeping (staleness among it) counted.
  app.get(`${BASE}/needs`, async (c) => {
    const t = c.var.token;
    // The person behind the caller, and the human: actor they write with in person.
    const actor = t.actor.startsWith("human:") ? t.actor : t.person ? humanActor(t.person) : null;
    return c.json(
      await c.var.lib.needs(
        { person: t.created_by ?? null, actor },
        { offset: num(c, "offset"), limit: num(c, "limit") },
      ),
    );
  });

  app.get(`${BASE}/work`, async (c) =>
    c.json(
      await c.var.lib.work({
        kind: c.req.query("kind"),
        limit: num(c, "limit"),
        path: c.req.query("path"),
      }),
    ),
  );

  app.post(`${BASE}/verify/*`, async (c) => {
    const path = tail(c, "/verify/");
    requireWrite(c, path);
    return c.json(await c.var.lib.verify(requestContext(c), path));
  });

  // ------------------------------------------------------------------ comments

  // Threads on pages (tempra-dev: app/comments). Every post is one `comment` event.
  app.get(`${BASE}/comments`, async (c) =>
    c.json(
      await c.var.lib.comments({
        path: c.req.query("path"),
        status: c.req.query("status"),
        limit: num(c, "limit"),
        before: num(c, "before"),
      }),
    ),
  );

  // A post with no `path` (or an empty one) opens a thread on the library itself (TEMPRA-222).
  app.post(`${BASE}/comments`, async (c) => {
    const body = await json<{
      path?: string | null;
      body?: string;
      anchor?: { quote?: string; from?: number } | null;
      kind?: string;
    }>(c);
    if (body.path !== undefined && body.path !== null && typeof body.path !== "string") {
      throw new StoreError(400, "bad_request", "A page's `path` is a string.");
    }
    const path = body.path ?? "";
    const kind = threadKind(body.kind);
    requireComment(c, path);
    const anchor = body.anchor
      ? {
          quote: String(body.anchor.quote ?? ""),
          from: typeof body.anchor.from === "number" ? body.anchor.from : undefined,
        }
      : null;
    const res = await postComment(c.var.deps, c.var.token, c.var.lib, requestContext(c), {
      kind: "open",
      path,
      body: String(body.body ?? ""),
      anchor,
      ...(kind ? { thread_kind: kind } : {}),
    });
    return c.json(res, 201);
  });

  app.get(`${BASE}/comments/:thread`, async (c) =>
    c.json(await c.var.lib.thread(c.req.param("thread"))),
  );

  /** Reply (`POST /comments/{thread}`), resolve or reopen, each with an optional body. */
  const act = (kind: "reply" | "resolve" | "reopen") => async (c: C) => {
    const id = c.req.param("thread") ?? "";
    const { path } = await c.var.lib.thread(id);
    requireComment(c, path);
    // The body is optional for resolve and reopen: no JSON at all is fine.
    const sent = (await c.req.text()).trim();
    let raw: { body?: unknown; kind?: unknown } = {};
    try {
      raw = sent ? JSON.parse(sent) : {};
    } catch {
      throw new StoreError(400, "bad_json", "The request body must be JSON.");
    }
    const text = typeof raw.body === "string" ? raw.body : "";
    // A reply may mark the thread a request, or a comment again (TEMPRA-222).
    const threadAs = kind === "reply" ? threadKind(raw.kind) : undefined;
    return c.json(
      await postComment(
        c.var.deps,
        c.var.token,
        c.var.lib,
        requestContext(c),
        kind === "reply"
          ? { kind, thread: id, body: text, ...(threadAs ? { thread_kind: threadAs } : {}) }
          : { kind, thread: id, body: text },
      ),
    );
  };
  app.post(`${BASE}/comments/:thread`, act("reply"));
  app.post(`${BASE}/comments/:thread/resolve`, act("resolve"));
  app.post(`${BASE}/comments/:thread/reopen`, act("reopen"));

  // ------------------------------------------------------------------ members and invitations

  // Sharing (tempra-dev: v2/sharing, TEMPRA-61): who is in the library, and invitations. People
  // only, from the app's pages; managing them is the owner's, leaving is any member's.
  const sessionOnly = (c: C, what: string) => {
    if (!c.var.token.id.startsWith("session:")) {
      throw new StoreError(403, "session_only", `${what} only from the app's pages.`);
    }
  };
  const memberRole = (v: unknown): MemberRole => {
    if (v !== "read" && v !== "write") {
      throw new StoreError(400, "bad_role", "A member's role is read or write.");
    }
    return v;
  };

  app.get(`${BASE}/members`, async (c) => {
    const ref = c.var.token.library;
    const accounts = c.var.deps.accounts;
    const owner = c.var.token.role === "owner";
    const lib = c.var.deps.managed ? await accounts.library(ref.owner, ref.slug) : null;
    return c.json({
      owner: ref.owner,
      role: c.var.token.role,
      members: (await accounts.members(ref.id)).map(({ handle, role, created }) => ({
        handle,
        role,
        created,
      })),
      // The library's managed agents a comment can mention (TEMPRA-222): @tempra when it is on.
      agents: (await managedAgents(c.var.deps, lib?.ownerId).catch(() => [])).map((a) => a.name),
      // Pending invitations are the owner's to see.
      ...(owner ? { invitations: await accounts.libraryInvitations(ref.id) } : {}),
    });
  });

  app.post(`${BASE}/invitations`, async (c) => {
    sessionOnly(c, "Invitations are sent");
    requireOwner(c.var.token.role, "invite people");
    const body = await json<{ to?: string; role?: string }>(c);
    const role = memberRole(body.role);
    const to = String(body.to ?? "").trim();
    if (!to) throw new StoreError(400, "bad_request", "Give a handle or an email address.");
    const accounts = c.var.deps.accounts;
    const ref = c.var.token.library;
    const byEmail = to.includes("@") && !to.startsWith("@");
    const invitee = await accounts.findAccount(byEmail ? { email: to } : { handle: to });
    if (!invitee) {
      // An email is never confirmed or denied as an account: the answer is the same either way.
      if (byEmail) return c.json({ sent: "if_account" }, 202);
      throw new StoreError(
        404,
        "no_account",
        `There is no Tempra account @${to.replace(/^@/, "")}.`,
      );
    }
    const inviter = c.var.token.created_by ?? "";
    const { id: invitation, renewed } = await accounts.invite(ref.id, invitee.id, role, inviter);
    if (!renewed) {
      // The invitation mails at once, below; the inbox keeps it too (TEMPRA-72).
      await c.var.deps.notifications
        ?.add([
          {
            user: invitee.id,
            library: ref.id,
            kind: "invitation",
            place: `${ref.owner}/${ref.slug}`,
            actor: c.var.token.actor,
            by_user: inviter || null,
            excerpt: `${role === "write" ? "Read and write" : "Read and comment"} access`,
          },
        ])
        .catch((e) =>
          console.error(JSON.stringify({ notify_failed: "invitation", error: String(e) })),
        );
      const origin = new URL(c.req.url).origin;
      const who = c.var.token.actor.replace(/^human:/, "@");
      // Queued (TEMPRA-89): sent with retries, once per invitation however often it is redelivered.
      await c.var.deps.outbox
        ?.send({
          key: `invitation:${invitation}`,
          kind: "invitation",
          account: invitee.handle,
          to: invitee.email,
          subject: `${who} invited you to ${ref.owner}/${ref.slug} on Tempra`,
          text: `${who} invited you to the library ${ref.owner}/${ref.slug} with ${role} access${role === "read" ? " (read and comment)" : ""}.\n\nAccept or decline: ${origin}/invitations\n\nThe invitation is open for 14 days. If you did not expect it, ignore this email.\n`,
        })
        .catch((e) =>
          console.error(JSON.stringify({ mail_not_queued: "invitation", error: String(e) })),
        );
    }
    return c.json(
      byEmail ? { sent: "if_account" } : { sent: "invited", handle: invitee.handle },
      202,
    );
  });

  app.delete(`${BASE}/invitations/:id`, async (c) => {
    sessionOnly(c, "Invitations are withdrawn");
    requireOwner(c.var.token.role, "withdraw invitations");
    const ok = await c.var.deps.accounts.revokeInvitation(
      c.req.param("id"),
      c.var.token.library.id,
    );
    if (!ok) throw new StoreError(404, "not_found", "No such pending invitation.");
    return c.body(null, 204);
  });

  /** A member by handle, for changing their role or removing them. */
  const memberNamed = async (c: C) => {
    const accounts = c.var.deps.accounts;
    const person = await accounts.findAccount({ handle: c.req.param("member") ?? "" });
    const role = person ? await accounts.memberRole(c.var.token.library.id, person.id) : null;
    if (!person || !role) throw new StoreError(404, "not_found", "No such member.");
    return person;
  };

  // The library's title and description (TEMPRA-102, take 4's General settings): the owner, from
  // the app; a field given is set (null clears it), one left out stays.
  app.patch(BASE, async (c) => {
    sessionOnly(c, "A library is described");
    requireOwner(c.var.token.role, "change its title or description");
    const b = await json<{ title?: string | null; description?: string | null }>(c);
    const about = await c.var.deps.accounts.describeLibrary(c.var.token.library.id, {
      ...("title" in b ? { title: b.title } : {}),
      ...("description" in b ? { description: b.description } : {}),
    });
    return c.json(about);
  });

  app.put(`${BASE}/members/:member`, async (c) => {
    sessionOnly(c, "Members are managed");
    requireOwner(c.var.token.role, "change members' access");
    const person = await memberNamed(c);
    const role = memberRole((await json<{ role?: string }>(c)).role);
    await c.var.deps.accounts.share(
      c.var.token.library.id,
      person.id,
      role,
      c.var.token.created_by ?? null,
    );
    return c.json({ handle: person.handle, role });
  });

  // The owner removes a member; a member leaves.
  app.delete(`${BASE}/members/:member`, async (c) => {
    sessionOnly(c, "Members are removed");
    const person = await memberNamed(c);
    const leaving = person.id === c.var.token.created_by;
    if (!leaving) requireOwner(c.var.token.role, "remove members");
    await c.var.deps.accounts.unshare(c.var.token.library.id, person.id);
    return c.body(null, 204);
  });

  // ------------------------------------------------------------------ signed downloads

  /** Short-lived download URLs for exports and attachments; the signature is the credential. */
  app.get("/dl/:lib/:token", async (c) => {
    const d = deps(c.env);
    const lib = await d.libraryByDoId(c.req.param("lib"));
    const bad = new StoreError(
      403,
      "bad_download",
      "This download link is invalid or has expired.",
    );
    if (!lib) throw bad;
    const payload = await lib.openDownload(c.req.param("token"));
    if (payload.k === "export") {
      // The link is the credential; the library's owner is whose renders the diagrams count as.
      const ref = await d.accounts.libraryByDoId(c.req.param("lib"));
      return exportTar(
        lib,
        d,
        payload.at,
        payload.name ?? "library",
        { account: ref?.owner ?? c.req.param("lib"), library: ref?.id },
        payload.format ?? "plain",
      );
    }
    const obj = await d.blobs.get(payload.hash);
    if (!obj) throw new StoreError(404, "not_found", "The file's bytes are missing.");
    return c.body(obj.body as ReadableStream, 200, {
      "Content-Type": payload.media ?? "application/octet-stream",
      "Content-Disposition": `attachment; filename="${payload.path.split("/").pop()}"`,
      "Content-Security-Policy": "default-src 'none'; sandbox",
      "X-Content-Type-Options": "nosniff",
    });
  });

  // ------------------------------------------------------------------ signed uploads

  /**
   * Upload URLs answer any origin, without credentials (TEMPRA-200): the upload panel PUTs from a
   * host's sandboxed iframe, and the token in the URL is the only credential; no cookie is read.
   */
  app.use("/ul/*", async (c, next) => {
    if (c.req.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "PUT",
          "Access-Control-Allow-Headers": "Content-Type",
          "Access-Control-Max-Age": "3600",
        },
      });
    }
    await next();
    c.res.headers.set("Access-Control-Allow-Origin", "*");
  });

  /**
   * An upload URL's PUT (TEMPRA-158): the signature is the credential, as for downloads. Never a
   * cookie: a person's upload page posts to its own URL (TEMPRA-196). See receiveUpload. From the
   * upload panel (`?via=chat`, TEMPRA-200) the file is the person's: the one the connection acts
   * for, whose chat the panel is in.
   */
  app.put("/ul/:lib/:token", async (c) => {
    const d = deps(c.env);
    const doId = c.req.param("lib");
    const raw = c.req.param("token");
    const lib = await d.libraryByDoId(doId);
    if (!lib) throw badUpload();
    // What the upload cost its library's object, metered as the agent's (TEMPRA-228).
    let who: Admission | null = null;
    const { value: res, cost } = await withCosts(async () => {
      const grant = await openUploadGrant(lib, raw, doId);
      who = tokenAdmission(grant.token);
      const length = Number(c.req.header("Content-Length") ?? Number.NaN);
      if (length > WORKER_ATTACHMENT_CAP) {
        throw new StoreError(
          413,
          "attachment_too_large",
          `Attachments are capped at ${WORKER_ATTACHMENT_CAP} bytes.`,
        );
      }
      checkMedia(grant.media, c.req.header("Content-Type"));
      const bytes = await readCapped(c.req.raw.body);
      checkLength(bytes, c.req.header("Content-Length"));
      const person = grant.token.person || grant.token.library.owner;
      const done = await receiveUpload(d, lib, raw, grant, {
        bytes,
        type: c.req.header("Content-Type"),
        waitUntil: afterResponse(c),
        ...(c.req.query("via") === "chat" && person ? { supplied_by: person } : {}),
      });
      if ("blob" in done) return c.json(done.blob, 201);
      return writeResponse(c, done.res);
    });
    const payer = who as Admission | null;
    if (payer && cost.calls > 0) {
      const { account, library } = payer;
      d.meter?.({ kind: "cost", account, library, op: "PUT /ul/*", cost });
    }
    return withCostHeader(c.req.raw, res, cost);
  });

  // ------------------------------------------------------------------ libraries and tokens

  /**
   * Management routes are human-only (spec: HTTP API): the signed-in person's session, or a
   * human: bearer token acting for the person who minted it, on that person's own libraries and
   * tokens.
   */
  const human = async (c: C) => {
    const d = deps(c.env);
    const who = await principal(c, d);
    if ("user" in who) {
      return { d, user: { id: who.user.id, handle: who.user.handle }, session: who.user };
    }
    const token = who.token;
    if (!token.actor.startsWith("human:") || !token.created_by) {
      throw new StoreError(403, "human_only", "Library and token management needs a human: token.");
    }
    // The person who minted it, never the library's owner as such: on a shared library they
    // are different people (tempra-dev: v2/sharing).
    const account = await d.accounts.account(token.created_by);
    if (!account) throw new StoreError(401, "no_account", "This token's account no longer exists.");
    return { d, user: { id: account.id, handle: account.handle }, session: null };
  };

  // Who the caller acts as: the signed-in person, or the person a human: token acts for.
  app.get("/api/v1/me", async (c) => {
    const { d, user } = await human(c);
    const account = await d.accounts.account(user.id);
    if (!account) throw new StoreError(401, "no_account", "This account no longer exists.");
    return c.json({
      email: account.email,
      handle: account.handle,
      name: account.name ?? null,
      actor: account.actor,
      theme: account.theme ?? null,
    });
  });

  app.get("/api/v1/libraries", async (c) => {
    const { d, user } = await human(c);
    const refs = await d.accounts.reachable(user.id);
    // `?summary=false`: names and roles from D1 alone, waking no library (TEMPRA-190). The app's
    // frame asks this way on every page; a cold object costs 250 to 600 ms to reach, and the
    // list would otherwise wait on the slowest of them.
    if (bool(c, "summary") === false) {
      return c.json({
        libraries: refs.map(({ id, slug, owner, role, title, description }) => ({
          id,
          owner,
          slug,
          role,
          ...(title ? { title } : {}),
          ...(description ? { description } : {}),
        })),
      });
    }
    // Each library's summary fails on its own (TEMPRA-23): without it the list still names it.
    const libraries = await Promise.all(
      refs.map(async ({ id, slug, owner, do_id, role, title, description, created }) => {
        const row = {
          id,
          owner,
          slug,
          role,
          ...(title ? { title } : {}),
          ...(description ? { description } : {}),
          last_activity: created ?? null,
        };
        let s: Awaited<ReturnType<LibraryClient["summary"]>>;
        try {
          s = await within(SUMMARY_MS, async () => {
            const lib = await d.libraryByDoId(do_id);
            if (!lib) throw new Error("no library object");
            return lib.summary();
          });
        } catch (e) {
          // One library that fails (an error, a restart, too slow) is listed as unavailable,
          // still linked so its pages, Delete among them, stay reachable.
          console.error("library summary", `${owner}/${slug}`, e);
          return { ...row, unavailable: true };
        }
        return {
          ...row,
          last_activity: s.last_activity ?? row.last_activity,
          seq: s.seq,
          pages: s.pages,
          attachments: s.attachments,
          open_work: s.open_work,
          health: s.health,
        };
      }),
    );
    // Newest activity first (TEMPRA-202): the last event, else when it was made; ties keep
    // reachable's order (yours, then shared, by owner and name).
    const at = (l: { last_activity: string | null }) => Date.parse(l.last_activity ?? "") || 0;
    libraries.sort((a, b) => at(b) - at(a));
    return c.json({ libraries });
  });

  app.post("/api/v1/libraries", async (c) => {
    type Body = { slug?: string; starter?: boolean; title?: string; description?: string };
    // An app connection's OAuth access token (TEMPRA-100): the same rules as its agent's
    // create_library over MCP. Our own bearer tokens never contain a colon.
    const oauthToken = /^Bearer\s+([^\s:]+:[^\s:]+:[^\s:]+)$/i.exec(
      c.req.header("Authorization") ?? "",
    )?.[1];
    if (oauthToken) {
      const d = deps(c.env);
      const grant = await connectionGrant(c, oauthToken);
      const account = await d.accounts.account(grant.userId);
      if (!account) throw new StoreError(401, "suspended", "This account is suspended or deleted.");
      await admit(d, { key: `grant:${grant.id}|${grant.actor}`, account: account.handle }, true);
      const body = await c.req.json<Body>().catch(() => ({}) as Body);
      const made = await createLibraryForGrant(d.accounts, grant, {
        slug: body.slug ?? "",
        title: body.title,
        description: body.description,
      });
      const { id, owner, slug } = made.library;
      return c.json({ id, owner, slug, title: made.title, description: made.description }, 201);
    }
    const { d, user, session } = await human(c);
    const body = await c.req.json<Body>().catch(() => ({}) as Body);
    const lib = await d.accounts.createLibrary(body.slug ?? "", user, {
      title: body.title,
      description: body.description,
    });
    // First run (v2 spec: Onboarding): a person's first library may begin with a note.
    if (body.starter && session) {
      const client = await d.libraryByDoId(lib.do_id);
      await client?.apply(
        {
          actor: session.actor,
          request_id: crypto.randomUUID(),
          note: "Starter note",
          by: { person: session.id },
        },
        [{ op: "write", path: STARTER_PATH, content: STARTER }],
      );
    }
    return c.json(
      {
        id: lib.id,
        owner: lib.owner,
        slug: lib.slug,
        title: lib.title,
        description: lib.description,
      },
      201,
    );
  });

  registerAccountApi(app, deps, async (c, d) => {
    const who = await principal(c as C, d);
    if (!("user" in who)) throw new StoreError(403, "session_only", "Sign in to the app.");
    return who.user;
  });

  registerInboxApi(app, deps, async (c, d) => {
    const who = await principal(c as C, d);
    if (!("user" in who)) throw new StoreError(403, "session_only", "Sign in to the app.");
    return who.user;
  });

  // The signed-in person's pending invitations, and their answer (TEMPRA-61).
  const invitee = async (c: C) => {
    const d = deps(c.env);
    const who = await principal(c, d);
    if (!("user" in who)) throw new StoreError(403, "session_only", "Sign in to the app.");
    return { d, user: who.user };
  };

  app.get("/api/v1/invitations", async (c) => {
    const { d, user } = await invitee(c);
    return c.json({ invitations: await d.accounts.invitations(user.id) });
  });

  for (const answer of ["accept", "decline"] as const) {
    app.post(`/api/v1/invitations/:id/${answer}`, async (c) => {
      const { d, user } = await invitee(c);
      const done = await d.accounts.decideInvitation(
        c.req.param("id"),
        user.id,
        answer === "accept",
      );
      if (!done) throw new StoreError(404, "not_found", "No such open invitation for you.");
      await d.notifications
        ?.settle(user.id, "invitation", `${done.owner}/${done.slug}`)
        .catch((e) => console.error(JSON.stringify({ notify_failed: "settle", error: String(e) })));
      return c.json({ ...done, accepted: answer === "accept" });
    });
  }

  app.get("/api/v1/tokens", async (c) => {
    const { d, user } = await human(c);
    return c.json({ tokens: await d.accounts.tokens(user.id) });
  });

  app.post("/api/v1/tokens", async (c) => {
    const { d, user, session } = await human(c);
    const body = await c.req
      .json<{
        library?: string;
        actor?: string;
        scope?: string;
        prefix?: string | null;
        expires?: string | null;
        mcp_tiers?: string;
      }>()
      .catch(() => ({}) as Record<string, undefined>);
    // One of the person's own libraries by slug, or any they reach by id or owner/slug: a
    // member mints on a shared library for their own agents (tempra-dev: v2/sharing).
    const lib = (await d.accounts.reachable(user.id)).find(
      (l) =>
        l.id === body.library ||
        `${l.owner}/${l.slug}` === body.library ||
        (l.role === "owner" && l.slug === body.library),
    );
    if (!lib) throw new StoreError(404, "no_library", `There is no library ${body.library ?? ""}.`);
    // A person signed in to the app may mint a token as themselves (human:); a token may not.
    const fields = checkNewToken(
      {
        actor: body.actor ?? "",
        scope: body.scope ?? "",
        prefix: body.prefix,
        expires: body.expires,
        mcpTiers: body.mcp_tiers,
      },
      session ? session.actor : null,
    );
    if (lib.role === "read" && fields.scope === "write") {
      throw new StoreError(
        403,
        "read_only",
        `You have read access to ${lib.owner}/${lib.slug}: mint a read token (it may still comment).`,
      );
    }
    // A token for an agent names that agent (agents.ts): the person's agent for its app.
    if (!fields.actor.startsWith("human:")) {
      await d.accounts.recordAgent(user.id, tokenAgent(fields.actor));
    }
    const minted = await d.accounts.createToken({
      ...fields,
      libraryId: lib.id,
      createdBy: user.id,
    });
    const library = lib.role === "owner" ? lib.slug : `${lib.owner}/${lib.slug}`;
    return c.json({ id: minted.id, secret: minted.secret, library, ...fields }, 201);
  });

  app.delete("/api/v1/tokens/:id", async (c) => {
    const { d, user } = await human(c);
    await d.accounts.revokeToken(c.req.param("id"), user.id);
    return c.body(null, 204);
  });

  // Point-in-time restore (spec: Backups and recovery), as the UI's Recovery page.
  const recoveryFor = (c: C) => {
    const token = c.var.token;
    if (!token.actor.startsWith("human:")) {
      throw new StoreError(403, "human_only", "Point-in-time restore needs a human: token.");
    }
    const recovery = c.var.deps.recovery;
    requireOwner(token.role, "restore it");
    if (!recovery) throw new StoreError(501, "unavailable", "Restore is not wired here.");
    return { recovery, ref: token.library, token };
  };

  app.get(`${BASE}/restores`, async (c) => {
    const { recovery, ref } = recoveryFor(c);
    const restores = await recovery.list(ref.do_id);
    // Bookmarks stay server-side: undo goes by id.
    return c.json({
      restores: restores.map(({ bookmark: _b, undo_bookmark: _u, ...r }) => r),
    });
  });

  // Nightly exports and running the maintainers now (spec: Backups and recovery), as the app's
  // Import & export page. The owner's, and people only, like restore.
  const peopleOnly = (c: C) => {
    if (!c.var.token.actor.startsWith("human:")) {
      throw new StoreError(403, "human_only", "This needs a human: token, or the app.");
    }
    return c.var.token.library;
  };

  app.get(`${BASE}/exports`, async (c) => {
    const ref = peopleOnly(c);
    requireOwner(c.var.token.role, "see its exports");
    const list = c.var.deps.exports ? await c.var.deps.exports.list(ref.do_id) : [];
    return c.json({
      exports: list.map((e) => ({
        // YYYY-MM-DD, or YYYY-MM-DD-pre-restore-HHMMSSmmm-xxxx before a restore.
        date: e.folder.split("/").at(-2) ?? "",
        seq: typeof e.manifest?.seq === "number" ? e.manifest.seq : null,
        files: typeof e.manifest?.files === "number" ? e.manifest.files : null,
      })),
    });
  });

  app.post(`${BASE}/maintain`, async (c) => {
    const ref = peopleOnly(c);
    requireOwner(c.var.token.role, "run its maintainers");
    if (!c.var.deps.maintain)
      throw new StoreError(501, "unavailable", "Maintenance is not wired here.");
    const res = (await c.var.deps.maintain(ref.do_id)) as { export: { key?: string } };
    return c.json({ export: res.export.key ?? null });
  });

  // Deleting a library: only from the app's pages, typing its name (v2 spec: Accounts).
  app.post(`${BASE}/delete`, async (c) => {
    if (!c.var.token.id.startsWith("session:")) {
      throw new StoreError(403, "session_only", "A library is deleted only from the app's pages.");
    }
    requireOwner(c.var.token.role, "delete it");
    const ref = c.var.token.library;
    const body = await c.req.json<{ confirm?: string }>().catch(() => ({}) as { confirm?: string });
    if (String(body.confirm ?? "").trim() !== ref.slug) {
      throw new StoreError(400, "not_confirmed", `Type ${ref.slug} to confirm.`);
    }
    const user = await c.var.deps.accounts.account(c.var.token.created_by ?? "");
    if (!user) throw new StoreError(401, "no_account", "This account no longer exists.");
    await deleteLibrary(c.var.deps, c.env.OAUTH_PROVIDER, user, ref);
    return c.body(null, 204);
  });

  app.post(`${BASE}/restore`, async (c) => {
    const { recovery, ref, token } = recoveryFor(c);
    const body = await c.req
      .json<{ to?: string; undo?: string }>()
      .catch(() => ({}) as { to?: string; undo?: string });
    if (!body.to === !body.undo) {
      throw new StoreError(
        400,
        "bad_request",
        "Send { to: <ISO 8601 time> } or { undo: <restore id> }.",
      );
    }
    const outcome = await recovery.restore(
      ref.do_id,
      body.undo ? { undo: body.undo } : { to: body.to as string },
      token.actor,
    );
    if (!outcome.ok) throw new StoreError(outcome.status, outcome.code, outcome.message);
    const { bookmark: _b, undo_bookmark: _u, ...record } = outcome.record;
    return c.json(record, 201);
  });

  // ------------------------------------------------------------------ MCP

  // ------------------------------------------------------------------ apps (OAuth consent)

  // /mcp itself is served by the OAuth provider (worker.ts), which checks tokens first.
  registerLegalRoutes(app, deps);
  registerSignInRoutes(app, deps);
  registerWaitlistRoutes(app, deps);
  registerAppRoutes(app, deps);
  registerUiRoutes(app, deps, { open: openUploadGrant, receive: receiveUpload });

  return app;
}

/**
 * A file described in JSON, as the app draws it: a page with its tree and its images' sizes, a
 * synthesized file as a tree, an attachment's facts (never its bytes).
 */
async function fileJson(lib: LibraryClient, blobs: BlobStore, view: FileView) {
  if (view.kind === "attachment") {
    // A description, not the bytes: what the app shows on an attachment's page.
    const v = await withDimensions(lib, blobs, view);
    const { kind, path, seq, hash, size, media, width, height, source, description } = v;
    return {
      kind,
      path,
      seq,
      hash,
      size,
      media: media ?? null,
      width: width ?? null,
      height: height ?? null,
      // Where the bytes were fetched from, and what the file shows (TEMPRA-157, TEMPRA-170).
      source: source ?? null,
      description: description ?? null,
      credit: v.credit ?? null,
      licence: v.licence ?? null,
      // Who sent the bytes from the upload link, for the agent's write (TEMPRA-196).
      supplied_by: v.supplied_by ?? null,
      // Who had the file for an upload: the person, or the agent that made it (TEMPRA-205).
      origin: v.origin ?? null,
      // What it was made from on the server (TEMPRA-208).
      made_from: v.made_from ?? null,
      // A video's poster beside it, and for a poster its video (TEMPRA-182).
      poster: v.poster ?? null,
      poster_for: v.poster_for ?? null,
    };
  }
  if (view.kind === "derived") {
    // The app draws it like a page body: as a tree.
    const doc = parseMarkdown(splitFrontmatter(view.markdown).body);
    return { kind: view.kind, path: view.path, seq: view.seq, doc };
  }
  const { markdown: _, ...rest } = view;
  if (rest.images) rest.images = await imagesWithDimensions(lib, blobs, rest.images);
  return rest;
}

/**
 * Who is calling a REST route: a bearer token when the request sends one, otherwise the
 * signed-in person's session (the app's own pages, TEMPRA-9). A session may change state only
 * from this site's pages: cookies are SameSite=Lax, and writes must also pass fromThisSite.
 */
async function principal(
  c: C,
  d: Deps,
  /** A library route's {owner}/{slug}: a session finds it with its person, in the same query. */
  library?: { owner: string; slug: string },
): Promise<{ token: TokenInfo; found?: undefined } | { user: User; found?: Found }> {
  if (c.req.header("Authorization") !== undefined)
    return { token: await d.authenticate(bearer(c)) };
  const secret = readCookie(c.req.raw, SESSION_COOKIE);
  const access =
    secret && library ? await d.sessions.access(secret, library.owner, library.slug) : null;
  const user = access?.user ?? (secret && !library ? await d.sessions.user(secret) : null);
  if (!user)
    throw new StoreError(401, "no_token", "Send Authorization: Bearer <token>, or sign in.");
  if (c.req.method !== "GET" && c.req.method !== "HEAD" && !fromThisSite(c.req.raw)) {
    throw new StoreError(
      403,
      "cross_origin",
      "Changes must be submitted from this site's own pages.",
    );
  }
  return access ? { user, found: access } : { user };
}

/**
 * The app connection behind an OAuth access token, checked as the provider checks one on /mcp:
 * live (not expired or revoked) and issued for this origin's MCP resource. Only connections
 * approved since account-level access carry a grant; anything else is refused.
 */
async function connectionGrant(c: C, token: string): Promise<AccountGrant> {
  const summary = await c.env.OAUTH_PROVIDER.unwrapToken<GrantProps>(token).catch(() => null);
  const resource = `${new URL(c.req.url).origin}/mcp`;
  if (!summary || summary.audience !== resource) {
    throw new StoreError(401, "invalid_token", "This access token is not valid here.");
  }
  const grant = summary.grant.props?.grant;
  if (grant && grant.userId !== summary.userId) {
    throw new StoreError(401, "invalid_token", "This access token is not valid here.");
  }
  if (!grant) {
    throw new StoreError(
      403,
      "create_not_allowed",
      "This connection reaches one library and cannot create libraries; reconnect the app.",
    );
  }
  return grant;
}

function bearer(c: C): string {
  const m = /^Bearer\s+(\S+)$/i.exec(c.req.header("Authorization") ?? "");
  if (!m?.[1]) throw new StoreError(401, "no_token", "Send Authorization: Bearer <token>.");
  return m[1];
}

/**
 * A conformant bundle as a tar, attachments read from blob storage, with each SVG fence beside its
 * page as SVG, and each Mermaid fence drawn there when a renderer is there (TEMPRA-168).
 */
async function exportTar(
  lib: LibraryClient,
  d: Deps,
  at: number | undefined,
  name: string,
  ctx: RenderContext,
  format: ExportFormat,
) {
  // Streamed: attachments' bytes are piped from blob storage, never all in memory (TEMPRA-83).
  const bundle = await bundleStream(lib, d.blobs, at, {
    // SVG fences are exported without a renderer; Mermaid needs one (TEMPRA-168, TEMPRA-206).
    diagrams: { ...(d.renderDiagram ? { render: d.renderDiagram } : {}), ctx },
    format,
  });
  const suffix = format === "okf" ? "-okf" : "";
  return new Response(bundle.body, {
    headers: {
      "Content-Type": "application/x-tar",
      "Content-Disposition": `attachment; filename="${name}-${bundle.seq}${suffix}.tar"`,
      "X-Seq": String(bundle.seq),
    },
  });
}

const badUpload = () =>
  new StoreError(403, "bad_upload", "This upload link is invalid or has expired.");

/** An upload link's token, checked against the library it names; not spent. */
export async function openUploadGrant(
  lib: LibraryClient,
  raw: string,
  doId: string,
): Promise<UploadGrant> {
  const grant = (await lib.openUpload(raw)) as unknown as UploadGrant;
  if (grant.k !== "upload" || grant.token?.library?.do_id !== doId) throw badUpload();
  return grant;
}

/** An upload link's bytes as they arrived, and from whom when a person sent them. */
export interface UploadArrival {
  bytes: Uint8Array;
  /** The type the request says, checked against the declared one by the caller. */
  type: string | undefined;
  /** The handle of the signed-in person who sent them from the upload page (TEMPRA-196). */
  supplied_by?: string;
  waitUntil?: (p: Promise<unknown>) => void;
}

/**
 * An upload link's bytes, from curl's PUT or a person's upload page (TEMPRA-158, TEMPRA-196):
 * the caller's access checked again, the link spent, the
 * bytes stored (putBlob) and the `attach` applied as the caller that asked, with its note. A
 * blob-first link (REST, no path) stores the bytes and answers with their hash, for `X-Blob` or a
 * batch's attach.
 */
export async function receiveUpload(
  d: Deps,
  lib: LibraryClient,
  raw: string,
  grant: UploadGrant,
  arrival: UploadArrival,
): Promise<{ blob: BlobRef } | { res: WriteResult }> {
  const { bytes, type } = arrival;
  const token = await uploaderNow(d, grant.token);
  await admit(d, tokenAdmission(token), true, !token.id.startsWith("session:"));
  const media = grant.media ?? mediaFor(grant.path ?? "", type);
  // Checked (a broken image is `bad_image`, its type and size from its bytes) and stored
  // before the link is spent, so refused bytes leave it good for a retry; stored bytes nothing
  // references are harmless (content-addressed, swept after 31 days).
  const blob = await putBlob(d.blobs, bytes, media, grant.path ?? undefined);
  await lib.openUpload(raw, { claim: true });
  if (grant.path === null) return { blob };
  const res = await notifying(d, token, d.library(token), arrival.waitUntil).apply(
    { actor: grant.actor, request_id: crypto.randomUUID(), note: grant.note, by: grant.by },
    [
      {
        op: "attach",
        path: grant.path,
        blob,
        if_match: grant.if_match,
        ...checkFacts(grant),
        ...(arrival.supplied_by ? { supplied_by: arrival.supplied_by } : {}),
        ...(grant.origin ? { origin: grant.origin } : {}),
      },
    ],
  );
  return { res };
}

/**
 * The caller behind an upload link, checked again when its bytes arrive: the person it acts for
 * must still have the account and write access to the library (an hour is long enough for a role
 * to change).
 */
async function uploaderNow(d: Deps, t: TokenInfo): Promise<TokenInfo> {
  const ref = await d.accounts.libraryByDoId(t.library.do_id);
  if (!ref) throw new StoreError(403, "bad_upload", "This upload link is invalid or has expired.");
  // Tokens minted before creators were recorded act for the owner.
  if (!t.created_by) return t;
  const gone = new StoreError(
    403,
    "read_only",
    "You no longer have write access to this library; nothing was written.",
  );
  if (!(await d.accounts.account(t.created_by))) throw gone;
  const role =
    t.created_by === ref.ownerId ? "owner" : await d.accounts.memberRole(ref.id, t.created_by);
  if (role !== "owner" && role !== "write") throw gone;
  return { ...t, role };
}

function writeResponse(c: C, res: WriteResult) {
  const r = res.results[res.results.length - 1];
  if (!r) throw new StoreError(500, "internal", "Write returned no result.");
  if (r.hash) c.header("ETag", `"${r.hash}"`);
  c.header("X-Seq", String(r.seq));
  return c.json({
    path: r.path,
    hash: r.hash,
    seq: r.seq,
    request_id: res.request_id,
    lint: r.lint,
    ...(r.notices ? { notices: r.notices } : {}),
    ...(r.normalized ? { normalized: r.normalized } : {}),
    // A directory move: every file it moved.
    ...(res.results.length > 1
      ? {
          files: res.results.map((x) => ({ path: x.path, from: x.from, seq: x.seq, hash: x.hash })),
        }
      : {}),
  });
}
