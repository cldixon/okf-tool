import { describe, expect, test } from "bun:test";
import { sha256Hex } from "../src/okf/hash";
import { SESSION_COOKIE } from "../src/session";
import { ORIGIN, setup, UI } from "./harness";

type S = ReturnType<typeof setup>;
type App = S["app"];

function post(app: App, path: string, fields: Record<string, string>) {
  return app.request(path, {
    method: "POST",
    headers: { Origin: ORIGIN },
    body: new URLSearchParams(fields),
    redirect: "manual",
  });
}

const text = async (r: Response | Promise<Response>) => (await r).text();

/** A fresh account, signed in, with no libraries yet. */
async function newcomer(s: S, email = "new@example.com") {
  const user = await s.accounts.user(email);
  const app = { request: s.anon.request };
  const cookie = `${SESSION_COOKIE}=${s.sessionFor(user.id)}`;
  const as: App = {
    request: (input, init) => {
      const headers = new Headers(init?.headers);
      headers.set("Cookie", cookie);
      return app.request(input, { ...init, headers });
    },
  };
  return { user, app: as };
}

describe("first run (v2 spec: Onboarding)", () => {
  test("no libraries: welcome, pick a handle and a library, land on Connect", async () => {
    const s = setup();
    const { app } = await newcomer(s);
    const home = await app.request("/app", { redirect: "manual" });
    expect(home.status).toBe(302);
    expect(home.headers.get("Location")).toBe("/app/welcome");
    const page = await text(app.request("/app/welcome"));
    expect(page).toContain('name="handle" value="new"');
    expect(page).toContain('name="library" value="notes"');
    expect(page).not.toContain("<style");

    // A taken handle, or a bad library name, keeps the form.
    const taken = await post(app, "/app/welcome", { handle: "owner", library: "notes" });
    expect(taken.status).toBe(409);
    expect(await taken.text()).toContain("The handle owner is taken.");
    const bad = await post(app, "/app/welcome", { handle: "new", library: "Bad Name!" });
    expect(bad.status).toBe(400);

    const done = await post(app, "/app/welcome", {
      handle: "Newbie",
      library: "notes",
      starter: "1",
    });
    expect(done.status).toBe(303);
    expect(done.headers.get("Location")).toBe("/app/libraries/newbie/notes/connect");
    expect((await s.accounts.user("new@example.com")).actor).toBe("human:newbie");

    const starter = await text(app.request("/app/libraries/newbie/notes/files/start-here.md"));
    expect(starter).toContain("Start here");
    expect(starter).toContain("human:newbie");

    const connect = await text(app.request("/app/libraries/newbie/notes/connect"));
    expect(connect).toContain("<pre>http://localhost/mcp</pre>");
    expect(connect).toContain("claude mcp add --transport http okf http://localhost/mcp");
    expect(connect).toContain('href="/app/tokens?library=notes"');
    expect(connect).toContain("No agent has written yet.");
    // The token form opens on that library.
    expect(await text(app.request("/app/tokens?library=notes"))).toContain(
      '<option value="notes" selected>',
    );
  });

  test("Connect turns to the agent's first write", async () => {
    const s = setup();
    const before = await text(s.app.request(`${UI}/connect`));
    expect(before).toContain("No agent has written yet.");
    const w = await s.req("/files/a.md", {
      method: "PUT",
      headers: { "Content-Type": "text/markdown", "X-Note": "hello" },
      body: "---\ntype: Note\n---\nhi\n",
    });
    expect(w.status).toBe(200);
    const after = await text(s.app.request(`${UI}/connect`));
    expect(after).toContain("Last agent write: claude-code/test");
    expect(after).toContain('"hello"');
  });
});

describe("account page (v2 spec: Accounts and sign-in)", () => {
  test("sessions: this device, and signing out another", async () => {
    const s = setup();
    const other = s.sessionFor("user_1");
    const page = await text(s.app.request("/app/account"));
    expect(page).toContain("owner@example.com");
    expect(page).toContain("this device");
    expect(page).toContain(sha256Hex(other));
    const ended = await post(s.app, "/app/account/sessions/end", { id: sha256Hex(other) });
    expect(ended.status).toBe(303);
    const otherHome = await s.anon.request("/app", {
      headers: { Cookie: `${SESSION_COOKIE}=${other}` },
      redirect: "manual",
    });
    expect(otherHome.status).toBe(302);
    // Another account's session id is not ours to end.
    const stranger = await s.stranger();
    const theirs = (await s.sessions.list(stranger.user.id))[0]?.id ?? "";
    await post(s.app, "/app/account/sessions/end", { id: theirs });
    expect(await s.sessions.list(stranger.user.id)).toHaveLength(1);
  });

  test("changing the handle moves paths and the actor for future writes", async () => {
    const s = setup();
    expect((await post(s.app, "/app/account/handle", { handle: "bad handle" })).status).toBe(400);
    const stranger = await s.stranger();
    const taken = await post(s.app, "/app/account/handle", { handle: stranger.user.handle });
    expect(taken.status).toBe(409);

    const r = await post(s.app, "/app/account/handle", { handle: "renamed" });
    expect(r.status).toBe(200);
    expect(await r.text()).toContain("Actor: human:renamed");
    expect((await s.app.request(`${UI}/`)).status).toBe(404);
    expect((await s.app.request("/app/libraries/renamed/demo/")).status).toBe(200);
    // The library's tokens follow: their path now carries the new handle.
    const tree = await s.anon.request("/api/v1/libraries/renamed/demo/tree", {
      headers: { Authorization: `Bearer ${(await mintToken(s)).secret}` },
    });
    expect(tree.status).toBe(200);
  });
});

async function mintToken(s: S) {
  const lib = (await s.accounts.libraries("user_1"))[0];
  if (!lib) throw new Error("no library");
  return s.accounts.createToken({
    libraryId: lib.id,
    actor: "claude-code/x",
    scope: "write",
    prefix: null,
    expires: null,
    mcpTiers: "all",
    createdBy: "user_1",
  });
}

describe("deleting (v2 spec: A2)", () => {
  test("a library: confirm by name; rows, tokens, storage and exports go", async () => {
    const s = setup();
    const token = await mintToken(s);
    await s.req("/files/a.md", {
      method: "PUT",
      headers: { "Content-Type": "text/markdown" },
      body: "---\ntype: Note\n---\nhi\n",
    });
    await post(s.app, `${UI}/maintain`, {});
    expect([...s.bucket.objects.keys()].some((k) => k.startsWith("exports/lib-1/"))).toBe(true);

    const page = await text(s.app.request(`${UI}/delete`));
    expect(page).toContain("Type demo to confirm");
    const wrong = await post(s.app, `${UI}/delete`, { confirm: "dem" });
    expect(wrong.status).toBe(400);
    expect((await s.app.request(`${UI}/`)).status).toBe(200);

    const done = await post(s.app, `${UI}/delete`, { confirm: "demo" });
    expect(done.status).toBe(303);
    expect((await s.app.request(`${UI}/`)).status).toBe(404);
    expect(await s.accounts.libraries("user_1")).toEqual([]);
    expect(s.db.query("SELECT COUNT(*) AS n FROM tokens").get()).toEqual({ n: 0 });
    expect([...s.bucket.objects.keys()].some((k) => k.startsWith("exports/lib-1/"))).toBe(false);
    const api = await s.anon.request("/api/v1/libraries/owner/demo/tree", {
      headers: { Authorization: `Bearer ${token.secret}` },
    });
    expect(api.status).toBe(401);
    // With no libraries left, home is the first run again.
    const home = await s.app.request("/app", { redirect: "manual" });
    expect(home.headers.get("Location")).toBe("/app/welcome");
  });

  test("an account: confirm by handle; everything goes but a tombstone", async () => {
    const s = setup();
    const stranger = await s.stranger();
    const wrong = await post(s.app, "/app/account/delete", { confirm: "nope" });
    expect(wrong.status).toBe(400);

    const done = await post(s.app, "/app/account/delete", { confirm: "owner" });
    expect(done.status).toBe(200);
    expect(done.headers.get("Set-Cookie")).toContain("Max-Age=0");
    expect(await done.text()).toContain("Account deleted");
    expect(s.db.query("SELECT COUNT(*) AS n FROM users WHERE id = 'user_1'").get()).toEqual({
      n: 0,
    });
    expect(s.db.query("SELECT email_hash FROM deleted_accounts").all()).toEqual([
      { email_hash: sha256Hex("owner@example.com") },
    ]);
    expect((await s.app.request("/app", { redirect: "manual" })).status).toBe(302);
    // The stranger's account is untouched.
    expect((await stranger.app.request("/app/libraries/stranger/demo/")).status).toBe(200);
    // Signing in again starts a new, empty account.
    const again = await s.accounts.user("owner@example.com");
    expect(again.id).not.toBe("user_1");
    expect(await s.accounts.libraries(again.id)).toEqual([]);
  });
});

describe("changing the email (v2 spec: A3)", () => {
  const linkIn = (text: string) => new URL(/https?:\/\/\S+/.exec(text)?.[0] ?? "");

  test("a link to the new address confirms it; the old address is told", async () => {
    const s = setup();
    const bad = await post(s.app, "/app/account/email", { email: "nope" });
    expect(bad.status).toBe(400);
    const asked = await post(s.app, "/app/account/email", { email: "New@Example.org" });
    expect(asked.status).toBe(200);
    expect(await asked.text()).toContain("Check new@example.org for a link.");
    const mail = s.outbox.at(-1);
    expect(mail?.to).toBe("new@example.org");
    const t = linkIn(mail?.text ?? "").searchParams.get("t") ?? "";

    // The link cannot sign anyone in: it is for changing the email only.
    const asSignIn = await post(s.anon, "/app/sign-in/link", { t, next: "/app" });
    expect(asSignIn.status).toBe(400);
    // Nor confirm for another account.
    const stranger = await s.stranger();
    expect((await post(stranger.app, "/app/account/email/confirm", { t })).status).toBe(400);

    const page = await text(s.app.request(`/app/account/email/confirm?t=${t}`));
    expect(page).toContain("Confirm your new email");
    const done = await post(s.app, "/app/account/email/confirm", { t });
    expect(done.status).toBe(200);
    expect(await done.text()).toContain("Your email is now new@example.org.");
    expect(s.outbox.at(-1)).toMatchObject({
      to: "owner@example.com",
      subject: "Your OKF email changed",
    });
    // The account is the same; it signs in with the new address now.
    expect((await s.accounts.user("new@example.org")).id).toBe("user_1");
    // A used link is spent.
    expect((await post(s.app, "/app/account/email/confirm", { t })).status).toBe(400);
  });

  test("an address another account uses cannot be taken", async () => {
    const s = setup();
    await s.stranger();
    await post(s.app, "/app/account/email", { email: "stranger@example.com" });
    const t = linkIn(s.outbox.at(-1)?.text ?? "").searchParams.get("t") ?? "";
    const r = await post(s.app, "/app/account/email/confirm", { t });
    expect(r.status).toBe(409);
    expect((await s.accounts.user("owner@example.com")).id).toBe("user_1");
  });
});

describe("terms and privacy (v2 spec: A3)", () => {
  test("plain public pages, linked from sign-in and the account page", async () => {
    const s = setup();
    for (const path of ["/terms", "/privacy"]) {
      const r = await s.anon.request(path);
      const html = await r.text();
      expect(r.status).toBe(200);
      expect(html).not.toContain("<script");
      expect(html).not.toContain("<style");
    }
    expect(await text(s.anon.request("/terms"))).toContain("Draft.");
    expect(await text(s.anon.request("/app/sign-in"))).toContain('<a href="/privacy">');
    expect(await text(s.app.request("/app/account"))).toContain('<a href="/terms">');
  });
});
