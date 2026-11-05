import { describe, expect, test } from "bun:test";
import { type AdminEnv, createAdmin } from "../src/index";
import type { OperatorService, Outcome, People } from "../src/operator";
import { when } from "../src/pages";
import { AUD, claims, OPERATOR, signer, TEAM } from "./jwt";

const ORIGIN = "https://admin.tempra.dev";

/** A stand-in for the app's Operator entrypoint, recording what it was asked. */
function fakeOperator(people: People) {
  const calls: unknown[][] = [];
  const op: OperatorService = {
    async people(who) {
      calls.push(["people", who]);
      return people;
    },
    async invite(who, email) {
      calls.push(["invite", who, email]);
      return "invited" as Outcome;
    },
    async decide(who, email, decision) {
      calls.push(["decide", who, email, decision]);
      return decision === "dismissed" ? "dismissed" : "invited";
    },
    async activity(who) {
      calls.push(["activity", who]);
      return {
        accounts: 3,
        libraries: 5,
        people: { day: 1, week: 2, month: 3 },
        agents: { day: 0, week: 1, month: 2 },
      };
    },
  };
  return { op, calls };
}

const PEOPLE: People = {
  waiting: [{ email: "asked@example.com", asked: "2026-11-01T09:00:00.000Z" }],
  signedUp: [
    {
      email: "in@example.com",
      handle: "in",
      invited: "2026-10-30T10:00:00.000Z",
      created: "2026-10-31T14:05:00.000Z",
    },
  ],
  notYet: [{ email: "later@example.com", invited: "2026-11-02T08:00:00.000Z" }],
};

describe("the operator's portal (TEMPRA-278)", async () => {
  const s = await signer();
  const app = createAdmin({ keys: async () => [s.jwk] });
  const env = (op?: OperatorService): AdminEnv => ({
    ORIGIN,
    ACCESS_TEAM: TEAM,
    ACCESS_AUD: AUD,
    USAGE_DATASET: "tempra_usage",
    ACCOUNT_ID: "acc",
    OPERATOR_EMAIL: OPERATOR,
    OPERATOR: op,
  });
  const signedIn = async (init: RequestInit = {}) => {
    const headers = new Headers(init.headers);
    headers.set("Cf-Access-Jwt-Assertion", await s.sign(claims()));
    return { ...init, headers };
  };

  test("without Access's token, or someone else's, nothing is shown", async () => {
    const { op, calls } = fakeOperator(PEOPLE);
    const none = await app.request("/", {}, env(op));
    expect(none.status).toBe(403);
    expect(await none.text()).not.toContain("asked@example.com");
    const other = await s.sign(claims(Date.now(), { email: "someone@example.com" }));
    const r = await app.request("/", { headers: { "Cf-Access-Jwt-Assertion": other } }, env(op));
    expect(r.status).toBe(403);
    // Not configured (no audience tag): refused even with a good token.
    const unset = await app.request("/", await signedIn(), { ...env(op), ACCESS_AUD: "" });
    expect(unset.status).toBe(403);
    const post = await app.request(
      "/invite",
      {
        method: "POST",
        headers: { Origin: ORIGIN },
        body: new URLSearchParams({ email: "x@y.z" }),
      },
      env(op),
    );
    expect(post.status).toBe(403);
    expect(calls).toEqual([]);
    expect(none.headers.get("Cache-Control")).toBe("no-store");
  });

  test("the page: invite, the three lists and activity, under a strict CSP", async () => {
    const { op, calls } = fakeOperator(PEOPLE);
    const r = await app.request("/", await signedIn(), env(op));
    expect(r.status).toBe(200);
    const html = await r.text();
    // Dark, as the server pages and the landing page are (TEMPRA-285).
    expect(html).toContain('<html lang="en" data-theme="dark"><head>');
    expect(html).toContain('action="/invite"');
    expect(html).toContain("Waiting (1)");
    expect(html).toContain("asked@example.com");
    expect(html).toContain("Signed up (1)");
    expect(html).toContain("@in");
    expect(html).toContain("31 Oct 2026, 14:05 UTC");
    expect(html).toContain("Not signed up yet (1)");
    expect(html).toContain("later@example.com");
    expect(html).toContain("3 accounts, 5 libraries.");
    expect(html).toContain("needs an Analytics read token");
    expect(html).not.toContain("<script");
    expect(html).not.toContain("style=");
    expect(r.headers.get("Content-Security-Policy")).toContain("default-src 'none'");
    expect(r.headers.get("X-Robots-Tag")).toBe("noindex");
    // The app is asked as the operator Access named.
    expect(calls).toContainEqual(["people", OPERATOR]);
    expect(calls).toContainEqual(["activity", OPERATOR]);
  });

  test("invite and decide go to the app from this page only, then back with what happened", async () => {
    const { op, calls } = fakeOperator(PEOPLE);
    const form = (body: Record<string, string>, origin = ORIGIN) =>
      signedIn({
        method: "POST",
        headers: { Origin: origin },
        body: new URLSearchParams(body),
      });
    const cross = await app.request(
      "/invite",
      await form({ email: "x@example.com" }, "https://evil.example"),
      env(op),
    );
    expect(cross.status).toBe(403);
    const r = await app.request("/invite", await form({ email: "new@example.com" }), env(op));
    expect(r.status).toBe(303);
    expect(r.headers.get("Location")).toBe("/?done=invited&email=new%40example.com");
    const back = await app.request(r.headers.get("Location") ?? "", await signedIn(), env(op));
    expect(await back.text()).toContain("new@example.com is invited and has been emailed.");
    const d = await app.request(
      "/decide",
      await form({ email: "asked@example.com", decision: "dismissed" }),
      env(op),
    );
    expect(d.headers.get("Location")).toBe("/?done=dismissed&email=asked%40example.com");
    expect(calls.filter((c) => c[0] === "invite" || c[0] === "decide")).toEqual([
      ["invite", OPERATOR, "new@example.com"],
      ["decide", OPERATOR, "asked@example.com", "dismissed"],
    ]);
  });

  test("an app that does not answer says so, and nothing else breaks", async () => {
    const r = await app.request("/", await signedIn(), env());
    expect(r.status).toBe(200);
    expect(await r.text()).toContain("The app did not answer.");
  });

  test("times read in UTC", () => {
    expect(when("2026-11-03T09:05:00Z")).toBe("3 Nov 2026, 09:05 UTC");
    expect(when(null)).toBe("–");
  });
});
