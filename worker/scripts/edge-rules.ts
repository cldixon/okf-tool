/**
 * The zone's custom WAF rule that stops scanners' probes at the edge (TEMPRA-290, tempra-dev
 * `delivery/edge-rules.md`): requests for secrets and server files (`/.env`, `/.git/config`,
 * `/backup.sql`, `/phpinfo.php`, `/server/.env`) that no Tempra host ever serves, blocked before
 * the Worker runs. Applied by `bun run deploy` (`ensureEdgeRules` in scripts/cf.ts).
 *
 * What it may block is narrow, because a library holds files of any name: a library's files are
 * at `/<handle>/<library>/<path>`, three segments or more, so the rule only looks at paths of one
 * or two segments (no handle or library name starts with a dot or has one; handles.ts), and never
 * at `/.well-known/`, which OAuth discovery needs. The free plan has no regular expressions in
 * rules, so segments are counted with `wildcard`, whose `*` also matches slashes: a path matches
 * `/*\/*\/*` exactly when it has three segments or more.
 *
 * `probePath` is the same rule in JavaScript, for the tests that hold it to the app's own paths.
 * Free of Worker APIs; imported by scripts only, never by cloudflare.config.ts.
 */

/** Identifies our rule in the zone's ruleset; other rules there are never touched. */
export const PROBE_RULE_REF = "tempra_scanner_probes";

/** Endings no one- or two-segment path of ours has: server code, dumps, configs, editor leftovers. */
export const PROBE_ENDINGS = [
  ".php",
  ".sql",
  ".bak",
  ".old",
  ".swp",
  ".ini",
  ".cfg",
  ".conf",
  ".toml",
  ".yml",
  ".yaml",
  ".env",
] as const;

const P = "lower(http.request.uri.path)";

/** The rule's expression, in Cloudflare's Rules language. */
export function probeExpression(): string {
  const short = `not ${P} wildcard "/*/*/*"`;
  const dotRoot = `(starts_with(${P}, "/.") and not starts_with(${P}, "/.well-known/"))`;
  const dotSecond = `(${P} wildcard "/*/.*" and ${short})`;
  const endings = PROBE_ENDINGS.map((e) => `ends_with(${P}, "${e}")`).join(" or ");
  return `${dotRoot} or ${dotSecond} or ((${endings}) and ${short})`;
}

/** The rule as the Rulesets API takes it. */
export function probeRule(): {
  ref: string;
  description: string;
  expression: string;
  action: "block";
  enabled: true;
} {
  return {
    ref: PROBE_RULE_REF,
    description: "Tempra: scanners' probes for secrets and server files (scripts/edge-rules.ts)",
    expression: probeExpression(),
    action: "block",
    enabled: true,
  };
}

/** Whether the rule blocks `path` (a URL's path): `probeExpression` in JavaScript. */
export function probePath(path: string): boolean {
  const p = path.toLowerCase();
  const slashes = p.split("/").length - 1;
  const short = slashes <= 2;
  if (p.startsWith("/.") && !p.startsWith("/.well-known/")) return true;
  if (short && slashes === 2 && p.slice(p.indexOf("/", 1) + 1).startsWith(".")) return true;
  return short && PROBE_ENDINGS.some((e) => p.endsWith(e));
}
