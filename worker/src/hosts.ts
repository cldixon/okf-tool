/**
 * Which host a request came in on, and what that host does with it (TEMPRA-276, tempra-dev
 * `decisions/the-app-at-tempra-dev.md`). The app is at its deployment's host (APP_ORIGIN's,
 * tempra.dev in production). Besides it:
 *
 * - a redirect host (www.tempra.dev) sends everything to the same path on the host, 301;
 * - an alias (app.tempra.dev, the app's former host) sends a browser's page load to the same path
 *   on the host, 308, and serves everything else in place: MCP and OAuth (every existing
 *   connection's resource is `https://app.tempra.dev/mcp`), sign-in on its way back to
 *   `/authorize`, the API, uploads, downloads and signed media links, unsubscribe's POST.
 *
 * Free of Worker APIs.
 */

export interface Hosts {
  /** The app's own host, e.g. tempra.dev. */
  primary: string;
  aliases: ReadonlySet<string>;
  redirects: ReadonlySet<string>;
}

/** The hosts from the Worker's bindings (cloudflare.config.ts); null without APP_ORIGIN. */
export function hostsFrom(env: {
  APP_ORIGIN?: string;
  ALIAS_HOSTS?: string;
  REDIRECT_HOSTS?: string;
}): Hosts | null {
  if (!env.APP_ORIGIN) return null;
  let primary: string;
  try {
    primary = new URL(env.APP_ORIGIN).host;
  } catch {
    return null;
  }
  const list = (s?: string) =>
    new Set(
      (s ?? "")
        .split(",")
        .map((h) => h.trim().toLowerCase())
        .filter((h) => h && h !== primary),
    );
  return { primary, aliases: list(env.ALIAS_HOSTS), redirects: list(env.REDIRECT_HOSTS) };
}

/** Paths an alias keeps serving to browsers too: the OAuth consent an existing client opens. */
const OAUTH_PAGES = /^\/(authorize|\.well-known|token|register|mcp)(\/|$)/;

/** Machine endpoints and static files, which a browser's page load never is (cf. `wantsPage`). */
const MACHINE = /^\/(api|mcp|token|register|dl|ul|_design|_app|healthz)(\/|$)/;

/** Whether an alias sends this request on to the host: a browser loading a page, nothing else. */
export function aliasMoves(req: Request): boolean {
  if (req.method !== "GET" && req.method !== "HEAD") return false;
  if (req.headers.has("Authorization")) return false;
  const url = new URL(req.url);
  const path = url.pathname;
  if (MACHINE.test(path) || OAUTH_PAGES.test(path) || path.startsWith("/.")) return false;
  // Sign-in on its way back to consent stays, so the session lands on the host the OAuth flow
  // is on; any other sign-in moves, and its session is the host's.
  if (path === "/sign-in" || path.startsWith("/sign-in/")) {
    if ((url.searchParams.get("next") ?? "").startsWith("/authorize")) return false;
  }
  return (req.headers.get("Accept") ?? "").includes("text/html");
}

/**
 * The redirect a request gets before the app sees it, or null to serve it here. Hosts not named
 * (localhost, a preview's own host) are served as they are.
 */
export function hostRedirect(req: Request, hosts: Hosts | null): Response | null {
  if (!hosts) return null;
  const url = new URL(req.url);
  const host = url.host.toLowerCase();
  if (host === hosts.primary) return null;
  const moved = hosts.redirects.has(host)
    ? 301
    : hosts.aliases.has(host) && aliasMoves(req)
      ? 308
      : null;
  if (moved === null) return null;
  url.host = hosts.primary;
  url.protocol = "https:";
  return new Response(null, {
    status: moved,
    headers: { Location: url.toString(), "Cache-Control": "no-store" },
  });
}

/**
 * The origin people are sent to from a request that came in on `origin` (TEMPRA-289): an alias or
 * redirect host's links name the app's own host, so an agent on a connection made before the move
 * (`app.tempra.dev/mcp`) hands people `https://tempra.dev/…`. Any other origin (staging, a
 * preview, localhost) links to itself.
 */
export function linkOrigin(origin: string, hosts: Hosts | null): string {
  if (!hosts) return origin;
  let host: string;
  try {
    host = new URL(origin).host.toLowerCase();
  } catch {
    return origin;
  }
  return hosts.aliases.has(host) || hosts.redirects.has(host) ? `https://${hosts.primary}` : origin;
}

/**
 * Every hostname this deployment answers on, the request's own first: what a `source_url` must
 * never name (fetch-source.ts), whichever host the request came in on.
 */
export function ownHostnames(requestHost: string, hosts: Hosts | null): string[] {
  const names = [
    requestHost,
    ...(hosts ? [hosts.primary, ...hosts.aliases, ...hosts.redirects] : []),
  ]
    .map((h) => h.toLowerCase().replace(/:\d+$/, ""))
    .filter(Boolean);
  return [...new Set(names)];
}
