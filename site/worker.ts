/**
 * The tempra-site Worker: serves the static build (dist/) through the ASSETS binding, adds
 * security headers, and fills in the landing page's "edited <date>" with the day it is served
 * (TEMPRA-286), so a static build never freezes it. It has no host of its own since TEMPRA-276: the app's
 * Worker owns tempra.dev (and redirects www) and asks this one, through its SITE service binding,
 * for `/` when nobody is signed in and for the site's own paths.
 */
interface Env {
  ASSETS: { fetch(request: Request): Promise<Response> };
}

const HEADERS: Record<string, string> = {
  // No scripts, no third parties: the site is HTML, one stylesheet and its fonts.
  "Content-Security-Policy":
    "default-src 'none'; style-src 'self'; font-src 'self'; img-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "strict-origin-when-cross-origin",
};

const SVG_CSP = "default-src 'none'; style-src 'unsafe-inline'";

/** A day as the app says it (`day` in app/src/ui.ts): "Nov 5", in UTC. */
export function editedDay(now: Date): { iso: string; text: string } {
  return {
    iso: now.toISOString().slice(0, 10),
    text: now.toLocaleDateString("en", { month: "short", day: "numeric", timeZone: "UTC" }),
  };
}

/** Sets every `<time data-edited>` in an HTML page to today: its text and its `datetime`. */
export function fillEdited(response: Response, now: Date): Response {
  const day = editedDay(now);
  const rewritten = new HTMLRewriter()
    .on("time[data-edited]", {
      element(el) {
        el.setAttribute("datetime", day.iso);
        el.setInnerContent(day.text);
      },
    })
    .transform(response);
  const out = new Response(rewritten.body, rewritten);
  // The body changes from day to day, so the build's validators no longer describe it.
  out.headers.delete("ETag");
  out.headers.delete("Last-Modified");
  out.headers.delete("Content-Length");
  out.headers.set("Cache-Control", "no-cache");
  return out;
}

/** The Worker, with a clock the tests can set. */
export function createWorker(clock: () => Date = () => new Date()) {
  return {
    async fetch(request: Request, env: Env): Promise<Response> {
      // A page's body changes with the date, so it is never answered 304 from the build's ETag;
      // the build's hashed files under /_astro/ keep their validators.
      const path = new URL(request.url).pathname;
      let toAssets = request;
      if (!path.startsWith("/_astro/")) {
        toAssets = new Request(request);
        toAssets.headers.delete("If-None-Match");
        toAssets.headers.delete("If-Modified-Since");
      }
      const asset = await env.ASSETS.fetch(toAssets);
      let response = new Response(asset.body, asset);
      if (response.headers.get("Content-Type")?.startsWith("text/html")) {
        response = fillEdited(response, clock());
      }
      for (const [name, value] of Object.entries(HEADERS)) response.headers.set(name, value);
      // The favicon (an SVG from the design package) themes itself with an inline <style>; an SVG
      // is drawn under its own response's CSP, so it gets one that allows that and nothing else.
      if (response.headers.get("Content-Type")?.startsWith("image/svg+xml")) {
        response.headers.set("Content-Security-Policy", SVG_CSP);
      }
      return response;
    },
  };
}

export default createWorker();
