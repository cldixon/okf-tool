import type { Context, Hono } from "hono";
import { checkNewToken, type LibraryRef, type User } from "../accounts";
import type { Deps } from "../app";
import { bundleFiles, type LibraryClient } from "../client";
import { basename, dirname } from "../okf/paths";
import { signedIn } from "../signin";
import { OkfError } from "../store/errors";
import { authorizeLibrary } from "../tenancy";
import { maybeGunzip, readTar } from "../util/tar";
import { esc, htmlResponse, layout } from "./layout";
import { linkTarget } from "./markdown";
import {
  attachmentPage,
  conceptPage,
  derivedPage,
  diffPage,
  directoryPage,
  type LedgerFilters,
  type LedgerRequest,
  type LibraryStats,
  type LibrarySummary,
  ledgerPage,
  libNav,
  libraryList,
  type NightlyExport,
  type RestoreRow,
  recoveryPage,
  restorePage,
  revertPage,
  type TokenForm,
  type TokenListRow,
  type TreeEntry,
  tokenCreatedPage,
  tokensPage,
  transferPage,
  Urls,
  type WorkItem,
  workPage,
} from "./views";

type AppEnv = { Bindings: Cloudflare.Env };
type C = Context<AppEnv>;

interface Page {
  c: C;
  user: User;
  deps: Deps;
}

/** The part of the request path after `marker`, URL-decoded per segment. */
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
    .join("/")
    .replace(/\/+$/, "");
}

function atParam(c: C): number | undefined {
  const v = c.req.query("at");
  if (v === undefined || v === "") return undefined;
  const n = Number(v);
  if (!Number.isInteger(n) || n < 0) {
    throw new OkfError(400, "bad_param", "`at` must be a sequence number.");
  }
  return n;
}

function intParam(c: C, name: string): number | undefined {
  const v = c.req.query(name);
  if (v === undefined || v === "") return undefined;
  const n = Number(v);
  if (!Number.isInteger(n) || n < 0) {
    throw new OkfError(400, "bad_param", `\`${name}\` must be a sequence number.`);
  }
  return n;
}

/** Session cookies are SameSite=Lax; writes also insist on a same-origin request. */
function requireSameOrigin(c: C) {
  if (c.req.header("Origin") !== new URL(c.req.url).origin) {
    throw new OkfError(
      403,
      "cross_origin",
      "Changes must be submitted from this site's own pages.",
    );
  }
}

/** A write from the UI: attributed to the signed-in human, with the note from the form. */
async function humanContext(p: Page) {
  const form = await p.c.req.formData();
  const note = String(form.get("note") ?? "").trim();
  return { actor: p.user.actor, request_id: crypto.randomUUID(), note: note || null };
}

/** The confirmation shown after a write redirects back to a concept page. */
function doneNotice(done: string | undefined, actor: string): string {
  const text: Record<string, string> = {
    restore: `Restored. The ledger records it as a revert by ${actor}.`,
    verify: `Verified as ${actor}. The trust tier is human-reviewed until the next edit.`,
  };
  const t = done ? text[done] : undefined;
  return t ? `<div class="notice ok">${esc(t)}</div>` : "";
}

function plural(n: number, word: string) {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}

function errorPage(user: User | null, status: number, message: string): Response {
  const title = status === 404 ? "Not found" : "Something went wrong";
  return htmlResponse(
    layout({
      title,
      user: user?.email ?? "",
      body: `<h1>${esc(title)}</h1><p>${esc(message)}</p><p><a href="/app">Back to libraries</a></p>`,
    }),
    status,
  );
}

/** Wraps a page handler: sign-in first, and OKF errors as HTML pages. */
function ui(deps: (env: Cloudflare.Env) => Deps, handler: (p: Page) => Promise<Response>) {
  return async (c: C) => {
    const d = deps(c.env);
    const user = await signedIn(c.req.raw, c.env, d);
    if (user instanceof Response) return user;
    try {
      return await handler({ c, user, deps: d });
    } catch (e) {
      if (e instanceof OkfError) return errorPage(user, e.status, e.message);
      throw e;
    }
  };
}

/** The library at /app/libraries/{owner}/{slug}, if the signed-in person may open it. */
async function openLibrary(p: Page): Promise<{ urls: Urls; lib: LibraryClient; ref: LibraryRef }> {
  const owner = p.c.req.param("owner") ?? "";
  const slug = p.c.req.param("lib") ?? "";
  const ref = await authorizeLibrary(p.deps.accounts, { user: p.user }, owner, slug);
  const lib = await p.deps.libraryByDoId(ref.do_id);
  if (!lib) throw new OkfError(404, "no_library", `There is no library ${owner}/${slug}.`);
  return { urls: new Urls(ref.owner, ref.slug, atParam(p.c)), lib, ref };
}

function show(p: Page, title: string, body: string): Response {
  return htmlResponse(layout({ title, user: p.user.email, body }));
}

/** Maps a link or image in the body of the file at `from` to a UI URL. */
function bodyUrl(urls: Urls, from: string) {
  return (target: string, kind: "link" | "image"): string | null => {
    const t = linkTarget(from, target);
    if (!t) return null;
    if (t.kind !== "internal") return t.href;
    const name = basename(t.path);
    if (t.dir || t.path === "") return urls.tree(t.path) + (t.anchor ?? "");
    if (name === "index.md") return urls.tree(dirname(t.path)) + (t.anchor ?? "");
    return kind === "image" ? urls.download(t.path) : urls.file(t.path, t.anchor);
  };
}

/**
 * The built-in UI's reading pages (spec: Built-in UI): library list, directory and concept views,
 * attachments, raw sources, all for the signed-in owner and all accepting ?at=N.
 */
export function registerUiRoutes<E extends AppEnv>(
  app: Hono<E>,
  deps: (env: Cloudflare.Env) => Deps,
) {
  const get = (path: string, handler: (p: Page) => Promise<Response>) =>
    app.get(path, ui(deps, handler) as never);

  const listLibraries = async (p: Page, error?: string) => {
    const refs = await p.deps.accounts.libraries(p.user.id);
    const libs = await Promise.all(
      refs.map(async (ref): Promise<LibrarySummary | null> => {
        const lib = await p.deps.libraryByDoId(ref.do_id);
        return lib ? { owner: ref.owner, slug: ref.slug, ...(await lib.summary()) } : null;
      }),
    );
    const body = libraryList(
      libs.filter((l): l is LibrarySummary => l !== null),
      error,
    );
    return htmlResponse(
      layout({ title: "Libraries", user: p.user.email, body }),
      error ? 400 : 200,
    );
  };
  get("/app", (p) => listLibraries(p));
  app.get("/app/", (c) => c.redirect("/app", 301));
  app.get("/app/libraries", (c) => c.redirect("/app", 301));
  app.get("/app/libraries/:owner/:lib", (c) =>
    c.redirect(
      `/app/libraries/${encodeURIComponent(c.req.param("owner"))}/${encodeURIComponent(c.req.param("lib"))}/`,
      301,
    ),
  );

  const directory = async (p: Page, dir: string) => {
    const { urls, lib } = await openLibrary(p);
    const [tree, head] = await Promise.all([
      lib.tree({ prefix: dir, depth: 1, at: urls.at }),
      lib.headSeq(),
    ]);
    const atRoot = dir === "" && urls.at === undefined;
    const [summary, ops] = atRoot
      ? await Promise.all([lib.summary(), lib.stats()])
      : [undefined, undefined];
    if (dir !== "" && tree.entries.length === 0) {
      throw new OkfError(404, "not_found", `There is no directory ${dir}/ in ${urls.slug}.`);
    }
    const body =
      libNav(urls, "files") +
      directoryPage({
        urls,
        dir,
        head,
        entries: tree.entries as TreeEntry[],
        summary: summary ? { owner: urls.owner, slug: urls.slug, ...summary } : undefined,
        ops: ops as LibraryStats | undefined,
      });
    return show(p, dir === "" ? urls.slug : `${dir}/ · ${urls.slug}`, body);
  };

  get("/app/libraries/:owner/:lib/", (p) => directory(p, ""));
  get("/app/libraries/:owner/:lib/tree/*", (p) => directory(p, tail(p.c, "/tree/")));

  get("/app/libraries/:owner/:lib/files/*", async (p) => {
    const { urls, lib } = await openLibrary(p);
    const path = tail(p.c, "/files/");
    if (basename(path) === "index.md") return p.c.redirect(urls.tree(dirname(path)));
    const [view, head] = await Promise.all([lib.read(path, { at: urls.at }), lib.headSeq()]);
    if (view.kind === "attachment") {
      return show(
        p,
        `${view.path} · ${urls.slug}`,
        attachmentPage({ urls, head, ...view, media: view.media ?? null }),
      );
    }
    if (view.kind === "derived") {
      return show(
        p,
        `${view.path} · ${urls.slug}`,
        derivedPage({
          urls,
          head,
          path: view.path,
          markdown: view.markdown,
          url: bodyUrl(urls, view.path),
        }),
      );
    }
    const [sources, links, history] = await Promise.all([
      lib.sources(view.path, { at: urls.at }),
      lib.links(view.path, { at: urls.at }),
      lib.history(view.path),
    ]);
    const title = typeof view.frontmatter.title === "string" ? view.frontmatter.title : view.path;
    return show(
      p,
      `${title} · ${urls.slug}`,
      libNav(urls, "files") +
        doneNotice(p.c.req.query("done"), p.user.actor) +
        conceptPage({
          urls,
          head,
          concept: view,
          sources,
          links,
          history: history.events,
          url: bodyUrl(urls, view.path),
        }),
    );
  });

  // The markdown exactly as an export writes it (spec: raw-source view).
  get("/app/libraries/:owner/:lib/raw/*", async (p) => {
    const { urls, lib } = await openLibrary(p);
    const view = await lib.read(tail(p.c, "/raw/"), { at: urls.at });
    if (view.kind === "attachment") return p.c.redirect(urls.download(view.path));
    return new Response(view.markdown, {
      headers: {
        "Content-Type": "text/plain; charset=utf-8",
        "Content-Security-Policy": "default-src 'none'; sandbox",
        "X-Content-Type-Options": "nosniff",
        "Cache-Control": "no-store",
      },
    });
  });

  // Attachment bytes: a redirect to a short-lived signed URL, as the API and MCP hand out.
  get("/app/libraries/:owner/:lib/download/*", async (p) => {
    const { urls, lib, ref } = await openLibrary(p);
    const view = await lib.read(tail(p.c, "/download/"), { at: urls.at });
    if (view.kind !== "attachment") return p.c.redirect(urls.raw(view.path));
    const token = await lib.signDownload({
      k: "file",
      path: view.path,
      hash: view.hash,
      media: view.media ?? null,
    });
    return p.c.redirect(`/dl/${encodeURIComponent(ref.do_id)}/${token}`, 302);
  });

  // ---------------------------------------------------------------- history and the ledger

  get("/app/libraries/:owner/:lib/diff/*", async (p) => {
    const { urls, lib } = await openLibrary(p);
    const path = tail(p.c, "/diff/");
    const [d, head] = await Promise.all([
      lib.diff(path, { from: intParam(p.c, "from"), to: intParam(p.c, "to") }),
      lib.headSeq(),
    ]);
    return show(
      p,
      `Changes to ${d.path} · ${urls.slug}`,
      libNav(urls, "files") +
        diffPage({ urls, head, path: d.path, from: d.from, to: d.to, diff: d.diff }),
    );
  });

  get("/app/libraries/:owner/:lib/ledger", async (p) => {
    const { urls, lib } = await openLibrary(p);
    const q = (k: string) => p.c.req.query(k)?.trim() || undefined;
    const filters: LedgerFilters = {
      prefix: q("prefix"),
      actor: q("actor"),
      from: q("from"),
      to: q("to"),
      before: intParam(p.c, "before"),
    };
    const res = await lib.requests({ ...filters, limit: 30 });
    let notice: string | undefined;
    if (p.c.req.query("done") === "revert") {
      notice = `Reverted: ${plural(Number(p.c.req.query("n") ?? 0), "change")}, recorded as a new request by ${p.user.actor}.`;
    }
    return show(
      p,
      `Ledger · ${urls.slug}`,
      libNav(urls, "ledger") +
        ledgerPage({
          urls,
          filters,
          requests: res.requests as LedgerRequest[],
          next: res.next,
          notice,
        }),
    );
  });

  // Revert a request (spec: The ledger): a confirmation page, then a same-origin POST.
  get("/app/libraries/:owner/:lib/revert/:request", async (p) => {
    const { urls, lib } = await openLibrary(p);
    const request = (await lib.request(p.c.req.param("request") ?? "")) as LedgerRequest;
    const content = request.events.filter((e) => e.op !== "verify" && e.op !== "move").slice(0, 20);
    const diffs = await Promise.all(
      content.map(async (e) => ({
        path: e.path,
        diff: (await lib.diff(e.path, { to: e.seq })).diff,
      })),
    );
    return show(
      p,
      `Revert · ${urls.slug}`,
      libNav(urls, "ledger") + revertPage({ urls, request, diffs, actor: p.user.actor }),
    );
  });

  const post = (path: string, handler: (p: Page) => Promise<Response>) =>
    app.post(
      path,
      ui(deps, async (p) => {
        requireSameOrigin(p.c);
        return handler(p);
      }) as never,
    );

  post("/app/libraries/:owner/:lib/revert/:request", async (p) => {
    const { urls, lib } = await openLibrary(p);
    const ctx = await humanContext(p);
    const res = await lib.revert(ctx, { request_id: p.c.req.param("request") ?? "" });
    return p.c.redirect(`${urls.ledger()}?done=revert&n=${res.results.length}`, 303);
  });

  // Restore one file to an earlier version: the same revert, for a path.
  get("/app/libraries/:owner/:lib/restore/*", async (p) => {
    const { urls, lib } = await openLibrary(p);
    const path = tail(p.c, "/restore/");
    const to = intParam(p.c, "to");
    if (to === undefined) throw new OkfError(400, "bad_param", "`to` is required.");
    const head = await lib.headSeq();
    const d = await lib.diff(path, { from: head, to });
    return show(
      p,
      `Restore ${d.path} · ${urls.slug}`,
      libNav(urls, "files") +
        restorePage({ urls, path: d.path, to, diff: d.diff, actor: p.user.actor }),
    );
  });

  post("/app/libraries/:owner/:lib/restore/*", async (p) => {
    const { urls, lib } = await openLibrary(p);
    const path = tail(p.c, "/restore/");
    const to = intParam(p.c, "to");
    if (to === undefined) throw new OkfError(400, "bad_param", "`to` is required.");
    const ctx = await humanContext(p);
    await lib.revert(ctx, { path, to_seq: to });
    return p.c.redirect(`${urls.pinned(undefined).file(path)}?done=restore`, 303);
  });

  // ---------------------------------------------------------------- slice 3: verify, work, transfer

  post("/app/libraries", async (p) => {
    const slug = String((await p.c.req.formData()).get("slug") ?? "");
    try {
      const lib = await p.deps.accounts.createLibrary(slug, p.user);
      return p.c.redirect(new Urls(lib.owner, lib.slug).tree(""), 303);
    } catch (e) {
      if (e instanceof OkfError && e.status < 500) return listLibraries(p, e.message);
      throw e;
    }
  });

  // Human verification of the current version (spec: OKF conformance, What the service stamps).
  post("/app/libraries/:owner/:lib/verify/*", async (p) => {
    const { urls, lib } = await openLibrary(p);
    const path = tail(p.c, "/verify/");
    const res = await lib.verify(await humanContext(p), path);
    const verified = res.results[0]?.path ?? path;
    return p.c.redirect(`${urls.pinned(undefined).file(verified)}?done=verify`, 303);
  });

  get("/app/libraries/:owner/:lib/work", async (p) => {
    const { urls, lib } = await openLibrary(p);
    const kind = p.c.req.query("kind") || undefined;
    const res = await lib.work({ kind, limit: 200 });
    return show(
      p,
      `Work queue · ${urls.slug}`,
      libNav(urls, "work") +
        workPage({ urls, items: res.items as WorkItem[], total: res.total, kind }),
    );
  });

  const transfer = async (p: Page, status: number, extra: { result?: string; error?: string }) => {
    const { urls, lib, ref } = await openLibrary(p);
    const [head, exports] = await Promise.all([
      lib.headSeq(),
      p.deps.exports ? p.deps.exports.list(ref.do_id) : Promise.resolve([]),
    ]);
    const nightly: NightlyExport[] = exports.map((e) => ({
      date: e.folder.split("/").at(-2) ?? "",
      seq: typeof e.manifest?.seq === "number" ? e.manifest.seq : null,
      files: typeof e.manifest?.files === "number" ? e.manifest.files : null,
    }));
    const body = libNav(urls, "transfer") + transferPage({ urls, head, nightly, ...extra });
    return htmlResponse(
      layout({ title: `Import & export · ${urls.slug}`, user: p.user.email, body }),
      status,
    );
  };

  get("/app/libraries/:owner/:lib/transfer", (p) => transfer(p, 200, {}));

  post("/app/libraries/:owner/:lib/maintain", async (p) => {
    const { ref } = await openLibrary(p);
    if (!p.deps.maintain) throw new OkfError(501, "unavailable", "Maintenance is not wired here.");
    const res = (await p.deps.maintain(ref.do_id)) as { export: { key?: string } };
    return transfer(p, 200, {
      result: res.export.key
        ? `Exported to R2 at <code>${esc(res.export.key)}</code>.`
        : "Nothing changed since the last export, so none was written.",
    });
  });

  // A nightly export's files, streamed from R2 (spec: Backups and recovery).
  get("/app/libraries/:owner/:lib/exports/:date/:file", async (p) => {
    const { ref } = await openLibrary(p);
    const date = p.c.req.param("date") ?? "";
    const file = p.c.req.param("file") ?? "";
    const types: Record<string, string> = {
      "bundle.tar": "application/x-tar",
      "ledger.jsonl": "application/x-ndjson",
      "manifest.json": "application/json",
    };
    const type = types[file];
    const obj =
      type && /^\d{4}-\d{2}-\d{2}(-pre-restore-\d{9}(-[0-9a-f]{4})?)?$/.test(date) && p.deps.exports
        ? await p.deps.exports.get(`exports/${ref.do_id}/${date}/${file}`)
        : null;
    if (!obj || !type) throw new OkfError(404, "not_found", "No such export.");
    return new Response(obj.body as BodyInit, {
      headers: {
        "Content-Type": type,
        "Content-Disposition": `attachment; filename="${ref.slug}-${date}-${file}"`,
        "Content-Security-Policy": "default-src 'none'; sandbox",
        "X-Content-Type-Options": "nosniff",
        "Cache-Control": "no-store",
      },
    });
  });

  // Point-in-time restore (spec: Backups and recovery).
  const recovery = async (
    p: Page,
    status: number,
    extra: { result?: string; error?: string; to?: string },
  ) => {
    const { urls, lib, ref } = await openLibrary(p);
    const [head, recent, restores] = await Promise.all([
      lib.headSeq(),
      lib.requests({ limit: 10 }),
      p.deps.recovery ? p.deps.recovery.list(ref.do_id) : Promise.resolve([]),
    ]);
    const rows: RestoreRow[] = restores.map((r) => ({
      ...r,
      export: r.export.split("/").at(-2) ?? "",
    }));
    const body =
      libNav(urls, "recovery") +
      recoveryPage({
        urls,
        head,
        recent: recent.requests as LedgerRequest[],
        restores: rows,
        ...extra,
      });
    return htmlResponse(
      layout({ title: `Recovery · ${urls.slug}`, user: p.user.email, body }),
      status,
    );
  };

  get("/app/libraries/:owner/:lib/recovery", (p) => recovery(p, 200, {}));

  post("/app/libraries/:owner/:lib/recovery", async (p) => {
    const { urls, ref } = await openLibrary(p);
    if (!p.deps.recovery) throw new OkfError(501, "unavailable", "Restore is not wired here.");
    const form = await p.c.req.formData();
    const undo = String(form.get("undo") ?? "");
    const rawTo = String(form.get("to") ?? "").trim();
    // datetime-local sends no offset (and no seconds when they are zero); the field is UTC.
    const to =
      rawTo && !/(Z|[+-]\d{2}:\d{2})$/.test(rawTo)
        ? `${rawTo}${/T\d{2}:\d{2}$/.test(rawTo) ? ":00" : ""}Z`
        : rawTo;
    if (String(form.get("confirm") ?? "").trim() !== urls.slug) {
      return recovery(p, 400, {
        to: rawTo,
        error: `Type the library's name, ${urls.slug}, to confirm.`,
      });
    }
    const outcome = await p.deps.recovery.restore(
      ref.do_id,
      undo ? { undo } : { to },
      p.user.actor,
    );
    if (!outcome.ok) return recovery(p, outcome.status, { to: rawTo, error: outcome.message });
    const r = outcome.record;
    return recovery(p, 200, {
      result:
        r.kind === "undo"
          ? `Undone: ${esc(urls.slug)} is back to how it was before that restore.`
          : `Restored ${esc(urls.slug)} to ${esc(r.to)}. What was there before is exported to R2 at <code>${esc(r.export)}</code>.`,
    });
  });

  // Export: a redirect to a signed download, like the API's and MCP's export links.
  get("/app/libraries/:owner/:lib/export", async (p) => {
    const { urls, lib, ref } = await openLibrary(p);
    const at = intParam(p.c, "at") ?? (await lib.headSeq());
    const token = await lib.signDownload({ k: "export", at, name: urls.slug });
    return p.c.redirect(`/dl/${encodeURIComponent(ref.do_id)}/${token}`, 302);
  });

  post("/app/libraries/:owner/:lib/import", async (p) => {
    const { lib } = await openLibrary(p);
    const form = await p.c.req.formData();
    const file = form.get("bundle");
    const strip = Number(form.get("strip") ?? 0) || 0;
    const note = String(form.get("note") ?? "").trim();
    if (!file || typeof file === "string") {
      return transfer(p, 400, { error: "Choose a .tar or .tar.gz file to import." });
    }
    let raw: { path: string; bytes: Uint8Array }[];
    try {
      raw = readTar(await maybeGunzip(new Uint8Array(await (file as Blob).arrayBuffer())));
    } catch {
      return transfer(p, 400, { error: "That file is not a readable tar or tar.gz archive." });
    }
    try {
      const files = await bundleFiles(p.deps.blobs, raw, strip);
      const name = (file as File).name || "upload";
      const ctx = {
        actor: p.user.actor,
        request_id: crypto.randomUUID(),
        note: note || `Import ${name}`,
      };
      const res = await lib.import(ctx, files, `upload:${name}`);
      const linted = res.warnings.length;
      return transfer(p, 200, {
        result: `Imported ${esc(plural(res.files, "file"))} from ${esc(name)} as one request (up to seq ${res.seq})${linted ? `; ${esc(plural(linted, "file"))} with lint, see the <a href="work">work queue</a>` : ""}. <a href="ledger">See it in the ledger</a>.`,
      });
    } catch (e) {
      if (e instanceof OkfError && e.status < 500)
        return transfer(p, e.status, { error: e.message });
      throw e;
    }
  });

  // ---------------------------------------------------------------- tokens (spec: Auth, identity and actors)

  const tokens = async (
    p: Page,
    opts: { form?: TokenForm; error?: string; notice?: string } = {},
  ) => {
    const [rows, libs] = await Promise.all([
      p.deps.accounts.tokens(p.user.id),
      p.deps.accounts.libraries(p.user.id),
    ]);
    const body = tokensPage({
      tokens: rows as TokenListRow[],
      libraries: libs.map((l) => l.slug),
      human: p.user.actor,
      form: opts.form ?? {
        library: libs[0]?.slug ?? "",
        actor: "",
        scope: "write",
        prefix: "",
        expires: "",
        tiers: "all",
      },
      error: opts.error,
      notice: opts.notice,
    });
    return htmlResponse(
      layout({ title: "Tokens", user: p.user.email, body }),
      opts.error ? 400 : 200,
    );
  };

  get("/app/tokens", (p) =>
    tokens(p, { notice: p.c.req.query("done") === "revoke" ? "Token revoked." : undefined }),
  );

  post("/app/tokens", async (p) => {
    const f = await p.c.req.formData();
    const s = (k: string) => String(f.get(k) ?? "").trim();
    const form: TokenForm = {
      library: s("library"),
      actor: s("actor"),
      scope: s("scope") === "read" ? "read" : "write",
      prefix: s("prefix"),
      expires: s("expires"),
      tiers: s("tiers") === "files" ? "files" : "all",
    };
    try {
      const lib = (await p.deps.accounts.libraries(p.user.id)).find((l) => l.slug === form.library);
      if (!lib) throw new OkfError(400, "no_library", "Pick a library.");
      const fields = checkNewToken(
        {
          actor: form.actor,
          scope: form.scope,
          prefix: form.prefix,
          expires: form.expires,
          mcpTiers: form.tiers,
        },
        p.user.actor,
      );
      const minted = await p.deps.accounts.createToken({
        ...fields,
        libraryId: lib.id,
        createdBy: p.user.id,
      });
      const body = tokenCreatedPage({
        origin: new URL(p.c.req.url).origin,
        secret: minted.secret,
        actor: fields.actor,
        library: lib.slug,
      });
      return htmlResponse(layout({ title: "Token created", user: p.user.email, body }));
    } catch (e) {
      if (e instanceof OkfError && e.status < 500) return tokens(p, { form, error: e.message });
      throw e;
    }
  });

  post("/app/tokens/:id/revoke", async (p) => {
    await p.deps.accounts.revokeToken(p.c.req.param("id") ?? "", p.user.id);
    return p.c.redirect("/app/tokens?done=revoke", 303);
  });
}
