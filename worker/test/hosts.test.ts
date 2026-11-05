import { describe, expect, test } from "bun:test";
import { aliasMoves, hostRedirect, hostsFrom, linkOrigin, ownHostnames } from "../src/hosts";
import { setup } from "./harness";

// TEMPRA-276 (tempra-dev decisions/the-app-at-tempra-dev.md): the app at tempra.dev, the landing
// page its signed-out home, app.tempra.dev kept as an alias, www redirected.

const HOSTS = hostsFrom({
  APP_ORIGIN: "https://tempra.dev",
  ALIAS_HOSTS: "app.tempra.dev",
  REDIRECT_HOSTS: "www.tempra.dev",
});

const HTML = { Accept: "text/html,application/xhtml+xml" };
const at = (url: string, init: RequestInit = {}) => new Request(url, init);

describe("hosts", () => {
  test("links from an alias or redirect host name the app's own host (TEMPRA-289)", () => {
    expect(linkOrigin("https://app.tempra.dev", HOSTS)).toBe("https://tempra.dev");
    expect(linkOrigin("https://www.tempra.dev", HOSTS)).toBe("https://tempra.dev");
    expect(linkOrigin("https://tempra.dev", HOSTS)).toBe("https://tempra.dev");
    expect(linkOrigin("https://pr-7.tempra.dev", HOSTS)).toBe("https://pr-7.tempra.dev");
    expect(linkOrigin("http://localhost:8787", HOSTS)).toBe("http://localhost:8787");
    expect(linkOrigin("https://app.tempra.dev", null)).toBe("https://app.tempra.dev");
  });

  test("a source_url names none of the deployment's hosts, whichever it came in on", () => {
    expect(ownHostnames("app.tempra.dev", HOSTS)).toEqual([
      "app.tempra.dev",
      "tempra.dev",
      "www.tempra.dev",
    ]);
    expect(ownHostnames("localhost", null)).toEqual(["localhost"]);
  });

  test("read from the bindings, the primary never its own alias", () => {
    expect(HOSTS).toEqual({
      primary: "tempra.dev",
      aliases: new Set(["app.tempra.dev"]),
      redirects: new Set(["www.tempra.dev"]),
    });
    expect(hostsFrom({})).toBeNull();
    expect(
      hostsFrom({
        APP_ORIGIN: "https://tempra.dev",
        ALIAS_HOSTS: " tempra.dev, ",
        REDIRECT_HOSTS: "",
      }),
    ).toEqual({ primary: "tempra.dev", aliases: new Set(), redirects: new Set() });
  });

  test("the primary and unnamed hosts are served as they are", () => {
    expect(
      hostRedirect(at("https://tempra.dev/cl_dixon/lib", { headers: HTML }), HOSTS),
    ).toBeNull();
    expect(hostRedirect(at("https://pr-7.tempra.dev/", { headers: HTML }), HOSTS)).toBeNull();
    expect(hostRedirect(at("http://localhost:8787/", { headers: HTML }), HOSTS)).toBeNull();
    expect(hostRedirect(at("https://app.tempra.dev/", { headers: HTML }), null)).toBeNull();
  });

  test("www goes to the apex for everything, keeping path and query", () => {
    for (const init of [{ headers: HTML }, {}, { method: "POST" }]) {
      const r = hostRedirect(at("https://www.tempra.dev/a/b?x=1", init), HOSTS);
      expect(r?.status).toBe(301);
      expect(r?.headers.get("Location")).toBe("https://tempra.dev/a/b?x=1");
    }
  });

  test("a browser's page load on the alias moves to the same path", () => {
    for (const path of [
      "/",
      "/cl_dixon/tempra-dev/process/workflow.md?panel=history",
      "/agents",
      "/sign-in",
      "/sign-in?next=%2Fcl_dixon",
      "/sign-in/link?t=abc&next=%2F",
      "/cl_dixon/lib/-/ledger.jsonl",
      "/unsubscribe?k=x",
    ]) {
      const r = hostRedirect(at(`https://app.tempra.dev${path}`, { headers: HTML }), HOSTS);
      expect(r?.status).toBe(308);
      expect(r?.headers.get("Location")).toBe(`https://tempra.dev${path}`);
    }
  });

  test("agents, OAuth and everything else stay on the alias", () => {
    const stays = [
      // Existing connections are bound to https://app.tempra.dev/mcp.
      at("https://app.tempra.dev/mcp", { method: "POST" }),
      at("https://app.tempra.dev/mcp", { headers: HTML }),
      at("https://app.tempra.dev/.well-known/oauth-protected-resource/mcp", { headers: HTML }),
      at("https://app.tempra.dev/.well-known/oauth-authorization-server"),
      at("https://app.tempra.dev/register", { method: "POST" }),
      at("https://app.tempra.dev/token", { method: "POST" }),
      // Consent, and the sign-in on its way back to it, keep the session on the flow's host.
      at("https://app.tempra.dev/authorize?client_id=x", { headers: HTML }),
      at("https://app.tempra.dev/sign-in?next=%2Fauthorize%3Fclient_id%3Dx", { headers: HTML }),
      at("https://app.tempra.dev/sign-in/link?t=abc&next=/authorize?x", { headers: HTML }),
      // The API, with a token or with nothing that asks for a page.
      at("https://app.tempra.dev/api/v1/libraries", { headers: { Authorization: "Bearer t" } }),
      at("https://app.tempra.dev/cl_dixon/lib/x.md", {
        headers: { ...HTML, Authorization: "Bearer t" },
      }),
      at("https://app.tempra.dev/api/v1/libraries", { headers: HTML }),
      at("https://app.tempra.dev/ul/abc", { method: "PUT" }),
      at("https://app.tempra.dev/healthz", { headers: HTML }),
      // Signed media links and images in an MCP App's iframe ask for no page.
      at("https://app.tempra.dev/cl_dixon/lib/-/media/abc", { headers: { Accept: "video/*" } }),
      at("https://app.tempra.dev/cl_dixon/lib/x.png", { headers: { Accept: "image/*" } }),
      // Writes are never redirected: one-click unsubscribe, sign-in's form, sign-out.
      at("https://app.tempra.dev/unsubscribe?k=x", { method: "POST" }),
      at("https://app.tempra.dev/sign-in", { method: "POST", headers: HTML }),
      at("https://app.tempra.dev/sign-out", { method: "POST", headers: HTML }),
    ];
    for (const req of stays) {
      expect([req.method, req.url, aliasMoves(req)]).toEqual([req.method, req.url, false]);
      expect(hostRedirect(req, HOSTS)).toBeNull();
    }
  });
});

describe("the landing page is the signed-out home", () => {
  /** A stand-in for the tempra-site Worker: what it was asked for, and a page that says so. */
  function fakeSite() {
    const asked: Request[] = [];
    return {
      asked,
      async fetch(req: Request) {
        asked.push(req);
        return new Response(`site ${new URL(req.url).pathname}`, {
          headers: {
            "Content-Type": "text/html",
            "Content-Security-Policy": "default-src 'none'; style-src 'self'",
          },
        });
      },
    };
  }

  test("signed out, / is the site's page, with no cookie sent and no caching across sign-in", async () => {
    const s = setup();
    const site = fakeSite();
    s.deps.site = site;
    const r = await s.anon.request("/", { headers: { ...HTML, Cookie: "other=1" } });
    expect(r.status).toBe(200);
    expect(await r.text()).toBe("site /");
    expect(r.headers.get("Content-Security-Policy")).toBe("default-src 'none'; style-src 'self'");
    expect(r.headers.get("Cache-Control")).toBe("private, no-cache");
    expect(r.headers.get("Vary")).toContain("Cookie");
    expect(site.asked).toHaveLength(1);
    expect(site.asked[0]?.headers.get("Cookie")).toBeNull();
  });

  test("a session that no longer works gets the landing page too", async () => {
    const s = setup();
    s.deps.site = fakeSite();
    const r = await s.anon.request("/", { headers: { Cookie: "__Host-tempra_session=gone" } });
    expect(await r.text()).toBe("site /");
  });

  test("signed in, / is the app", async () => {
    const s = setup();
    const site = fakeSite();
    s.deps.site = site;
    const r = await s.app.request("/", { headers: HTML });
    expect(r.status).toBe(200);
    expect(await r.text()).toContain('id="tempra-boot"');
    expect(site.asked).toHaveLength(0);
  });

  test("the site's own paths are the site's, signed in or not", async () => {
    const s = setup();
    const site = fakeSite();
    s.deps.site = site;
    for (const path of ["/terms", "/privacy", "/sitemap.xml", "/robots.txt", "/_astro/x.css"]) {
      for (const who of [s.anon, s.app]) {
        const r = await who.request(path);
        expect([path, r.status, await r.text()]).toEqual([path, 200, `site ${path}`]);
      }
    }
    // A library's page is still the app's.
    const lib = await s.app.request("/owner/demo/", { headers: HTML });
    expect(lib.status).toBe(200);
    expect(await lib.text()).toContain('id="tempra-boot"');
  });

  test("without the site (local dev), / goes to sign-in and terms to tempra.dev, as before", async () => {
    const s = setup();
    const r = await s.anon.request("/", { headers: HTML });
    expect(r.status).toBe(302);
    expect(r.headers.get("Location")).toBe("/sign-in?next=%2F");
    const terms = await s.anon.request("/terms");
    expect(terms.status).toBe(301);
    expect(terms.headers.get("Location")).toBe("https://tempra.dev/terms");
    expect((await s.anon.request("/robots.txt")).status).toBe(404);
  });

  test("the alias moves a browser to the host before the app sees it", async () => {
    const s = setup();
    Object.assign(s.env, {
      APP_ORIGIN: "https://tempra.dev",
      ALIAS_HOSTS: "app.tempra.dev",
      REDIRECT_HOSTS: "www.tempra.dev",
    });
    const page = await s.anon.request("https://app.tempra.dev/owner/demo", { headers: HTML });
    expect(page.status).toBe(308);
    expect(page.headers.get("Location")).toBe("https://tempra.dev/owner/demo");
    // The MCP endpoint answers on the alias as it always has (here: a challenge for a token).
    const mcp = await s.anon.request("https://app.tempra.dev/mcp", { method: "POST" });
    expect(mcp.status).toBe(401);
    expect(mcp.headers.get("WWW-Authenticate")).toContain(
      "https://app.tempra.dev/.well-known/oauth-protected-resource/mcp",
    );
  });
});
