/**
 * Checks Cloudflare Access's token on every request (TEMPRA-278): Access signs the operator in at
 * the edge with the one-time PIN and sends `Cf-Access-Jwt-Assertion`; this Worker checks it again,
 * so a request that did not come through the application (a misconfigured or missing Access app)
 * gets nothing. RS256 against the team's published keys, the application's audience tag, the
 * team as issuer, the times, and the operator's email. Free of Worker APIs.
 */

export interface AccessConfig {
  /** The Zero Trust team domain, e.g. still-heart-1d77.cloudflareaccess.com. */
  team: string;
  /** The Access application's audience tag. */
  aud: string;
  /** The one email let in (OPERATOR_EMAIL). */
  operator: string;
}

/** The team's signing keys, as `https://<team>/cdn-cgi/access/certs` publishes them. */
export type KeySource = (team: string, fresh: boolean) => Promise<JsonWebKey[]>;

export type Verdict = { ok: true; email: string } | { ok: false; why: string };

const decoder = new TextDecoder();

function b64url(s: string): Uint8Array<ArrayBuffer> {
  const pad = s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4);
  const bin = atob(pad);
  const out = new Uint8Array(new ArrayBuffer(bin.length));
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function json(part: string): Record<string, unknown> | null {
  try {
    const v = JSON.parse(decoder.decode(b64url(part)));
    return v && typeof v === "object" ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** Verifies an Access token for this application and operator. */
export async function verifyAccess(
  token: string | null,
  cfg: AccessConfig,
  keys: KeySource,
  now = Date.now(),
): Promise<Verdict> {
  if (!cfg.team || !cfg.aud || !cfg.operator) return { ok: false, why: "not configured" };
  if (!token) return { ok: false, why: "no token" };
  const parts = token.split(".");
  if (parts.length !== 3) return { ok: false, why: "malformed" };
  const [h = "", p = "", s = ""] = parts;
  const header = json(h);
  const payload = json(p);
  if (!header || !payload) return { ok: false, why: "malformed" };
  if (header.alg !== "RS256" || typeof header.kid !== "string") {
    return { ok: false, why: "unexpected algorithm" };
  }
  const signed = new TextEncoder().encode(`${h}.${p}`);
  let signature: Uint8Array<ArrayBuffer>;
  try {
    signature = b64url(s);
  } catch {
    return { ok: false, why: "malformed" };
  }
  // The keys rotate: an unknown key id fetches them afresh once.
  let jwk = (await keys(cfg.team, false)).find((k) => (k as { kid?: string }).kid === header.kid);
  if (!jwk) {
    jwk = (await keys(cfg.team, true)).find((k) => (k as { kid?: string }).kid === header.kid);
  }
  if (!jwk) return { ok: false, why: "unknown key" };
  const key = await crypto.subtle.importKey(
    "jwk",
    { kty: jwk.kty, n: jwk.n, e: jwk.e },
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["verify"],
  );
  if (!(await crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, signature, signed))) {
    return { ok: false, why: "bad signature" };
  }
  const aud = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
  if (!aud.includes(cfg.aud)) return { ok: false, why: "wrong audience" };
  if (payload.iss !== `https://${cfg.team}`) return { ok: false, why: "wrong issuer" };
  const secs = now / 1000;
  if (typeof payload.exp !== "number" || payload.exp <= secs) return { ok: false, why: "expired" };
  if (typeof payload.nbf === "number" && payload.nbf > secs + 60) {
    return { ok: false, why: "not yet valid" };
  }
  const email = typeof payload.email === "string" ? payload.email.trim().toLowerCase() : "";
  if (!email || email !== cfg.operator.trim().toLowerCase()) {
    return { ok: false, why: "not the operator" };
  }
  return { ok: true, email };
}

/** The team's keys over the network, kept for 10 minutes per isolate. */
export function fetchedKeys(fetcher: typeof fetch = fetch): KeySource {
  let cached: { team: string; keys: JsonWebKey[]; at: number } | null = null;
  return async (team, fresh) => {
    if (!fresh && cached && cached.team === team && Date.now() - cached.at < 600_000) {
      return cached.keys;
    }
    const r = await fetcher(`https://${team}/cdn-cgi/access/certs`);
    if (!r.ok) return cached?.team === team ? cached.keys : [];
    const body = (await r.json()) as { keys?: JsonWebKey[] };
    cached = { team, keys: body.keys ?? [], at: Date.now() };
    return cached.keys;
  };
}
