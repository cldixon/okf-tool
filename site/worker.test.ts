import { expect, test } from "bun:test";
import worker from "./worker";

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
