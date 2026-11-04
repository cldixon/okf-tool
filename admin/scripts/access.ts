/**
 * Cloudflare Access for the operator's portal (TEMPRA-278), from config: the one-time PIN login,
 * one reusable allow policy naming only the operator's email, and a self-hosted application for
 * the portal's host with a 2-hour session that uses only that login. Created when missing,
 * corrected when they differ, never deleted; nothing else in the account is touched. Safe to run
 * again. With `dryRun` it only reads and says what it would do.
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
}

export interface Ensured {
  /** The Zero Trust team domain (the tokens' issuer). */
  team: string;
  /** The application's audience tag, or "" when a dry run would create it. */
  aud: string;
  /** What was (or, in a dry run, would be) done. */
  changes: string[];
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

export async function ensureAccess(api: Api, want: Want, dryRun = false): Promise<Ensured> {
  const operator = want.operator.trim().toLowerCase();
  if (!operator.includes("@")) throw new Error("OPERATOR_EMAIL is not an email address.");
  const changes: string[] = [];

  const org = (await api("GET", "/access/organizations")) as { auth_domain?: string };
  const team = org.auth_domain ?? "";
  if (!team) throw new Error("This account has no Zero Trust organization; create one first.");

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
  const appBody = {
    name: want.name,
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
  return { team, aud: app?.aud ?? "", changes };
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
