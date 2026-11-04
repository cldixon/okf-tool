import type { Hono } from "hono";

/**
 * The landing page (site/, the `tempra-site` Worker) is the app's signed-out home (TEMPRA-276,
 * tempra-dev `decisions/the-app-at-tempra-dev.md`): the app Worker owns tempra.dev and reaches the
 * site through the SITE service binding, for `/` when nobody is signed in (ui/routes.ts) and for
 * the site's own paths here. Terms and privacy live there (TEMPRA-14). Without the binding (local
 * dev, tests) they redirect to tempra.dev, as they did before.
 */
export const LEGAL = "https://tempra.dev";

/** The SITE service binding: the landing page's Worker. */
export interface SiteService {
  fetch(request: Request): Promise<Response>;
}

/** The site's own paths besides `/`, as its build writes them (site/dist). */
export const SITE_PATHS = ["/terms", "/privacy", "/sitemap.xml", "/robots.txt", "/_astro/*"];

/**
 * A request answered by the site. It gets no cookie or credentials (it has no use for them), and
 * `/` is marked as varying by cookie, so a browser never reuses the landing page once signed in.
 */
export async function fromSite(site: SiteService, req: Request): Promise<Response> {
  const headers = new Headers(req.headers);
  headers.delete("Cookie");
  headers.delete("Authorization");
  const res = await site.fetch(new Request(req.url, { method: req.method, headers }));
  const out = new Response(res.body, res);
  if (new URL(req.url).pathname === "/") {
    out.headers.set("Cache-Control", "private, no-cache");
    out.headers.append("Vary", "Cookie");
  }
  return out;
}

export function registerLegalRoutes<E extends { Bindings: Cloudflare.Env }>(
  app: Hono<E>,
  deps: (env: Cloudflare.Env) => { site?: SiteService | null },
) {
  for (const path of SITE_PATHS) {
    app.get(path, async (c, next) => {
      const site = deps(c.env).site;
      if (site) return fromSite(site, c.req.raw);
      if (path === "/terms" || path === "/privacy") return c.redirect(`${LEGAL}${path}`, 301);
      await next();
    });
  }
}
