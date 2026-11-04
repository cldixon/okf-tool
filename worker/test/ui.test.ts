import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import * as app from "@tempra/app";
import * as design from "@tempra/design";
import { API, setup } from "./harness";
import { makePng } from "./images";

/** The Worker's static assets, as the app's build writes them (app/build.ts, TEMPRA-174). */
const PUBLIC = join(import.meta.dir, "..", "node_modules", "@tempra", "app", "dist", "public");

/** A one-paragraph body as the API returns it, for toMatchObject (block IDs aside). */
const says = (text: string) => ({
  doc: {
    type: "root",
    children: [{ type: "paragraph", children: [{ type: "text", value: text }] }],
  },
});

type S = ReturnType<typeof setup>;

async function put(s: S, path: string, content: string, note = "test") {
  const r = await s.req(`/files/${path}`, {
    method: "PUT",
    headers: { "Content-Type": "text/markdown", "X-Note": note },
    body: content,
  });
  expect(r.status).toBeLessThan(300);
  return r;
}

async function page(s: S, path: string) {
  const r = await s.app.request(path);
  return { status: r.status, html: await r.text(), headers: r.headers };
}

const LIB = "/owner/demo";

/** The JSON the app reads, as the signed-in owner (session cookie). */
async function get<T = unknown>(s: S, path: string): Promise<T> {
  const r = await s.app.request(`${API}${path}`, { headers: { Accept: "application/json" } });
  expect(r.status).toBe(200);
  return (await r.json()) as T;
}

describe("the app's pages (TEMPRA-9)", () => {
  test("every rebuilt page is the app's shell, at its old URL", async () => {
    const s = setup();
    await put(s, "notes/a.md", "---\ntype: Note\n---\nA.\n");
    for (const path of [
      "/",
      `${LIB}/`,
      `${LIB}/notes/`,
      `${LIB}/-/tree/notes/`,
      `${LIB}/notes/a.md`,
      `${LIB}/-/files/notes/a.md`,
      `${LIB}/-/ledger?actor=x`,
      `${LIB}/-/diff/notes/a.md?from=0`,
      `${LIB}/-/activity`,
      `${LIB}/-/revert/some-request`,
      `${LIB}/-/restore/notes/a.md?to=1`,
      `${LIB}/-/transfer`,
      `${LIB}/-/recovery`,
      `${LIB}/-/connect`,
      `${LIB}/-/delete`,
      "/welcome",
      "/agents",
      "/account",
    ]) {
      const r = await page(s, path);
      expect(r.status).toBe(200);
      expect(r.html).toContain(`<script type="module" src="${app.href}"></script>`);
      expect(r.html).toContain(`<link rel="stylesheet" href="${design.href}">`);
      expect(r.html).toContain('<div id="root"></div>');
      const csp = r.headers.get("Content-Security-Policy") ?? "";
      expect(csp).toContain("script-src 'self';");
      // Styles from this origin only: no nonce, no inline styles (TEMPRA-99).
      expect(csp).toContain("style-src 'self';");
      expect(csp).not.toContain("nonce");
      expect(csp).toContain("connect-src 'self'");
      expect(csp).toContain("media-src 'self'");
      expect(r.headers.get("Cache-Control")).toBe("no-store");
    }
    // No inline scripts or styles: the one script element without `src` is the boot data, a
    // JSON block that is never run (TEMPRA-175).
    const one = await page(s, "/");
    expect(one.html).not.toMatch(/<script(?![^>]*\b(src=|type="application\/json"))/);
    expect(one.html).not.toMatch(/<style|\sstyle=/);
  });

  test("Needs you's URL lands on the library's home, the Inbox's on the list (TEMPRA-189)", async () => {
    const s = setup();
    const r = await page(s, `${LIB}/-/needs`);
    expect(r.status).toBe(308);
    expect(r.headers.get("Location")).toBe("/owner/demo/");
    const inbox = await page(s, "/inbox?library=owner/demo");
    expect(inbox.status).toBe(302);
    expect(inbox.headers.get("Location")).toBe("/");
    const stranger = await s.stranger("needs@example.com");
    expect((await stranger.app.request(`${LIB}/-/needs`)).status).toBe(404);
  });

  test("For agents' URL lands on the library's home (TEMPRA-144)", async () => {
    const s = setup();
    const r = await page(s, `${LIB}/-/work?kind=stale`);
    expect(r.status).toBe(308);
    expect(r.headers.get("Location")).toBe("/owner/demo/");
    const stranger = await s.stranger("work@example.com");
    expect((await stranger.app.request(`${LIB}/-/work`)).status).toBe(404);
  });

  test("the bundle is a static asset at its hashed path, not served by the Worker (TEMPRA-174)", async () => {
    // Workers static assets serve it before the Worker runs; the Worker has no route for it.
    const entry = readFileSync(join(PUBLIC, app.href));
    expect(entry.byteLength).toBeGreaterThan(1000);
    // The chunks it imports on demand (Pele, for diagrams) sit beside it, by the names it imports.
    const pele = app.chunks.find((n) => n.startsWith("pele-"));
    expect(pele).toBeDefined();
    expect(entry.toString()).toContain(`./${pele}`);
    for (const c of app.chunks) expect(existsSync(join(PUBLIC, "_app", c))).toBe(true);
    // Nothing else: a fresh build leaves no files from an earlier one.
    expect(readdirSync(join(PUBLIC, "_app")).sort()).toEqual(
      [app.href.slice("/_app/".length), ...app.chunks].sort(),
    );
    const s = setup();
    for (const path of [app.href, `/_app/${pele}`, design.href, "/_design/x.woff2"]) {
      const r = await s.anon.request(path);
      expect(r.status).toBe(404);
      expect(((await r.json()) as { code: string }).code).toBe("no_route");
    }
  });

  test("the static assets' headers: hashed files immutable, every file nosniff", () => {
    const headers = readFileSync(join(PUBLIC, "_headers"), "utf8");
    for (const rule of ["/_app/*", "/_design/*"]) {
      const block = headers.split(rule)[1]?.split(/\n\//)[0] ?? "";
      expect(block).toContain("Cache-Control: public, max-age=31536000, immutable");
      expect(block).toContain("X-Content-Type-Options: nosniff");
    }
    expect(readFileSync(join(PUBLIC, "favicon.svg"), "utf8")).toStartWith("<svg");
    // The Tempra mark, for Access's sign-in page (TEMPRA-282), the design package's own.
    expect(readFileSync(join(PUBLIC, "mark.svg"), "utf8")).toBe(
      readFileSync(Bun.resolveSync("@tempra/design/mark.svg", import.meta.dir), "utf8"),
    );
    expect(headers).toContain("/mark.svg\n  Cache-Control: public, max-age=86400");
  });

  test("the Worker's config serves the app's dist/public/ as its assets", async () => {
    const { default: wrangler } = await import("../wrangler.config");
    const dir = (wrangler as { assetsDirectory?: string }).assetsDirectory ?? "";
    expect(realpathSync(join(import.meta.dir, "..", dir))).toBe(realpathSync(PUBLIC));
  });

  test("pages require sign-in, and a library the person cannot open is a 404", async () => {
    const s = setup();
    const r = await s.anon.request(`${LIB}/a.md?at=1`);
    expect(r.status).toBe(302);
    expect(r.headers.get("Location")).toBe(
      `/sign-in?next=${encodeURIComponent(`${LIB}/a.md?at=1`)}`,
    );
    // The actions are the API's: no session, no write.
    const post = await s.anon.request(`${API}/verify/a.md`, {
      method: "POST",
      headers: { Origin: "http://localhost" },
    });
    expect(post.status).toBe(401);
    // The old form posts are gone.
    expect(
      (
        await s.app.request(`${LIB}/-/verify/a.md`, {
          method: "POST",
          headers: { Origin: "http://localhost" },
        })
      ).status,
    ).toBe(404);
    expect((await page(s, "/owner/other/")).status).toBe(404);
    expect((await page(s, "/owner/other/a.md")).status).toBe(404);
    expect((await page(s, "/owner/other/-/work")).status).toBe(404);
    const stranger = await s.stranger();
    for (const path of [`${LIB}/`, `${LIB}/-/delete`, `${LIB}/-/recovery`, `${LIB}/-/revert/x`]) {
      expect((await stranger.app.request(path)).status).toBe(404);
    }
  });

  test("files as JSON describe every kind of file, as the app reads them", async () => {
    const s = setup();
    await put(s, "a.md", "---\ntype: Note\ntitle: A\n---\nFirst words.\n");
    const { hash, seq } = await get<{ hash: string; seq: number }>(s, "/files/a.md");
    await s.req("/files/a.md", {
      method: "PUT",
      headers: { "Content-Type": "text/markdown", "If-Match": `"${hash}"` },
      body: "---\ntype: Note\ntitle: A\n---\nSecond words.\n",
    });
    // A page: frontmatter and the body as a tree, at any sequence.
    expect(await get(s, "/files/a.md")).toMatchObject({
      kind: "page",
      ...says("Second words."),
    });
    expect(await get(s, `/files/a.md?at=${seq}`)).toMatchObject(says("First words."));
    // An attachment: its description, not its bytes.
    const png = makePng(3, 2);
    const up = await s.req("/files/img/logo.png", {
      method: "PUT",
      headers: { "Content-Type": "image/png" },
      body: png,
    });
    expect(up.status).toBeLessThan(300);
    expect(await get(s, "/files/img/logo.png")).toMatchObject({
      kind: "attachment",
      path: "img/logo.png",
      media: "image/png",
      size: png.length,
      width: 3,
      height: 2,
    });
    const bytes = await s.app.request(`${API}/files/img/logo.png`);
    expect(new Uint8Array(await bytes.arrayBuffer())).toEqual(png);
    const dl = await s.app.request(`${LIB}/-/download/img/logo.png`, { redirect: "manual" });
    expect(dl.status).toBe(302);
    // A synthesized file: its markdown.
    expect(await get(s, "/files/log.md")).toMatchObject({ kind: "derived", path: "log.md" });
    // index.md is the directory's page; a missing file is a 404.
    const index = await s.app.request(`${LIB}/img/index.md`, { redirect: "manual" });
    expect(index.headers.get("Location")).toBe(`${LIB}/img/`);
    expect(
      (await s.app.request(`${API}/files/nope.md`, { headers: { Accept: "application/json" } }))
        .status,
    ).toBe(404);
    // The raw source, as an export writes it.
    const raw = await s.app.request(`${LIB}/-/raw/a.md?at=${seq}`);
    expect(raw.headers.get("Content-Type")).toContain("text/plain");
    expect(await raw.text()).toContain("First words.");
  });
});

describe("the design components' catalogue (TEMPRA-252)", () => {
  test("/_dev/design is the app's shell in local dev only, a 404 everywhere else", async () => {
    const s = setup();
    expect((await page(s, "/_dev/design")).status).toBe(404);
    expect((await s.anon.request("/_dev/design")).status).toBe(404);
    Object.assign(s.env, { DEV_SIGNIN: "1" });
    const r = await page(s, "/_dev/design");
    expect(r.status).toBe(200);
    expect(r.html).toContain('<div id="root"></div>');
    expect((await s.app.request("https://app.example.com/_dev/design")).status).toBe(404);
  });
});

describe("Activity's Download (TEMPRA-115)", () => {
  test("the ledger as JSON lines, every event in order, as a download", async () => {
    const s = setup();
    for (let i = 0; i < 3; i++) {
      await put(s, `d${i}.md`, `---\ntype: Note\ntitle: D${i}\n---\nWords ${i}.\n`, `note ${i}`);
    }
    const r = await s.app.request(`${LIB}/-/ledger.jsonl`);
    expect(r.status).toBe(200);
    expect(r.headers.get("Content-Type")).toBe("application/x-ndjson");
    expect(r.headers.get("Content-Disposition")).toContain("attachment");
    const lines = (await r.text()).trimEnd().split("\n");
    const events = lines.map((l) => JSON.parse(l) as { t: string; seq: number; path: string });
    expect(events.every((e) => e.t === "event")).toBe(true);
    const seqs = events.map((e) => e.seq);
    expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
    expect(events.map((e) => e.path)).toEqual(expect.arrayContaining(["d0.md", "d1.md", "d2.md"]));
    // Signed out, it is a sign-in page or a 404, never the ledger.
    const anon = await s.anon.request(`${LIB}/-/ledger.jsonl`, { redirect: "manual" });
    expect(anon.status).not.toBe(200);
  });
});

async function json<T>(r: Response): Promise<T> {
  return (await r.json()) as T;
}

async function hashOf(s: S, path: string) {
  const r = await s.req(`/files/${path}`, { headers: { Accept: "application/json" } });
  return (await json<{ hash: string; seq: number }>(r)).hash;
}

/** A write through the API as the signed-in owner, from this site's pages unless `origin` says. */
async function send(s: S, path: string, body: unknown, origin = "http://localhost") {
  return s.app.request(`${API}${path}`, {
    method: "POST",
    headers: { Origin: origin, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

type Requests = { requests: { request_id: string; actor: string; note: string | null }[] };

describe("history, ledger and revert (Phase 3, slice 2)", () => {
  test("diffs between versions", async () => {
    const s = setup();
    await put(s, "a.md", "---\ntype: Note\n---\nOne.\n", "first");
    await s.req("/files/a.md", {
      method: "PUT",
      headers: { "Content-Type": "text/markdown", "If-Match": `"${await hashOf(s, "a.md")}"` },
      body: "---\ntype: Note\n---\nTwo.\n",
    });
    const d = await get<{ diff: string }>(s, "/diff?path=a.md");
    expect(d.diff).toContain("-One.");
    expect(d.diff).toContain("+Two.");
  });

  test("the ledger lists requests with filters", async () => {
    const s = setup();
    await put(s, "notes/a.md", "---\ntype: Note\n---\nA\n", "add a");
    await put(s, "other/b.md", "---\ntype: Note\n---\nB\n", "add b");
    const notes = async (q: string) =>
      (await get<Requests>(s, `/requests${q}`)).requests.map((r) => r.note);
    expect(await notes("")).toEqual(["add b", "add a"]);
    expect(await notes("?prefix=notes")).toEqual(["add a"]);
    expect(await notes("?actor=someone/else")).toEqual([]);
    const today = new Date().toISOString().slice(0, 10);
    expect(await notes(`?from=${today}&to=${today}`)).toContain("add a");
    expect(await notes("?to=2000-01-01")).toEqual([]);
    expect((await s.app.request(`${API}/requests?from=yesterday`)).status).toBe(400);
  });

  test("revert a request from the ledger, attributed to the signed-in human", async () => {
    const s = setup();
    await put(s, "a.md", "---\ntype: Note\n---\nGood.\n", "good version");
    await s.req("/files/a.md", {
      method: "PUT",
      headers: {
        "Content-Type": "text/markdown",
        "If-Match": `"${await hashOf(s, "a.md")}"`,
        "X-Note": "bad edit",
      },
      body: "---\ntype: Note\n---\nBad.\n",
    });
    const bad = (await get<Requests>(s, "/requests")).requests[0];
    expect(bad?.note).toBe("bad edit");
    // The confirmation page is the app's; it reads the request and its diff from the API.
    expect((await page(s, `${LIB}/-/revert/${bad?.request_id}`)).html).toContain(
      '<div id="root"></div>',
    );
    const ids = (await get<Requests>(s, "/requests")).requests.map((r) => r.request_id);
    expect(ids).toContain(bad?.request_id as string);

    const target = { request_id: bad?.request_id, note: "x" };
    const forged = await send(s, "/revert", target, "https://evil.example");
    expect(forged.status).toBe(403);
    expect(await s.store().read("a.md")).toMatchObject(says("Bad."));

    const done = await send(s, "/revert", {
      request_id: bad?.request_id,
      note: "undo the bad edit",
    });
    expect(done.status).toBe(200);
    expect(s.store().read("a.md")).toMatchObject(says("Good."));
    expect((await get<Requests>(s, "/requests")).requests[0]).toMatchObject({
      actor: "human:owner",
      note: "undo the bad edit",
    });
  });

  test("restore one file to an earlier version", async () => {
    const s = setup();
    await put(s, "a.md", "---\ntype: Note\n---\nFirst.\n");
    const first = (await get<{ seq: number }>(s, "/files/a.md")).seq;
    await s.req("/files/a.md", {
      method: "PUT",
      headers: { "Content-Type": "text/markdown", "If-Match": `"${await hashOf(s, "a.md")}"` },
      body: "---\ntype: Note\n---\nSecond.\n",
    });
    expect((await page(s, `${LIB}/-/restore/a.md?to=${first}`)).status).toBe(200);
    const d = await get<{ diff: string }>(s, `/diff?path=a.md&from=${first}`);
    expect(d.diff).toContain("+Second.");
    const done = await send(s, "/revert", { path: "a.md", to_seq: first, note: "back to first" });
    expect(done.status).toBe(200);
    expect(s.store().read("a.md")).toMatchObject(says("First."));
    expect((await get<Requests>(s, "/requests")).requests[0]).toMatchObject({
      actor: "human:owner",
      note: "back to first",
    });
  });
});

describe("the first page's data in the shell (TEMPRA-175)", () => {
  /** The boot data a shell carries, by URL key. */
  const bootOf = (html: string): Record<string, unknown> => {
    const m = /<script type="application\/json" id="tempra-boot">(.*?)<\/script>/s.exec(html);
    return m ? (JSON.parse(m[1] as string) as Record<string, unknown>) : {};
  };
  const LIB_API = "/api/v1/libraries/owner/demo";

  test("a page's view carries what its first paint asks for, as the API answers it", async () => {
    const s = setup();
    await put(s, "notes/a.md", "---\ntype: Note\ntitle: A\n---\nA, with </script> in it.\n");
    const r = await page(s, `${LIB}/notes/a.md`);
    expect(r.status).toBe(200);
    // Nothing in the data can end the block: `<` is escaped.
    expect(r.html.split("</script>").length).toBe(3);
    const boot = bootOf(r.html);
    for (const url of [
      // The file's page in one call (TEMPRA-191), then its threads.
      `${LIB_API}/page/notes/a.md`,
      `${LIB_API}/comments?limit=200&path=notes%2Fa.md&status=all`,
      `${LIB_API}/outline`,
      `${LIB_API}/agents`,
      "/api/v1/me",
      "/api/v1/libraries?summary=false",
      "/api/v1/inbox/count",
    ]) {
      expect(Object.keys(boot)).toContain(url);
    }
    // Exactly what the app's own call returns.
    expect(boot[`${LIB_API}/page/notes/a.md`]).toEqual(await get(s, "/page/notes/a.md"));
    for (const old of ["files", "sources", "links", "history"]) {
      expect(Object.keys(boot)).not.toContain(`${LIB_API}/${old}/notes/a.md`);
    }
    expect(boot["/api/v1/me"]).toMatchObject({ handle: "owner" });
  });

  test("a version's page asks for that version; an account page only for the frame", async () => {
    const s = setup();
    await put(s, "notes/a.md", "---\ntype: Note\n---\nOne.\n");
    const pinned = bootOf((await page(s, `${LIB}/notes/a.md?at=1`)).html);
    expect(Object.keys(pinned)).toContain(`${LIB_API}/page/notes/a.md?at=1`);
    expect(Object.keys(pinned)).not.toContain(`${LIB_API}/page/notes/a.md`);
    const account = bootOf((await page(s, "/agents")).html);
    expect(Object.keys(account).sort()).toEqual(
      ["/api/v1/inbox/count", "/api/v1/libraries?summary=false", "/api/v1/me"].sort(),
    );
  });

  test("a call that fails is left out, for the app to make and see fail as it always would", async () => {
    const s = setup();
    const boot = bootOf((await page(s, `${LIB}/notes/missing.md`)).html);
    expect(Object.keys(boot)).not.toContain(`${LIB_API}/page/notes/missing.md`);
    expect(Object.keys(boot)).toContain(`${LIB_API}/outline`);
  });
});

describe("the shared design stylesheet", () => {
  test("a static asset at its hashed path, the package's stylesheet as is", () => {
    expect(readFileSync(join(PUBLIC, design.href), "utf8")).toBe(design.css);
  });

  test("its fonts (Inter) are static assets at the hashed paths the stylesheet names", () => {
    const urls = [...design.css.matchAll(/url\("(\/_design\/[^"]+\.woff2)"\)/g)].map((m) => m[1]);
    expect(urls.length).toBe(Object.keys(design.fonts).length);
    for (const url of urls) {
      // A woff2 file starts with its signature.
      const bytes = readFileSync(join(PUBLIC, url as string));
      expect(new TextDecoder().decode(bytes.subarray(0, 4))).toBe("wOF2");
    }
    expect(readdirSync(join(PUBLIC, "_design")).length).toBe(urls.length + 1);
  });
});

describe("errors as pages (V-1)", () => {
  const browser = { headers: { Accept: "text/html,application/xhtml+xml,*/*;q=0.8" } };

  test("an unknown address is a 404 page for a browser, JSON for the API and MCP", async () => {
    const s = setup();
    for (const [client, path] of [
      [s.app, "/typo"],
      [s.anon, "/ann"],
      [s.app, "/nobody/nothing/page"],
    ] as const) {
      const r = await client.request(path, browser);
      expect(r.status).toBe(404);
      expect(r.headers.get("Content-Type")).toContain("text/html");
      expect(r.headers.get("Cache-Control")).toBe("no-store");
      expect(r.headers.get("X-Robots-Tag")).toBe("noindex");
      const html = await r.text();
      expect(html).toContain("<h1>Not found</h1>");
      expect(html).toContain('<a href="/">Go to your libraries</a>');
      // The public pages' flat frame (TEMPRA-126): a skip link to the main content, the
      // wordmark linking to tempra.dev, no sheet, and the foot's links as a list.
      expect(r.headers.get("Content-Security-Policy")).toContain("default-src 'none'");
      expect(html).toContain('<a class="skip-link" href="#main">');
      expect(html).toContain('<main id="main" class="public-main">');
      expect(html).toContain('<a class="wordmark mark-lockup" href="https://tempra.dev/">');
      expect(html).not.toContain("public-sheet");
      expect(html).toContain('<nav aria-label="Footer"><ul role="list">');
    }
    for (const path of ["/api/v1/nope", `${API}/nope`, "/api/nope"]) {
      const r = await s.app.request(path, browser);
      expect(r.status).toBe(404);
      expect(r.headers.get("Content-Type")).toContain("application/json");
    }
    // Without HTML in Accept (scripts, fetch), JSON as before.
    const plain = await s.app.request("/typo");
    expect(plain.status).toBe(404);
    expect(((await plain.json()) as { code: string }).code).toBe("no_route");
  });

  test("an uncaught error is a 500 page for a browser, JSON for the API", async () => {
    const s = setup();
    s.accounts.reachable = () => Promise.reject(new Error("boom"));
    const errors = console.error;
    console.error = () => {};
    try {
      const r = await s.app.request("/", browser);
      expect(r.status).toBe(500);
      expect(r.headers.get("Content-Type")).toContain("text/html");
      const html = await r.text();
      expect(html).toContain("<h1>Something went wrong</h1>");
      expect(html).not.toContain("boom");
      const api = await s.app.request("/api/v1/libraries", browser);
      expect(api.status).toBe(500);
      expect((await api.json()) as object).toEqual({ error: "Internal error.", code: "internal" });
    } finally {
      console.error = errors;
    }
  });
});
