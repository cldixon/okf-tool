/** A test signer standing in for Cloudflare Access: an RS256 keypair and tokens made with it. */

const b64url = (bytes: Uint8Array | string) =>
  Buffer.from(typeof bytes === "string" ? new TextEncoder().encode(bytes) : bytes)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");

export async function signer(kid = "key-1") {
  const pair = (await crypto.subtle.generateKey(
    {
      name: "RSASSA-PKCS1-v1_5",
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: "SHA-256",
    },
    true,
    ["sign", "verify"],
  )) as CryptoKeyPair;
  const jwk = { ...(await crypto.subtle.exportKey("jwk", pair.publicKey)), kid };
  const sign = async (payload: Record<string, unknown>, header: Record<string, unknown> = {}) => {
    const h = b64url(JSON.stringify({ alg: "RS256", kid, typ: "JWT", ...header }));
    const p = b64url(JSON.stringify(payload));
    const sig = await crypto.subtle.sign(
      "RSASSA-PKCS1-v1_5",
      pair.privateKey,
      new TextEncoder().encode(`${h}.${p}`),
    );
    return `${h}.${p}.${b64url(new Uint8Array(sig))}`;
  };
  return { jwk: jwk as JsonWebKey, sign };
}

export const TEAM = "team.cloudflareaccess.com";
export const AUD = "aud-tag";
export const OPERATOR = "owner@example.com";

/** A valid token's claims, for the operator, valid for an hour from `now`. */
export const claims = (now = Date.now(), extra: Record<string, unknown> = {}) => ({
  aud: [AUD],
  iss: `https://${TEAM}`,
  email: OPERATOR,
  iat: Math.floor(now / 1000),
  nbf: Math.floor(now / 1000),
  exp: Math.floor(now / 1000) + 3600,
  type: "app",
  ...extra,
});
