import { type Context, Hono } from "hono";
import type { Accounts } from "./accounts";
import type { Authenticate, TokenInfo } from "./auth";
import { type BlobStore, type LibraryClient, mediaFor, putBlob } from "./client";
import { registerAppRoutes } from "./oauth/routes";
import { normalizePath, underPrefix } from "./okf/paths";
import type { JsonObject } from "./okf/types";
import { OkfError } from "./store/errors";
import type { ConceptContent, ImportFile, RequestContext, WriteOp } from "./store/store";
import { registerUiRoutes } from "./ui/routes";
import { maybeGunzip, readTar, writeTar } from "./util/tar";

/** What the app needs from the platform; production wires D1, the DO and R2, tests fakes. */
export interface Deps {
  authenticate: Authenticate;
  /** Users and libraries in D1, for the consent page. */
  accounts: Accounts;
  library(token: TokenInfo): LibraryClient;
  /** The library a signed download URL names, or null when no such library exists. */
  libraryByDoId(doId: string): Promise<LibraryClient | null>;
  blobs: BlobStore;
}

type Env = {
  Bindings: Cloudflare.Env;
  Variables: { token: TokenInfo; lib: LibraryClient; deps: Deps };
};
type C = Context<Env>;

const BASE = "/api/v1/libraries/:lib";

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
  if (!Number.isInteger(n)) throw new OkfError(400, "bad_param", `\`${name}\` must be an integer.`);
  return n;
}

function bool(c: C, name: string): boolean | undefined {
  const v = c.req.query(name);
  if (v === undefined || v === "") return undefined;
  return v === "true" || v === "1";
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
  };
}

function requireWrite(c: C, ...paths: string[]) {
  const t = c.var.token;
  if (t.scope !== "write") throw new OkfError(403, "read_only", "This token is read-only.");
  if (t.prefix === null) return;
  const prefix = t.prefix;
  for (const p of paths) {
    const n = normalizePath(p) ?? "";
    if (!underPrefix(n, prefix)) {
      throw new OkfError(403, "outside_prefix", `This token may only write under ${prefix}/.`);
    }
  }
}

async function json<T>(c: C): Promise<T> {
  try {
    return (await c.req.json()) as T;
  } catch {
    throw new OkfError(400, "bad_json", "The request body must be JSON.");
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
      content: ConceptContent;
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

export function createApp(deps: (env: Cloudflare.Env) => Deps) {
  const app = new Hono<Env>();

  app.onError((err, c) => {
    if (err instanceof OkfError) {
      return c.json(err.toJSON(), err.status as 400);
    }
    console.error(err);
    return c.json({ error: "Internal error.", code: "internal" }, 500);
  });

  app.notFound((c) => c.json({ error: "No such route.", code: "no_route" }, 404));

  app.get("/healthz", (c) => c.json({ ok: true }));

  app.use(`${BASE}/*`, async (c, next) => {
    const d = deps(c.env);
    const token = await d.authenticate(bearer(c));
    const lib = c.req.param("lib");
    if (lib !== token.library.slug && lib !== token.library.id) {
      throw new OkfError(403, "wrong_library", "This token is for a different library.");
    }
    c.set("deps", d);
    c.set("token", token);
    c.set("lib", d.library(token));
    await next();
  });

  // ------------------------------------------------------------------ files

  app.get(`${BASE}/files/*`, async (c) => {
    const path = tail(c, "/files/");
    const view = await c.var.lib.read(path, { at: num(c, "at"), computed: bool(c, "computed") });
    c.header("X-Seq", String(view.seq));
    if (view.kind === "attachment") {
      c.header("ETag", `"${view.hash}"`);
      c.header("Content-Type", view.media ?? "application/octet-stream");
      c.header("Content-Length", String(view.size));
      c.header("Content-Disposition", `attachment; filename="${view.path.split("/").pop()}"`);
      c.header("Content-Security-Policy", "default-src 'none'; sandbox");
      c.header("X-Content-Type-Options", "nosniff");
      if (c.req.method === "HEAD") return c.body(null);
      const obj = await c.var.deps.blobs.get(view.hash);
      if (!obj) throw new OkfError(500, "blob_missing", `Bytes for ${view.path} are missing.`);
      return c.body(obj.body as ReadableStream);
    }
    const wantsJson = (c.req.header("Accept") ?? "").includes("application/json");
    if (view.kind === "derived") {
      if (wantsJson) return c.json({ path: view.path, seq: view.seq, markdown: view.markdown });
      return c.body(view.markdown, 200, { "Content-Type": "text/markdown; charset=utf-8" });
    }
    c.header("ETag", `"${view.hash}"`);
    if (wantsJson) {
      const { markdown: _, ...rest } = view;
      return c.json(rest);
    }
    return c.body(view.markdown, 200, { "Content-Type": "text/markdown; charset=utf-8" });
  });

  app.put(`${BASE}/files/*`, async (c) => {
    const path = tail(c, "/files/");
    requireWrite(c, path);
    const ifMatch = etag(c.req.header("If-Match"));
    const ifNoneMatch = c.req.header("If-None-Match")?.trim() === "*";
    let op: WriteOp;
    const xblob = c.req.header("X-Blob");
    if (xblob) {
      const head = await c.var.deps.blobs.head(xblob);
      if (!head) throw new OkfError(400, "blob_missing", `No uploaded bytes for ${xblob}.`);
      op = {
        op: "attach",
        path,
        blob: { hash: xblob, size: head.size, media: mediaFor(path, c.req.header("Content-Type")) },
        if_match: ifMatch,
        if_none_match: ifNoneMatch,
      };
    } else if (isMarkdownRequest(c, path)) {
      const type = (c.req.header("Content-Type") ?? "").toLowerCase();
      const content: ConceptContent = type.startsWith("application/json")
        ? await json<{ frontmatter: JsonObject; body: string }>(c)
        : await c.req.text();
      op = { op: "write", path, content, if_match: ifMatch, if_none_match: ifNoneMatch };
    } else {
      const bytes = new Uint8Array(await c.req.arrayBuffer());
      const blob = await putBlob(
        c.var.deps.blobs,
        bytes,
        mediaFor(path, c.req.header("Content-Type")),
      );
      op = { op: "attach", path, blob, if_match: ifMatch, if_none_match: ifNoneMatch };
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
    if (!path.endsWith("/move"))
      throw new OkfError(404, "no_route", "POST /files/{path}/move only.");
    const from = path.slice(0, -"/move".length);
    const body = await json<{ to: string; note?: string }>(c);
    if (typeof body.to !== "string") throw new OkfError(400, "bad_move", "Send { to }.");
    requireWrite(c, from, body.to);
    const res = await c.var.lib.apply(requestContext(c, body.note), [
      { op: "move", path: from, to: body.to },
    ]);
    return writeResponse(c, res);
  });

  app.post(`${BASE}/batch`, async (c) => {
    const body = await json<{ ops: WireOp[]; note?: string }>(c);
    if (!Array.isArray(body.ops)) throw new OkfError(400, "bad_batch", "Send { ops: [...] }.");
    requireWrite(c, ...body.ops.flatMap((o) => (o.op === "move" ? [o.path, o.to] : [o.path])));
    const ops: WriteOp[] = [];
    for (const o of body.ops) {
      if (o.op === "attach") {
        const head = await c.var.deps.blobs.head(o.blob);
        if (!head) throw new OkfError(400, "blob_missing", `No uploaded bytes for ${o.blob}.`);
        ops.push({
          op: "attach",
          path: o.path,
          blob: { hash: o.blob, size: head.size, media: o.media ?? mediaFor(o.path) },
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

  app.get(`${BASE}/concepts`, async (c) =>
    c.json(
      await c.var.lib.concepts({
        type: c.req.query("type"),
        tag: c.req.query("tag"),
        status: c.req.query("status"),
        trust: c.req.query("trust"),
        stale: bool(c, "stale"),
        prefix: c.req.query("prefix"),
        at: num(c, "at"),
        limit: num(c, "limit"),
        offset: num(c, "offset"),
      }),
    ),
  );

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
    let target: { path: string; to_seq: number } | { request_id: string };
    if (typeof body.request_id === "string") {
      if (c.var.token.prefix !== null) {
        throw new OkfError(
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
      throw new OkfError(400, "bad_revert", "Send { path, to_seq } or { request_id }.");
    }
    return c.json(await c.var.lib.revert(requestContext(c, body.note), target));
  });

  // ------------------------------------------------------------------ import and export

  app.post(`${BASE}/import`, async (c) => {
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
    const files: ImportFile[] = [];
    for (const f of raw) {
      const path = normalizePath(f.path.split("/").slice(strip).join("/"));
      if (!path || path.split("/").some((s) => s.startsWith("."))) continue; // .git, .obsidian, ...
      if (path.endsWith(".md")) files.push({ path, markdown: new TextDecoder().decode(f.bytes) });
      else files.push({ path, blob: await putBlob(c.var.deps.blobs, f.bytes, mediaFor(path)) });
    }
    if (files.length === 0) throw new OkfError(400, "empty_import", "No files found to import.");
    requireWrite(c, ...files.map((f) => f.path));
    const source = c.req.query("source") ?? "upload";
    const res = await c.var.lib.import(requestContext(c), files, source);
    return c.json(res);
  });

  app.get(`${BASE}/export`, async (c) => {
    const format = c.req.query("format") ?? "tar";
    if (format !== "tar") throw new OkfError(400, "bad_format", "Only format=tar is supported.");
    return exportTar(c.var.lib, c.var.deps.blobs, num(c, "at"), c.var.token.library.slug);
  });

  // ------------------------------------------------------------------ tier 2 extras

  app.get(`${BASE}/sources/*`, async (c) =>
    c.json(await c.var.lib.sources(tail(c, "/sources/"), { at: num(c, "at") })),
  );

  app.get(`${BASE}/diff`, async (c) => {
    const path = c.req.query("path");
    if (!path) throw new OkfError(400, "bad_param", "Send `path`.");
    return c.json(await c.var.lib.diff(path, { from: num(c, "from"), to: num(c, "to") }));
  });

  app.get(`${BASE}/work`, async (c) =>
    c.json(await c.var.lib.work({ kind: c.req.query("kind"), limit: num(c, "limit") })),
  );

  app.post(`${BASE}/verify/*`, async (c) => {
    const path = tail(c, "/verify/");
    requireWrite(c, path);
    return c.json(await c.var.lib.verify(requestContext(c), path));
  });

  // ------------------------------------------------------------------ signed downloads

  /** Short-lived download URLs for exports and attachments; the signature is the credential. */
  app.get("/dl/:lib/:token", async (c) => {
    const d = deps(c.env);
    const lib = await d.libraryByDoId(c.req.param("lib"));
    const bad = new OkfError(403, "bad_download", "This download link is invalid or has expired.");
    if (!lib) throw bad;
    const payload = await lib.openDownload(c.req.param("token"));
    if (payload.k === "export") return exportTar(lib, d.blobs, payload.at, "library");
    const obj = await d.blobs.get(payload.hash);
    if (!obj) throw new OkfError(404, "not_found", "The file's bytes are missing.");
    return c.body(obj.body as ReadableStream, 200, {
      "Content-Type": payload.media ?? "application/octet-stream",
      "Content-Disposition": `attachment; filename="${payload.path.split("/").pop()}"`,
      "Content-Security-Policy": "default-src 'none'; sandbox",
      "X-Content-Type-Options": "nosniff",
    });
  });

  // ------------------------------------------------------------------ MCP

  // ------------------------------------------------------------------ apps (OAuth consent)

  // /mcp itself is served by the OAuth provider (worker.ts), which checks tokens first.
  registerAppRoutes(app, { accounts: (env) => deps(env).accounts });
  registerUiRoutes(app, deps);

  return app;
}

function bearer(c: C): string {
  const m = /^Bearer\s+(\S+)$/i.exec(c.req.header("Authorization") ?? "");
  if (!m?.[1]) throw new OkfError(401, "no_token", "Send Authorization: Bearer <token>.");
  return m[1];
}

/** A conformant bundle as a tar, attachments read from blob storage. */
async function exportTar(
  lib: LibraryClient,
  blobs: BlobStore,
  at: number | undefined,
  name: string,
) {
  const bundle = await lib.exportBundle(at);
  const enc = new TextEncoder();
  const files = [];
  for (const f of bundle.files) {
    if (f.text !== undefined) files.push({ path: f.path, bytes: enc.encode(f.text) });
    else if (f.blob) {
      const obj = await blobs.get(f.blob.hash);
      if (!obj) throw new OkfError(500, "blob_missing", `Bytes for ${f.path} are missing.`);
      const bytes =
        obj.body instanceof Uint8Array
          ? obj.body
          : new Uint8Array(await new Response(obj.body).arrayBuffer());
      files.push({ path: f.path, bytes });
    }
  }
  return new Response(writeTar(files) as unknown as ArrayBuffer, {
    headers: {
      "Content-Type": "application/x-tar",
      "Content-Disposition": `attachment; filename="${name}-${bundle.seq}.tar"`,
      "X-Seq": String(bundle.seq),
    },
  });
}

function writeResponse(
  c: C,
  res: {
    request_id: string;
    results: { path: string; hash: string | null; seq: number; lint: unknown[] }[];
  },
) {
  const r = res.results[res.results.length - 1];
  if (!r) throw new OkfError(500, "internal", "Write returned no result.");
  if (r.hash) c.header("ETag", `"${r.hash}"`);
  c.header("X-Seq", String(r.seq));
  return c.json({
    path: r.path,
    hash: r.hash,
    seq: r.seq,
    request_id: res.request_id,
    lint: r.lint,
  });
}
