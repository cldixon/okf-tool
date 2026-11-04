/**
 * Cloudflare Access for the operator's portal (TEMPRA-278), from config: the one-time PIN login,
 * one reusable allow policy naming only the operator's email, and a self-hosted application for
 * the portal's host with a 2-hour session that uses only that login. Created when missing,
 * corrected when they differ, never deleted; nothing else in the account is touched. Safe to run
 * again. With a `brand` (TEMPRA-282) it also makes the account's sign-in page Tempra's: the
 * organization's name, team subdomain and login design. With `dryRun` it only reads and says what
 * it would do.
 */

export type Api = (
  method: "GET" | "POST" | "PUT",
  path: string,
  body?: unknown,
) => Promise<unknown>;

export interface Want {
  /** The application's name, e.g. tempra-admin. */
  name: string;
  /** The host Access covers, e.g. admin.tempra.dev. */
  host: string;
  /** The one email let in. */
  operator: string;
  /** How long a sign-in lasts. */
  sessionDuration: string;
  /** The application's name on the sign-in page ("Log in to …"); `name` when unset. */
  title?: string;
  /** The account's Access sign-in page, made Tempra's (TEMPRA-282). Unset: left as it is. */
  brand?: Brand;
}

/**
 * The sign-in page's look, which Access keeps on the account's Zero Trust organization (so one
 * look for every application, staging's and production's alike): its name, its team subdomain
 * (`<team>.cloudflareaccess.com`) and the login design's colours, logo and text.
 */
export interface Brand {
  /** The organization's name, shown over the sign-in box. */
  name: string;
  /** The team subdomain wanted. If it is taken, the current one is kept and a warning says so. */
  team: string;
  background: string;
  text: string;
  /** A URL to the logo; it must be on a host Access does not cover. */
  logo: string;
  header: string;
  footer: string;
}

export interface Ensured {
  /** The Zero Trust team domain (the tokens' issuer). */
  team: string;
  /** The application's audience tag, or "" when a dry run would create it. */
  aud: string;
  /** What was (or, in a dry run, would be) done. */
  changes: string[];
  /** What could not be done and was left as it was. */
  warnings: string[];
}

/** The permissions the API token needs, for the message when it lacks them. */
export const PERMISSIONS =
  '"Access: Organizations, Identity Providers, and Groups Write" and "Access: Apps and Policies Write"';

interface Idp {
  id: string;
  type: string;
}
interface Policy {
  id: string;
  name: string;
  decision: string;
  include: unknown[];
}
interface App {
  id: string;
  name: string;
  domain: string;
  aud: string;
  type: string;
  session_duration?: string;
  allowed_idps?: string[];
  auto_redirect_to_identity?: boolean;
  app_launcher_visible?: boolean;
  policies?: { id: string }[];
}

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/**
 * The organization's settings an update may carry. Its update replaces the whole record, so every
 * one of these the account has is sent back as it is, and only the brand's fields change.
 */
const ORG_FIELDS = [
  "allow_authenticate_via_warp",
  "auth_domain",
  "auto_redirect_to_identity",
  "custom_pages",
  "deny_unmatched_requests",
  "deny_unmatched_requests_exempted_zone_names",
  "is_ui_read_only",
  "ui_read_only_toggle_reason",
  "login_design",
  "mfa_config",
  "mfa_required_for_all_apps",
  "name",
  "service_token_inactivity",
  "session_duration",
  "strict_service_token_auth",
  "user_seat_expiration_inactive_time",
  "warp_auth_non_browser_401",
  "warp_auth_session_duration",
] as const;

const ACCESS_DOMAIN = ".cloudflareaccess.com";

/** A setting as read, without its `null`s (unset fields an update may refuse to take back). */
function withoutNulls(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(withoutNulls);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value)
        .filter(([, v]) => v !== null)
        .map(([k, v]) => [k, withoutNulls(v)]),
    );
  return value;
}

/** The sign-in page's look on the organization; returns the team domain in force after it. */
async function ensureBrand(
  api: Api,
  org: Record<string, unknown>,
  brand: Brand,
  dryRun: boolean,
  changes: string[],
  warnings: string[],
): Promise<string> {
  const current = String(org.auth_domain ?? "");
  const wantDomain = `${brand.team}${ACCESS_DOMAIN}`;
  const design = {
    background_color: brand.background,
    text_color: brand.text,
    logo_path: brand.logo,
    header_text: brand.header,
    footer_text: brand.footer,
  };
  const rename = current !== wantDomain;
  const restyle = org.name !== brand.name || !same(org.login_design ?? {}, design);
  if (!rename && !restyle) return current;
  const kept = Object.fromEntries(
    ORG_FIELDS.filter((k) => k in org && org[k] !== null).map((k) => [k, withoutNulls(org[k])]),
  );
  const body = (domain: string) => ({
    ...kept,
    name: brand.name,
    auth_domain: domain,
    login_design: design,
  });
  if (restyle) changes.push(`brand the sign-in page as "${brand.name}"`);
  if (rename) changes.push(`rename the team ${current} to ${wantDomain}`);
  if (dryRun) return current;
  if (!rename) {
    await api("PUT", "/access/organizations", body(current));
    return current;
  }
  try {
    const done = (await api("PUT", "/access/organizations", body(wantDomain))) as {
      auth_domain?: string;
    };
    return done?.auth_domain || wantDomain;
  } catch (e) {
    // Most likely the name is someone else's. Keep the team as it is and brand the page anyway.
    changes.pop();
    warnings.push(
      `the team could not be renamed to ${wantDomain} (${e instanceof Error ? e.message : e}); it stays ${current}`,
    );
    if (restyle) await api("PUT", "/access/organizations", body(current));
    return current;
  }
}

export async function ensureAccess(api: Api, want: Want, dryRun = false): Promise<Ensured> {
  const operator = want.operator.trim().toLowerCase();
  if (!operator.includes("@")) throw new Error("OPERATOR_EMAIL is not an email address.");
  const changes: string[] = [];
  const warnings: string[] = [];

  const org = (await api("GET", "/access/organizations")) as Record<string, unknown>;
  let team = String(org.auth_domain ?? "");
  if (!team) throw new Error("This account has no Zero Trust organization; create one first.");
  // The sign-in page's look and the team's name first: the team domain is the tokens' issuer,
  // which the Worker is deployed with.
  if (want.brand) team = await ensureBrand(api, org, want.brand, dryRun, changes, warnings);

  // The one-time PIN login (a code mailed to the person signing in).
  const idps = (await api("GET", "/access/identity_providers")) as Idp[];
  let otp = idps.find((i) => i.type === "onetimepin");
  if (!otp) {
    changes.push("create the one-time PIN login");
    otp = dryRun
      ? { id: "(new)", type: "onetimepin" }
      : ((await api("POST", "/access/identity_providers", {
          name: "One-time PIN",
          type: "onetimepin",
          config: {},
        })) as Idp);
  }

  // One reusable policy: allow the operator's email, nobody else.
  const policyName = `${want.name}: the operator`;
  const policyBody = {
    name: policyName,
    decision: "allow",
    include: [{ email: { email: operator } }],
    exclude: [],
    require: [],
  };
  const policies = (await api("GET", "/access/policies")) as Policy[];
  let policy = policies.find((p) => p.name === policyName);
  if (!policy) {
    changes.push(`create the policy "${policyName}" (allow ${operator})`);
    policy = dryRun
      ? { id: "(new)", ...policyBody }
      : ((await api("POST", "/access/policies", policyBody)) as Policy);
  } else if (policy.decision !== "allow" || !same(policy.include, policyBody.include)) {
    changes.push(`correct the policy "${policyName}" (allow ${operator} only)`);
    if (!dryRun) policy = (await api("PUT", `/access/policies/${policy.id}`, policyBody)) as Policy;
  }

  // The application over the whole host.
  const title = want.title ?? want.name;
  const appBody = {
    name: title,
    domain: want.host,
    type: "self_hosted",
    session_duration: want.sessionDuration,
    allowed_idps: [otp.id],
    auto_redirect_to_identity: true,
    app_launcher_visible: false,
    policies: [{ id: policy.id, precedence: 1 }],
  };
  const apps = (await api("GET", "/access/apps")) as App[];
  let app = apps.find((a) => a.domain === want.host);
  if (!app) {
    changes.push(`create the application for ${want.host} (${want.sessionDuration} sessions)`);
    if (!dryRun) app = (await api("POST", "/access/apps", appBody)) as App;
  } else if (
    app.name !== title ||
    app.type !== "self_hosted" ||
    app.session_duration !== want.sessionDuration ||
    !same(app.allowed_idps, [otp.id]) ||
    app.auto_redirect_to_identity !== true ||
    !same(
      (app.policies ?? []).map((p) => p.id),
      [policy.id],
    )
  ) {
    changes.push(`correct the application for ${want.host}`);
    if (!dryRun) app = (await api("PUT", `/access/apps/${app.id}`, appBody)) as App;
  }
  return { team, aud: app?.aud ?? "", changes, warnings };
}

/** Cloudflare's v4 API for one account, unwrapping `result` and naming missing permissions. */
export function cloudflareApi(account: string, token: string, fetcher: typeof fetch = fetch): Api {
  return async (method, path, body) => {
    const r = await fetcher(`https://api.cloudflare.com/client/v4/accounts/${account}${path}`, {
      method,
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const json = (await r.json().catch(() => ({}))) as {
      success?: boolean;
      result?: unknown;
      errors?: { code: number; message: string }[];
    };
    if (!r.ok || json.success === false) {
      const what = (json.errors ?? []).map((e) => `${e.code} ${e.message}`).join("; ");
      const hint =
        r.status === 403 || r.status === 401
          ? ` The API token needs ${PERMISSIONS} on this account.`
          : "";
      throw new Error(`${method} ${path}: ${r.status} ${what}.${hint}`);
    }
    return json.result;
  };
}
