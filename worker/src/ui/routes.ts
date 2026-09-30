import type { Context, Hono } from "hono";
import type { LibraryRef, User } from "../accounts";
import type { Deps } from "../app";
import type { LibraryClient } from "../client";
import { signedIn } from "../oauth/routes";
import { basename, dirname } from "../okf/paths";
import { OkfError } from "../store/errors";
import { esc, htmlResponse, layout } from "./layout";
import { linkTarget } from "./markdown";
import {
  attachmentPage,
  conceptPage,
  derivedPage,
  directoryPage,
  type LibrarySummary,
  libraryList,
  type TreeEntry,
  Urls,
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

/** Wraps a page handler: Access sign-in first, and OKF errors as HTML pages. */
function ui(deps: (env: Cloudflare.Env) => Deps, handler: (p: Page) => Promise<Response>) {
  return async (c: C) => {
    const d = deps(c.env);
    const user = await signedIn(c.req.raw, c.env, d.accounts);
    if (user instanceof Response) return user;
    try {
      return await handler({ c, user, deps: d });
    } catch (e) {
      if (e instanceof OkfError) return errorPage(user, e.status, e.message);
      throw e;
    }
  };
}

async function openLibrary(p: Page): Promise<{ urls: Urls; lib: LibraryClient; ref: LibraryRef }> {
  const slug = p.c.req.param("lib") ?? "";
  const ref = (await p.deps.accounts.libraries()).find((l) => l.slug === slug);
  const lib = ref ? await p.deps.libraryByDoId(ref.do_id) : null;
  if (!ref || !lib) throw new OkfError(404, "no_library", `There is no library named ${slug}.`);
  return { urls: new Urls(ref.slug, atParam(p.c)), lib, ref };
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
 * attachments, raw sources, all behind Cloudflare Access and all accepting ?at=N.
 */
export function registerUiRoutes<E extends AppEnv>(
  app: Hono<E>,
  deps: (env: Cloudflare.Env) => Deps,
) {
  const get = (path: string, handler: (p: Page) => Promise<Response>) =>
    app.get(path, ui(deps, handler) as never);

  get("/app", async (p) => {
    const refs = await p.deps.accounts.libraries();
    const libs = await Promise.all(
      refs.map(async (ref): Promise<LibrarySummary | null> => {
        const lib = await p.deps.libraryByDoId(ref.do_id);
        return lib ? { slug: ref.slug, ...(await lib.summary()) } : null;
      }),
    );
    return show(p, "Libraries", libraryList(libs.filter((l): l is LibrarySummary => l !== null)));
  });
  app.get("/app/", (c) => c.redirect("/app", 301));
  app.get("/app/libraries", (c) => c.redirect("/app", 301));
  app.get("/app/libraries/:lib", (c) =>
    c.redirect(`/app/libraries/${encodeURIComponent(c.req.param("lib"))}/`, 301),
  );

  const directory = async (p: Page, dir: string) => {
    const { urls, lib } = await openLibrary(p);
    const [tree, head] = await Promise.all([
      lib.tree({ prefix: dir, depth: 1, at: urls.at }),
      lib.headSeq(),
    ]);
    const summary =
      dir === "" && urls.at === undefined
        ? { slug: urls.slug, ...(await lib.summary()) }
        : undefined;
    if (dir !== "" && tree.entries.length === 0) {
      throw new OkfError(404, "not_found", `There is no directory ${dir}/ in ${urls.slug}.`);
    }
    const body = directoryPage({
      urls,
      dir,
      head,
      entries: tree.entries as TreeEntry[],
      summary,
    });
    return show(p, dir === "" ? urls.slug : `${dir}/ · ${urls.slug}`, body);
  };

  get("/app/libraries/:lib/", (p) => directory(p, ""));
  get("/app/libraries/:lib/tree/*", (p) => directory(p, tail(p.c, "/tree/")));

  get("/app/libraries/:lib/files/*", async (p) => {
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
  get("/app/libraries/:lib/raw/*", async (p) => {
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
  get("/app/libraries/:lib/download/*", async (p) => {
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
}
