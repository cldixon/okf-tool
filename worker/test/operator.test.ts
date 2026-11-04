import { describe, expect, test } from "bun:test";
import { operatorOps } from "../src/operator";
import { ORIGIN, setup } from "./harness";

// The operator's portal (TEMPRA-278, tempra-dev decisions/an-admin-portal.md): what admin/ calls
// through the Operator entrypoint, here on the harness's real account SQL.

type S = ReturnType<typeof setup>;

const settle = () => new Promise((r) => setTimeout(r, 10));

function world() {
  const s = setup();
  Object.assign(s.env, { SIGNUP: "invite", OPERATOR_EMAIL: "owner@example.com" });
  return { s, ops: operatorOps(s.deps, ORIGIN) };
}

const ask = (s: S, email: string) =>
  s.anon.request("/request-access", {
    method: "POST",
    headers: { Origin: ORIGIN },
    body: new URLSearchParams({ email }),
  });

describe("the operator's portal", () => {
  test("invite adds the email, mails them once, and lists them as not signed up", async () => {
    const { s, ops } = world();
    s.outbox.length = 0;
    expect(await ops.invite("  Friend@Example.com ")).toBe("invited");
    expect(await ops.invite("friend@example.com")).toBe("already");
    expect(await ops.invite("not an email")).toBe("bad_email");
    await settle();
    const mail = s.outbox.filter((m) => m.to === "friend@example.com");
    expect(mail.map((m) => m.subject)).toEqual(["You're in: Tempra"]);
    expect(mail[0]?.text).toContain(`${ORIGIN}/sign-in`);
    const people = await ops.people();
    expect(people.notYet.map((p) => p.email)).toEqual(["friend@example.com"]);
    expect(people.signedUp).toEqual([]);
    expect(await s.accounts.mayJoin("friend@example.com", "invite")).toBe(true);
  });

  test("an invited email that made an account moves to signed up, with when", async () => {
    const { s, ops } = world();
    await ops.invite("friend@example.com");
    const user = await s.accounts.user("friend@example.com");
    const people = await ops.people();
    expect(people.notYet).toEqual([]);
    expect(people.signedUp).toHaveLength(1);
    expect(people.signedUp[0]).toMatchObject({ email: "friend@example.com", handle: user.handle });
    expect(people.signedUp[0]?.created).toBeTruthy();
    expect(people.signedUp[0]?.invited).toBeTruthy();
  });

  test("the waitlist: waiting, approve (mailed) and dismiss", async () => {
    const { s, ops } = world();
    await ask(s, "asked@example.com");
    await ask(s, "spam@example.com");
    await settle();
    expect((await ops.people()).waiting.map((w) => w.email)).toEqual([
      "asked@example.com",
      "spam@example.com",
    ]);
    s.outbox.length = 0;
    expect(await ops.decide("asked@example.com", "invited")).toBe("invited");
    expect(await ops.decide("asked@example.com", "invited")).toBe("missing");
    expect(await ops.decide("spam@example.com", "dismissed")).toBe("dismissed");
    await settle();
    expect(s.outbox.map((m) => [m.to, m.text.split("\n")[0]])).toEqual([
      ["asked@example.com", "You asked to join Tempra, and you're in."],
    ]);
    const people = await ops.people();
    expect(people.waiting).toEqual([]);
    expect(people.notYet.map((p) => p.email)).toEqual(["asked@example.com"]);
  });

  test("inviting someone who is waiting decides them too", async () => {
    const { s, ops } = world();
    await ask(s, "asked@example.com");
    expect(await ops.invite("asked@example.com")).toBe("invited");
    expect((await ops.people()).waiting).toEqual([]);
  });

  test("activity counts people by session and agents by when they were seen", async () => {
    const { s, ops } = world();
    const now = Date.now();
    const before = await ops.activity(now);
    expect(before.accounts).toBeGreaterThan(0);
    expect(before.libraries).toBeGreaterThan(0);
    // The demo owner's session is from now: active in every window.
    expect(before.people).toEqual({ day: 1, week: 1, month: 1 });
    // Ten days on, the session is outside the day and the week but inside the month.
    const later = await ops.activity(now + 10 * 86_400_000);
    expect(later.people).toEqual({ day: 0, week: 0, month: 1 });
    // A second account's session seen now counts once more.
    const other = await s.stranger();
    expect(other.user).toBeTruthy();
    expect((await ops.activity(now)).people.day).toBe(2);
  });
});

describe("the app's /waitlist", () => {
  test("sends the operator to the portal where there is one, and no one else", async () => {
    const { s } = world();
    Object.assign(s.env, { ADMIN_ORIGIN: "https://admin.tempra.dev" });
    const r = await s.app.request("/waitlist");
    expect(r.status).toBe(302);
    expect(r.headers.get("Location")).toBe("https://admin.tempra.dev/");
    const { app: other } = await s.stranger();
    expect((await other.request("/waitlist")).status).toBe(404);
  });
});

describe("the Operator entrypoint", () => {
  test("refuses anyone but OPERATOR_EMAIL", async () => {
    const { Operator } = await import("../src/index");
    const op = Object.assign(Object.create(Operator.prototype), {
      env: { OPERATOR_EMAIL: "owner@example.com" },
    }) as InstanceType<typeof Operator>;
    expect(() => op.people("someone@example.com")).toThrow("Not the operator.");
    const unset = Object.assign(Object.create(Operator.prototype), { env: {} }) as typeof op;
    expect(() => unset.people("owner@example.com")).toThrow("Not the operator.");
  });
});
