import { StoreError } from "./store/errors";

/**
 * Handles are the first segment of every library URL, so they are guarded like domain names
 * (v2 spec: Handles and the namespace): a tight syntax, names reserved for routes, roles and the
 * brand, and a hold on released handles.
 */

const SYNTAX = /^[a-z0-9](?:[a-z0-9]|[-_](?=[a-z0-9])){1,38}$/;

/**
 * Top-level routes, now or likely later; a handle here would sit beside them in URLs. The landing
 * page shares the top level since TEMPRA-276 (legal.ts SITE_PATHS), so a new page there reserves
 * its name here first.
 */
const ROUTES = [
  "-",
  "about",
  "account",
  "accounts",
  "agents",
  "api",
  "app",
  "apps",
  "assets",
  "auth",
  "authorize",
  "blog",
  "brand",
  "callback",
  "careers",
  "changelog",
  "community",
  "connect",
  "contact",
  "customers",
  "dashboard",
  "dl",
  "docs",
  "download",
  "downloads",
  "enterprise",
  "explore",
  "export",
  "faq",
  "favicon.ico",
  "features",
  "grants",
  "guides",
  "healthz",
  "home",
  "import",
  "inbox",
  "integrations",
  "invitations",
  "invite",
  "invites",
  "jobs",
  "join",
  "learn",
  "libraries",
  "library",
  "login",
  "logout",
  "mcp",
  "members",
  "new",
  "notifications",
  "oauth",
  "organizations",
  "orgs",
  "pricing",
  "privacy",
  "register",
  "request-access",
  "roadmap",
  "robots.txt",
  "search",
  "security",
  "settings",
  "sign-in",
  "sign-out",
  "sign-up",
  "signin",
  "signout",
  "signup",
  "sitemap",
  "sitemap.xml",
  "static",
  "status",
  "teams",
  "terms",
  "token",
  "tokens",
  "u",
  "ul",
  "unsubscribe",
  "upload",
  "uploads",
  "user",
  "users",
  "waitlist",
  "welcome",
  "well-known",
  "www",
];

/** Words that claim a role or trust, or that mail and DNS treat as special. */
const ROLES = [
  "abuse",
  "admin",
  "administrator",
  "billing",
  "bot",
  "ceo",
  "compliance",
  "help",
  "helpdesk",
  "hostmaster",
  "info",
  "legal",
  "mail",
  "mailer-daemon",
  "moderator",
  "noreply",
  "no-reply",
  "null",
  "official",
  "operator",
  "postmaster",
  "press",
  "privacy",
  "root",
  "sales",
  "security",
  "staff",
  "support",
  "sysadmin",
  "system",
  "team",
  "undefined",
  "webmaster",
];

/** The product, the format and the company names it could be confused with. */
const BRAND = ["tempra", "okf", "anthropic", "claude", "cloudflare"];

const RESERVED = new Set([...ROUTES, ...ROLES, ...BRAND]);
const ROUTE_NAMES = new Set(ROUTES);

/** Whether a first path segment names one of the service's own routes, never a handle. */
export function isRouteName(segment: string): boolean {
  return ROUTE_NAMES.has(segment) || segment.startsWith(".");
}

/** Prefixes that read as staff or official accounts. */
const PREFIXES = ["admin", "support", "official", "staff"];

/** Whether a (syntactically valid) handle is kept back for the operator. */
export function isReservedHandle(handle: string): boolean {
  return (
    RESERVED.has(handle) || handle.includes("tempra") || PREFIXES.some((p) => handle.startsWith(p))
  );
}

/** How long a released handle stays with its former account (renames and deletions). */
export const HANDLE_HOLD_DAYS = 90;

/**
 * Normalizes and checks a handle a person chose. The operator may assign a reserved one
 * (`bun run admin rename`), so `reserved: "allow"` skips that check.
 */
export function checkHandle(input: string, opts: { reserved?: "allow" } = {}): string {
  const h = input.trim().toLowerCase();
  if (!SYNTAX.test(h)) {
    throw new StoreError(
      400,
      "bad_handle",
      "A handle is 2 to 39 lowercase letters and digits, with single - or _ between them.",
    );
  }
  if (opts.reserved !== "allow" && isReservedHandle(h)) {
    throw new StoreError(400, "reserved_handle", `The handle ${h} is reserved.`);
  }
  return h;
}

/**
 * A handle from an email's local part (v2 spec: Accounts); the caller makes it unique. One that
 * is reserved or too short gets a `u-` prefix, or becomes `member` when that is not enough.
 */
export function handleFromEmail(email: string): string {
  const local = (email.split("@")[0] ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, "-")
    .replace(/[-_]{2,}/g, "-")
    .replace(/^[-_]+|[-_]+$/g, "")
    .slice(0, 30);
  for (const h of [local, `u-${local}`]) {
    if (SYNTAX.test(h) && !isReservedHandle(h)) return h;
  }
  return "member";
}
