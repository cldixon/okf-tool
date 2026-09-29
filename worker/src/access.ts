import { createRemoteJWKSet, jwtVerify } from "jose";

/**
 * The person signed in through Cloudflare Access (spec: Auth, identity and actors). Access sits in
 * front of /app/* only; the Worker still verifies the JWT Access adds, so a request that reaches
 * it some other way is not trusted.
 */
export interface Identity {
  email: string;
}

export interface AccessConfig {
  teamDomain?: string;
  audience?: string;
  /** Local dev only; honored on loopback hosts when Access is not configured. */
  devEmail?: string;
}

const jwks = new Map<string, ReturnType<typeof createRemoteJWKSet>>();

function keySet(teamDomain: string) {
  let set = jwks.get(teamDomain);
  if (!set) {
    set = createRemoteJWKSet(new URL("/cdn-cgi/access/certs", teamDomain));
    jwks.set(teamDomain, set);
  }
  return set;
}

function isLoopback(url: URL): boolean {
  return ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
}

function cookie(req: Request, name: string): string | null {
  for (const part of (req.headers.get("Cookie") ?? "").split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === name) return v.join("=");
  }
  return null;
}

export type AccessResult =
  | { ok: true; identity: Identity }
  | { ok: false; reason: "not_configured" | "not_signed_in" | "invalid" };

export async function accessIdentity(req: Request, config: AccessConfig): Promise<AccessResult> {
  const team = config.teamDomain?.replace(/\/+$/, "");
  if (!team) {
    if (config.devEmail && isLoopback(new URL(req.url))) {
      return { ok: true, identity: { email: config.devEmail } };
    }
    return { ok: false, reason: "not_configured" };
  }
  if (!config.audience) return { ok: false, reason: "not_configured" };
  const jwt = req.headers.get("Cf-Access-Jwt-Assertion") ?? cookie(req, "CF_Authorization");
  if (!jwt) return { ok: false, reason: "not_signed_in" };
  try {
    const { payload } = await jwtVerify(jwt, keySet(team), {
      issuer: team,
      audience: config.audience,
    });
    const email = typeof payload.email === "string" ? payload.email.toLowerCase() : null;
    if (!email) return { ok: false, reason: "invalid" };
    return { ok: true, identity: { email } };
  } catch {
    return { ok: false, reason: "invalid" };
  }
}
