import { esc } from "../oauth/pages";

export { esc };

export interface Shell {
  title: string;
  /** Signed-in email, shown in the header. */
  user: string;
  body: string;
}

export function layout(s: Shell): string {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(s.title)}</title></head>
<body>${s.user ? `<header><a href="/app">Libraries</a> | <a href="/app/tokens">Tokens</a> | <a href="/app/grants">Connected apps</a> | <a href="/app/account">${esc(s.user)}</a></header><hr>` : ""}
<main>${s.body}</main></body></html>`;
}

/**
 * Security headers for every UI page: no scripts, no styles, images from here or https. Pages are
 * plain HTML with browser defaults until the design pass (v2 spec: UI rule for Phase A).
 */
export function htmlResponse(body: string, status = 200): Response {
  return new Response(body, {
    status,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Content-Security-Policy":
        "default-src 'none'; img-src 'self' https:; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
      "X-Frame-Options": "DENY",
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "same-origin",
      "Cache-Control": "no-store",
    },
  });
}

export function chip(text: string, tone: "" | "ok" | "warn" | "bad" = "", title?: string) {
  const t = title ? ` title="${esc(title)}"` : "";
  return `<span class="chip${tone ? ` ${tone}` : ""}"${t}>${esc(text)}</span>`;
}

export function trustChip(tier: string | undefined): string {
  if (tier === "human-reviewed")
    return chip("human-reviewed", "ok", "A human verified this version");
  if (tier === "machine-confirmed")
    return chip("machine-confirmed", "", "A process re-checked this version");
  return chip("unverified", "warn", "Nobody has verified this version");
}

/** A compact UTC timestamp: 2026-09-29 18:02. */
export function when(iso: string): string {
  return iso
    .replace("T", " ")
    .replace(/:\d\d(\.\d+)?Z$/, "")
    .replace(/Z$/, "");
}
