import { describe, expect, test } from "bun:test";
import { LINKS_PER_EMAIL_HOUR, SESSION_COOKIE, safeNext } from "../src/session";
import { ORIGIN, setup } from "./harness";

type S = ReturnType<typeof setup>;
const form = (fields: Record<string, string>) => new URLSearchParams(fields);

function post(s: S, path: string, fields: Record<string, string>, origin = ORIGIN) {
  return s.anon.request(path, {
    method: "POST",
    headers: { Origin: origin },
    body: form(fields),
    redirect: "manual",
  });
}

/** Asks for a link; returns the secret and `next` from the email that was sent. */
async function askLink(s: S, email: string, next = "/app") {
  const sent = s.outbox.length;
  const r = await post(s, "/app/sign-in", { email, next });
  expect(r.status).toBe(200);
  expect(await r.text()).toContain("Check your email");
  const mail = s.outbox[sent];
  if (!mail) return null;
  const url = new URL(/https?:\/\/\S+/.exec(mail.text)?.[0] ?? "");
  return { t: url.searchParams.get("t") ?? "", next: url.searchParams.get("next") ?? "", url };
}

async function signIn(s: S, email: string, next = "/app") {
  const link = await askLink(s, email, next);
  if (!link) throw new Error("no email");
  const r = await post(s, "/app/sign-in/link", { t: link.t, next: link.next });
  expect(r.status).toBe(303);
  const cookie = r.headers.get("Set-Cookie") ?? "";
  const secret = new RegExp(`${SESSION_COOKIE}=([^;]+)`).exec(cookie)?.[1] ?? "";
  return { r, cookie, secret, link };
}

const withSession = (secret: string) => ({ Cookie: `${SESSION_COOKIE}=${secret}` });

describe("magic-link sign-in (v2 spec: Accounts and sign-in)", () => {
  test("a page load without a session goes to sign-in, keeping where it was going", async () => {
    const s = setup();
    const r = await s.anon.request("/app/tokens?x=1");
    expect(r.status).toBe(302);
    expect(r.headers.get("Location")).toBe("/app/sign-in?next=%2Fapp%2Ftokens%3Fx%3D1");
    const page = await s.anon.request("/app/sign-in?next=%2Fapp%2Ftokens");
    const html = await page.text();
    expect(page.status).toBe(200);
    expect(html).toContain('name="next" value="/app/tokens"');
  });

  test("sign up by email: link, continue, session; the link works once", async () => {
    const s = setup();
    expect((await post(s, "/app/sign-in", { email: "a@b.c" }, "https://evil.example")).status).toBe(
      403,
    );
    const bad = await post(s, "/app/sign-in", { email: "not an email" });
    expect(bad.status).toBe(400);
    expect(s.outbox).toHaveLength(0);

    const { r, cookie, secret, link } = await signIn(s, "New.Person@Example.com", "/app/tokens");
    expect(s.outbox[0]?.to).toBe("new.person@example.com");
    expect(s.outbox[0]?.text).toContain("within 15 minutes");
    expect(r.headers.get("Location")).toBe("/app/tokens");
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("Secure");
    expect(cookie).toContain("SameSite=Lax");
    expect(cookie).toContain("Path=/");
    expect(secret).toMatch(/^[0-9a-f]{64}$/);

    // Only hashes are stored.
    const stored = JSON.stringify(s.db.query("SELECT * FROM sessions").all());
    expect(stored).not.toContain(secret);
    expect(JSON.stringify(s.db.query("SELECT * FROM sign_in_links").all())).not.toContain(link.t);

    // A new account, with a handle from the email, and none of the owner's libraries: first run.
    const home = await s.anon.request("/app", { headers: withSession(secret), redirect: "manual" });
    expect(home.status).toBe(302);
    expect(home.headers.get("Location")).toBe("/app/welcome");
    expect(
      await (await s.anon.request("/app/account", { headers: withSession(secret) })).text(),
    ).toContain("new.person@example.com");
    expect((await s.accounts.user("new.person@example.com")).actor).toBe("human:new-person");

    // Opening the link again (or a scanner fetching it) shows a button; posting it again fails.
    const opened = await s.anon.request(link.url.pathname + link.url.search);
    expect(await opened.text()).toContain("Continue");
    const again = await post(s, "/app/sign-in/link", { t: link.t, next: "/app" });
    expect(again.status).toBe(400);
    expect(await again.text()).toContain("This link has expired");
    expect(
      (await post(s, "/app/sign-in/link", { t: link.t, next: "/app" }, "https://evil.example"))
        .status,
    ).toBe(403);
  });

  test("an existing email signs in to its account; handles stay unique", async () => {
    const s = setup();
    const { secret } = await signIn(s, "owner@example.com");
    const home = await s.anon.request("/app", { headers: withSession(secret) });
    expect(await home.text()).toContain('href="/app/libraries/owner/demo/"');
    expect((await s.accounts.user("owner@elsewhere.org")).handle).toBe("owner-2");
    expect((await s.accounts.user("owner@third.org")).handle).toBe("owner-3");
  });

  test("an expired link is refused", async () => {
    const s = setup();
    const link = await askLink(s, "late@example.com");
    s.db.run("UPDATE sign_in_links SET expires = '2000-01-01T00:00:00.000Z'");
    const r = await post(s, "/app/sign-in/link", { t: link?.t ?? "", next: "/app" });
    expect(r.status).toBe(400);
  });

  test("too many links: the same answer, but no more email", async () => {
    const s = setup();
    for (let i = 0; i < LINKS_PER_EMAIL_HOUR; i++) expect(await askLink(s, "x@y.z")).not.toBeNull();
    expect(await askLink(s, "x@y.z")).toBeNull();
    expect(s.outbox).toHaveLength(LINKS_PER_EMAIL_HOUR);
  });

  test("sign out, and sign out everywhere", async () => {
    const s = setup();
    const a = await signIn(s, "me@example.com");
    const b = await signIn(s, "me@example.com");
    const c = await signIn(s, "me@example.com");
    const out = await s.anon.request("/app/sign-out", {
      method: "POST",
      headers: { Origin: ORIGIN, ...withSession(a.secret) },
      redirect: "manual",
    });
    expect(out.status).toBe(303);
    expect(out.headers.get("Set-Cookie")).toContain("Max-Age=0");
    expect(
      (await s.anon.request("/app/account", { headers: withSession(a.secret), redirect: "manual" }))
        .status,
    ).toBe(302);
    expect(
      (await s.anon.request("/app/account", { headers: withSession(b.secret), redirect: "manual" }))
        .status,
    ).toBe(200);

    await s.anon.request("/app/sign-out/everywhere", {
      method: "POST",
      headers: { Origin: ORIGIN, ...withSession(b.secret) },
    });
    expect(
      (await s.anon.request("/app/account", { headers: withSession(b.secret), redirect: "manual" }))
        .status,
    ).toBe(302);
    expect(
      (await s.anon.request("/app/account", { headers: withSession(c.secret), redirect: "manual" }))
        .status,
    ).toBe(302);
    // The owner's session is untouched.
    expect((await s.app.request("/app")).status).toBe(200);
  });

  test("sessions end after 30 idle days or 90 in all; suspension ends them at once", async () => {
    const s = setup();
    const { secret } = await signIn(s, "me@example.com");
    const ok = () =>
      s.anon.request("/app/account", { headers: withSession(secret), redirect: "manual" });
    expect((await ok()).status).toBe(200);
    s.db.run("UPDATE sessions SET idle_expires = '2000-01-01T00:00:00.000Z'");
    expect((await ok()).status).toBe(302);
    s.db.run("UPDATE sessions SET idle_expires = '2999-01-01T00:00:00.000Z'");
    expect((await ok()).status).toBe(200);
    s.db.run("UPDATE sessions SET expires = '2000-01-01T00:00:00.000Z'");
    expect((await ok()).status).toBe(302);

    s.db.run("UPDATE users SET suspended = '2026-10-02T00:00:00Z' WHERE id = 'user_1'");
    expect((await s.app.request("/app")).status).toBe(302);
  });

  test("a suspended account's tokens are refused", async () => {
    const s = setup();
    const other = await s.stranger();
    expect((await other.app.request("/app")).status).toBe(200);
    const tree = () =>
      s.anon.request("/api/v1/libraries/stranger/demo/tree", {
        headers: { Authorization: `Bearer ${other.writer}` },
      });
    expect((await tree()).status).toBe(200);
    s.db.run("UPDATE users SET suspended = '2026-10-02T00:00:00Z' WHERE id = ?", [other.user.id]);
    expect((await tree()).status).toBe(401);
  });

  test("without a mail provider, only local dev with DEV_SIGNIN=1 can sign in", async () => {
    const s = setup();
    s.deps.mailer = null;
    const remote = await s.anon.request("https://okf.example.com/app/sign-in");
    expect(remote.status).toBe(503);
    expect((await s.anon.request("/app/sign-in")).status).toBe(503);

    Object.assign(s.env, { DEV_SIGNIN: "1" });
    expect((await s.anon.request("https://okf.example.com/app/sign-in")).status).toBe(503);
    const r = await post(s, "/app/sign-in", { email: "dev@localhost", next: "/app" });
    const html = await r.text();
    expect(html).toContain('id="dev-link"');
    const t = /t=([0-9a-f]{64})/.exec(html)?.[1] ?? "";
    const done = await post(s, "/app/sign-in/link", { t, next: "/app" });
    expect(done.status).toBe(303);
  });

  test("while Access is still configured, a request without a session goes to sign-in", async () => {
    const s = setup();
    Object.assign(s.env, {
      ACCESS_TEAM_DOMAIN: "https://team.cloudflareaccess.com",
      ACCESS_AUD: "aud",
    });
    const r = await s.anon.request("/app/grants");
    expect(r.status).toBe(302);
    expect((await s.app.request("/app/grants")).status).toBe(200);
  });

  test("after sign-in, only a path on this site's /app", () => {
    expect(safeNext("/app/libraries/owner/demo/?at=3")).toBe("/app/libraries/owner/demo/?at=3");
    for (const bad of ["https://evil.example/app", "//evil.example", "/\\evil", "/api/v1", ""]) {
      expect(safeNext(bad)).toBe("/app");
    }
  });
});
