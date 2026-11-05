import { expect, test } from "bun:test";
import worker, { createWorker, editedDay } from "./worker";

const env = {
  ASSETS: {
    fetch: async (request: Request) =>
      new Response(`asset ${new URL(request.url).pathname}`, { headers: { "X-Asset": "1" } }),
  },
};

test("the apex serves assets with security headers", async () => {
  const r = await worker.fetch(new Request("https://tempra.dev/"), env);
  expect(await r.text()).toBe("asset /");
  expect(r.headers.get("X-Asset")).toBe("1");
  expect(r.headers.get("Content-Security-Policy")).toContain("default-src 'none'");
  expect(r.headers.get("X-Content-Type-Options")).toBe("nosniff");
});

test("every page is dark, whatever the system (TEMPRA-285)", async () => {
  // Base.astro is every page's layout; the tokens' light-dark() follow the root's data-theme.
  const layout = await Bun.file(new URL("./src/layouts/Base.astro", import.meta.url)).text();
  expect(layout).toContain('<html lang="en" data-theme="dark">');
});

test("an SVG may style itself inline, and nothing more", async () => {
  const svgEnv = {
    ASSETS: {
      fetch: async () => new Response("<svg/>", { headers: { "Content-Type": "image/svg+xml" } }),
    },
  };
  const r = await worker.fetch(new Request("https://tempra.dev/_astro/favicon.svg"), svgEnv);
  expect(r.headers.get("Content-Security-Policy")).toBe(
    "default-src 'none'; style-src 'unsafe-inline'",
  );
});

test("the landing page's byline says the day it is served, in the app's words (TEMPRA-286)", async () => {
  const page =
    '<p>Tempra · edited <time data-edited datetime="2026-01-01">Jan 1</time></p><time>kept</time>';
  const htmlEnv = {
    ASSETS: {
      fetch: async () =>
        new Response(page, { headers: { "Content-Type": "text/html", ETag: '"build"' } }),
    },
  };
  const dated = createWorker(() => new Date("2026-11-05T09:00:00Z"));
  const r = await dated.fetch(new Request("https://tempra.dev/"), htmlEnv);
  const text = await r.text();
  expect(text).toContain('<time data-edited datetime="2026-11-05">Nov 5</time>');
  expect(text).toContain("<time>kept</time>");
  expect(r.headers.get("ETag")).toBeNull();
  expect(r.headers.get("Cache-Control")).toBe("no-cache");
  expect(r.headers.get("Content-Security-Policy")).toContain("default-src 'none'");
  expect(editedDay(new Date("2026-12-31T23:59:00Z")).text).toBe("Dec 31");
});

test("a page is never answered 304 from the build's ETag; hashed files keep theirs", async () => {
  const seen: (string | null)[] = [];
  const spyEnv = {
    ASSETS: {
      fetch: async (request: Request) => {
        seen.push(request.headers.get("If-None-Match"));
        return new Response("x");
      },
    },
  };
  const headers = { "If-None-Match": '"build"' };
  await worker.fetch(new Request("https://tempra.dev/", { headers }), spyEnv);
  await worker.fetch(new Request("https://tempra.dev/_astro/Base.x.css", { headers }), spyEnv);
  expect(seen).toEqual([null, '"build"']);
});

test("the landing page is a doc with one way in, Sign in, and the MCP URL", async () => {
  const page = await Bun.file(new URL("./src/pages/index.astro", import.meta.url)).text();
  const layout = await Bun.file(new URL("./src/layouts/Base.astro", import.meta.url)).text();
  expect(page).toContain("Docs for agents, for humans.");
  expect(page).toContain("<time data-edited");
  expect(page).toContain("https://tempra.dev/mcp");
  expect(page).not.toContain('class="button');
  expect(layout.match(/class="button/g)?.length).toBe(1);
  expect(layout).toContain(">Sign in</a>");
});
