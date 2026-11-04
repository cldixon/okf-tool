import { describe, expect, test } from "bun:test";
import { fetchedKeys, verifyAccess } from "../src/access";
import { AUD, claims, OPERATOR, signer, TEAM } from "./jwt";

const cfg = { team: TEAM, aud: AUD, operator: OPERATOR };

describe("Access's token, checked again (TEMPRA-278)", async () => {
  const s = await signer();
  const keys = async () => [s.jwk];

  test("the operator's valid token passes", async () => {
    const v = await verifyAccess(await s.sign(claims()), cfg, keys);
    expect(v).toEqual({ ok: true, email: OPERATOR });
    // The email compares without case or spaces.
    const loud = await s.sign(claims(Date.now(), { email: " Owner@Example.COM " }));
    expect((await verifyAccess(loud, cfg, keys)).ok).toBe(true);
  });

  test("everything else fails closed", async () => {
    const now = Date.now();
    const cases: [string, string | null, typeof cfg][] = [
      ["no token", null, cfg],
      ["malformed", "a.b", cfg],
      ["not configured", await s.sign(claims()), { ...cfg, aud: "" }],
      ["not configured", await s.sign(claims()), { ...cfg, operator: "" }],
      ["wrong audience", await s.sign(claims(now, { aud: ["other"] })), cfg],
      ["wrong issuer", await s.sign(claims(now, { iss: "https://evil.example" })), cfg],
      ["expired", await s.sign(claims(now, { exp: Math.floor(now / 1000) - 1 })), cfg],
      ["not yet valid", await s.sign(claims(now, { nbf: Math.floor(now / 1000) + 3600 })), cfg],
      ["not the operator", await s.sign(claims(now, { email: "someone@example.com" })), cfg],
      ["not the operator", await s.sign(claims(now, { email: undefined })), cfg],
      ["unexpected algorithm", await s.sign(claims(), { alg: "HS256" }), cfg],
      ["unknown key", await s.sign(claims(), { kid: "other" }), cfg],
    ];
    for (const [why, token, c] of cases) {
      expect([why, await verifyAccess(token, c, keys, now)]).toEqual([why, { ok: false, why }]);
    }
  });

  test("a token signed by another key, or altered, is refused", async () => {
    const other = await signer();
    const forged = await other.sign(claims());
    expect(await verifyAccess(forged, cfg, keys)).toEqual({ ok: false, why: "bad signature" });
    const good = await s.sign(claims());
    const [h, , sig] = good.split(".");
    const p = Buffer.from(
      JSON.stringify(claims(Date.now(), { email: OPERATOR, admin: true })),
    ).toString("base64url");
    expect(await verifyAccess(`${h}.${p}.${sig}`, cfg, keys)).toEqual({
      ok: false,
      why: "bad signature",
    });
  });

  test("keys are fetched from the team, cached, and fetched afresh for a new key id", async () => {
    const asked: string[] = [];
    let served = [s.jwk];
    const source = fetchedKeys((async (url: string) => {
      asked.push(url);
      return Response.json({ keys: served });
    }) as unknown as typeof fetch);
    expect(await source(TEAM, false)).toEqual([s.jwk]);
    expect(await source(TEAM, false)).toEqual([s.jwk]);
    expect(asked).toEqual([`https://${TEAM}/cdn-cgi/access/certs`]);
    const rotated = await signer("key-2");
    served = [rotated.jwk];
    const v = await verifyAccess(await rotated.sign(claims()), cfg, source);
    expect(v.ok).toBe(true);
    expect(asked).toHaveLength(2);
  });
});
