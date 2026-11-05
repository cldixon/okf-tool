import { href } from "@tempra/app";
import { href as designHref } from "@tempra/design";
import { themeOf } from "../accounts";

/** The app's client bundle: a static asset at a content-hashed URL (TEMPRA-174). */
export const appHref = href;

/**
 * The single page every rebuilt UI route answers with (TEMPRA-9): the design stylesheet, the
 * app's bundle and an empty root. Scripts and styles only from this origin; no inline scripts or
 * styles (the reader's popovers get their coordinates through the CSSOM, which CSP leaves alone).
 * The page carries nothing beyond what the app would read through the API: its first page's
 * answers, as a JSON data block (`boot`, TEMPRA-175, boot.ts), which CSP does not run.
 */
export function spaShell(
  request: Request,
  opts: { theme?: string | null; boot?: string } = {},
): Response {
  const url = new URL(request.url);
  // The account's theme on the root (take 4): the tokens' light-dark() values follow it from the
  // first paint. Never chosen is dark (TEMPRA-285); System leaves it off, so the system decides.
  const chosen = themeOf(opts.theme);
  const theme = chosen === "system" ? "" : ` data-theme="${chosen}"`;
  // The change feed's WebSocket, on this host (wss:, or ws: for local http).
  const socket = `${url.protocol === "https:" ? "wss" : "ws"}://${url.host}`;
  const html = `<!doctype html>
<html lang="en"${theme}><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Tempra</title>
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
<link rel="stylesheet" href="${designHref}">
<script type="module" src="${appHref}"></script></head>
<body>${opts.boot ?? ""}<div id="root"></div></body></html>`;
  return new Response(html, {
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Content-Security-Policy": [
        "default-src 'none'",
        "script-src 'self'",
        "style-src 'self'",
        "font-src 'self'",
        "img-src 'self' https:",
        "media-src 'self'",
        `connect-src 'self' ${socket}`,
        "form-action 'self'",
        "frame-ancestors 'none'",
        "base-uri 'none'",
      ].join("; "),
      "X-Frame-Options": "DENY",
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "same-origin",
      "Cache-Control": "no-store",
    },
  });
}
