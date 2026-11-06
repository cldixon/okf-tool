import { describe, expect, test } from "bun:test";
import { PROBE_ENDINGS, probeExpression, probePath, probeRule } from "../scripts/edge-rules";

// TEMPRA-290: the zone's WAF rule against scanners' probes. probePath is the expression in
// JavaScript; these hold it to what scanners ask for and to every path Tempra serves.

/** Probes seen in production's logs after the move to the apex (2026-11-05). */
const PROBES = [
  "/.env",
  "/.env.local",
  "/.env.staging",
  "/.env.bak",
  "/.env.example",
  "/.env.yaml",
  "/.env.swp",
  "/.git/config",
  "/.git/.env",
  "/server/.env",
  "/rabbitmq/.env",
  "/backup.sql",
  "/settings.toml",
  "/secrets.yml",
  "/phpversion.php",
  "/server-status.php",
  "/_profiler/phpinfo.php",
  "/wp-login.php",
  "/storage/backup.SQL",
];

/** What Tempra's hosts serve at one or two segments, and library paths of any name. */
const SERVED = [
  "/",
  "/sign-in",
  "/agents",
  "/account",
  "/invitations",
  "/waitlist",
  "/mcp",
  "/token",
  "/register",
  "/authorize",
  "/healthz",
  "/favicon.svg",
  "/mark.svg",
  "/robots.txt",
  "/sitemap.xml",
  "/terms",
  "/privacy",
  "/_app/app.3f9a2c.js",
  "/_app/chart-1a2b3c.js",
  "/_design/tempra.abc123.css",
  "/_design/inter-latin.abc123.woff2",
  "/_astro/inter-latin-opsz-normal.BwkfbSeq.woff2",
  "/.well-known/oauth-authorization-server",
  "/.well-known/oauth-protected-resource/mcp",
  "/api/v1/me",
  "/api/v1/libraries/cl_dixon/dev/files/x.php",
  "/cl_dixon",
  "/cl_dixon/tempra-dev",
  "/cl_dixon/tempra-dev/",
  // A library holds files of any name: three segments or more are never matched.
  "/cl_dixon/dev/.env",
  "/cl_dixon/dev/scripts/deploy.php",
  "/cl_dixon/dev/backup.sql",
  "/cl_dixon/dev/config.yml",
  "/cl_dixon/dev/-/activity",
  "/cl_dixon/dev/-/media/0123abcd",
  "/ul/lib/token",
  "/dl/lib/signed",
  // Deeper probes are left to the Worker's 404s: the rule cannot tell them from a library's files.
  "/admin/.git/config",
];

describe("edge rule against scanners' probes", () => {
  test("blocks what scanners asked production for", () => {
    for (const p of PROBES) expect({ p, blocked: probePath(p) }).toEqual({ p, blocked: true });
  });

  test("never blocks a path Tempra serves", () => {
    for (const p of SERVED) expect({ p, blocked: probePath(p) }).toEqual({ p, blocked: false });
  });

  test("the expression is the rule probePath describes", () => {
    const e = probeExpression();
    expect(e).toContain('not starts_with(lower(http.request.uri.path), "/.well-known/")');
    expect(e).toContain('not lower(http.request.uri.path) wildcard "/*/*/*"');
    for (const ending of PROBE_ENDINGS) expect(e).toContain(`"${ending}"`);
    // No regular expressions: `matches` needs a Business plan.
    expect(e).not.toContain(" matches ");
    expect(probeRule()).toMatchObject({ action: "block", enabled: true, expression: e });
  });
});
