import { describe, expect, test } from "bun:test";
import { sha256Hex } from "../src/format/hash";
import { LINK_MINUTES, SESSION_COOKIE } from "../src/session";
import { ORIGIN, setup, UI } from "./harness";

type S = ReturnType<typeof setup>;
type App = S["app"];

/** A form post to one of the server's own pages (sign-in, the email-change link). */
function post(app: App, path: string, fields: Record<string, string>) {
  return app.request(path, {
    method: "POST",
    headers: { Origin: ORIGIN },
    body: new URLSearchParams(fields),
    redirect: "manual",
  });
}

/** A call to the REST API as the app makes it: JSON, from this site's pages. */
function call(app: App, path: string, method: string, body?: unknown, origin = ORIGIN) {
  return app.request(path, {
    method,
    headers: { Origin: origin, ...(body !== undefined && { "Content-Type": "application/json" }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

/** The page is the app's shell. */
async function shell(app: App, path: string) {
  const r = await app.request(path, { redirect: "manual" });
  expect(r.status).toBe(200);
  expect(await r.text()).toContain('<div id="root"></div>');
}

type Requests = { requests: { actor: string; note: string | null }[] };

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
    const { app, user } = await newcomer(s);
    const home = await app.request("/", { redirect: "manual" });
    expect(home.status).toBe(302);
    expect(home.headers.get("Location")).toBe("/welcome");
    await shell(app, "/welcome");
    // new@example.com: "new" is a route name (v2 spec: Handles), so the suggestion is u-new.
    const me = (await (await app.request("/api/v1/account")).json()) as { handle: string };
    expect(me.handle).toBe("u-new");

    // A taken handle, or a bad library name, is refused.
    const taken = await call(app, "/api/v1/account/handle", "PUT", { handle: "owner" });
    expect(taken.status).toBe(409);
    expect(await taken.text()).toContain("The handle owner is taken.");
    const bad = await call(app, "/api/v1/libraries", "POST", { slug: "Bad Name!" });
    expect(bad.status).toBe(400);
    expect(await s.accounts.libraries(user.id)).toEqual([]);

    // The welcome page: the handle, then the library with its starter note.
    expect((await call(app, "/api/v1/account/handle", "PUT", { handle: "Newbie" })).status).toBe(
      200,
    );
    const done = await call(app, "/api/v1/libraries", "POST", { slug: "notes", starter: true });
    expect(done.status).toBe(201);
    expect(await done.json()).toMatchObject({ owner: "newbie", slug: "notes" });
    expect((await s.accounts.user("new@example.com")).actor).toBe("human:newbie");

    const starter = await text(app.request("/api/v1/libraries/newbie/notes/files/guide.md"));
    expect(starter).toContain("title: Guide");
    const history = await text(app.request("/api/v1/libraries/newbie/notes/history/guide.md"));
    expect(history).toContain("human:newbie");

    // Connect: the app's page; no agent has written yet.
    await shell(app, "/newbie/notes/-/connect");
    await shell(app, "/agents?new=token&library=notes");
    const recent = (await (
      await app.request("/api/v1/libraries/newbie/notes/requests?limit=10")
    ).json()) as Requests;
    expect(recent.requests.every((r) => r.actor.startsWith("human:"))).toBe(true);
  });

  test("a starter note only from the app: a token's new library starts empty", async () => {
    const s = setup();
    const r = await s.anon.request("/api/v1/libraries", {
      method: "POST",
      headers: { Authorization: "Bearer human", "Content-Type": "application/json" },
      body: JSON.stringify({ slug: "plain", starter: true }),
    });
    expect(r.status).toBe(201);
    const files = await s.app.request("/api/v1/libraries/owner/plain/files/guide.md", {
      headers: { Accept: "application/json" },
    });
    expect(files.status).toBe(404);
  });

  test("Connect turns to the agent's first write", async () => {
    const s = setup();
    const agentWrites = async () =>
      (
        (await (
          await s.app.request("/api/v1/libraries/owner/demo/requests?limit=10")
        ).json()) as Requests
      ).requests.filter((r) => !r.actor.startsWith("human:"));
    expect(await agentWrites()).toEqual([]);
    const w = await s.req("/files/a.md", {
      method: "PUT",
      headers: { "Content-Type": "text/markdown", "X-Note": "hello" },
      body: "---\ntype: Note\n---\nhi\n",
    });
    expect(w.status).toBe(200);
    expect((await agentWrites())[0]).toMatchObject({ actor: "claude-code/test", note: "hello" });
  });
});

describe("connect an agent (tempra-dev: v2/onboarding)", () => {
  test("/agents and a library's Connect tab are the app's pages, behind sign-in", async () => {
    const s = setup();
    await shell(s.app, "/agents");
    // Connect an agent, Tokens and Connected apps moved there; a library's tokens open New token.
    for (const [from, to] of <[string, string][]>[
      ["/connect", "/agents"],
      ["/apps", "/agents"],
      ["/tokens", "/agents"],
      ["/tokens?library=owner/demo", "/agents?new=token&library=owner%2Fdemo"],
    ]) {
      const r = await s.app.request(from, { redirect: "manual" });
      expect(r.status).toBe(301);
      expect(r.headers.get("Location")).toBe(to);
    }
    await shell(s.app, `${UI}/-/connect`);
    // Signed out, it asks for sign-in like every other account page.
    const anon = await s.anon.request("/agents", { redirect: "manual" });
    expect(anon.status).toBe(302);
    expect(anon.headers.get("Location")).toBe("/sign-in?next=%2Fagents");
    const stranger = await s.stranger();
    expect((await stranger.app.request(`${UI}/-/connect`)).status).toBe(404);
  });
});

describe("account page (v2 spec: Accounts and sign-in)", () => {
  type Account = {
    email: string;
    handle: string;
    actor: string;
    sessions: { id: string; current: boolean }[];
  };
  const account = async (app: App) =>
    (await (await app.request("/api/v1/account")).json()) as Account;

  test("sessions: this device, and signing out another", async () => {
    const s = setup();
    const other = s.sessionFor("user_1");
    await shell(s.app, "/account");
    const me = await account(s.app);
    expect(me.email).toBe("owner@example.com");
    expect(me.sessions.filter((x) => x.current)).toHaveLength(1);
    expect(me.sessions.find((x) => x.id === sha256Hex(other))).toMatchObject({ current: false });
    const end = (id: string, origin = ORIGIN) =>
      call(s.app, `/api/v1/account/sessions/${id}`, "DELETE", undefined, origin);
    expect((await end(sha256Hex(other), "https://evil.example")).status).toBe(403);
    expect((await end(sha256Hex(other))).status).toBe(204);
    const otherHome = await s.anon.request("/", {
      headers: { Cookie: `${SESSION_COOKIE}=${other}` },
      redirect: "manual",
    });
    expect(otherHome.status).toBe(302);
    // Another account's session id is not ours to end.
    const stranger = await s.stranger();
    const theirs = (await s.sessions.list(stranger.user.id))[0]?.id ?? "";
    await end(theirs);
    expect(await s.sessions.list(stranger.user.id)).toHaveLength(1);
  });

  test("changing the handle moves paths and the actor for future writes", async () => {
    const s = setup();
    const rename = (handle: string) => call(s.app, "/api/v1/account/handle", "PUT", { handle });
    expect((await rename("bad handle")).status).toBe(400);
    const stranger = await s.stranger();
    expect((await rename(stranger.user.handle)).status).toBe(409);

    const r = await rename("renamed");
    expect(r.status).toBe(200);
    expect((await r.json()) as object).toEqual({ handle: "renamed", actor: "human:renamed" });
    // The old handle is held for this account: its URLs redirect (v2 spec: Handles).
    const old = await s.app.request(`${UI}/-/ledger?prefix=x`, { redirect: "manual" });
    expect(old.status).toBe(301);
    expect(old.headers.get("Location")).toBe("/renamed/demo/-/ledger?prefix=x");
    expect((await s.app.request("/renamed/demo/")).status).toBe(200);
    // Future writes from the app carry the new actor.
    const w = await s.app.request("/api/v1/libraries/renamed/demo/files/n.md", {
      method: "PUT",
      headers: { Origin: ORIGIN, "Content-Type": "text/markdown" },
      body: "---\ntype: Note\n---\nn\n",
    });
    expect(w.status).toBeLessThan(300);
    const reqs = (await (
      await s.app.request("/api/v1/libraries/renamed/demo/requests?limit=1")
    ).json()) as Requests;
    expect(reqs.requests[0]?.actor).toBe("human:renamed");
    // The library's tokens follow: their path now carries the new handle.
    const tree = await s.anon.request("/api/v1/libraries/renamed/demo/tree", {
      headers: { Authorization: `Bearer ${(await mintToken(s)).secret}` },
    });
    expect(tree.status).toBe(200);
  });

  test("the account API is the signed-in person's only: tokens, strangers' origins and no session are refused", async () => {
    const s = setup();
    const minted = await s.accounts.createToken({
      libraryId: "lib-1",
      actor: "human:owner",
      scope: "write",
      prefix: null,
      expires: null,
      mcpTiers: "all",
      createdBy: "user_1",
    });
    const routes: [string, string, unknown?][] = [
      ["GET", "/api/v1/account"],
      ["PUT", "/api/v1/account/handle", { handle: "taken-over" }],
      ["POST", "/api/v1/account/email", { email: "evil@example.com" }],
      ["DELETE", "/api/v1/account/sessions/x"],
      ["POST", "/api/v1/account/delete", { confirm: "owner" }],
      ["GET", "/api/v1/apps"],
      ["DELETE", "/api/v1/apps/x"],
    ];
    for (const [method, path, body] of routes) {
      // Even a human: token for this very account never reaches them.
      for (const secret of [minted.secret, "human"]) {
        const r = await s.anon.request(path, {
          method,
          headers: {
            Authorization: `Bearer ${secret}`,
            Origin: ORIGIN,
            "Content-Type": "application/json",
          },
          body: body === undefined ? undefined : JSON.stringify(body),
        });
        expect(r.status).toBe(403);
        expect(((await r.json()) as { code: string }).code).toBe("session_only");
      }
      expect((await call(s.anon, path, method, body)).status).toBe(401);
      if (method !== "GET") {
        expect((await call(s.app, path, method, body, "https://evil.example")).status).toBe(403);
      }
    }
    // Nothing changed.
    expect(await s.accounts.user("owner@example.com")).toMatchObject({
      id: "user_1",
      handle: "owner",
    });
    expect(s.outbox).toEqual([]);
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
    const API = "/api/v1/libraries/owner/demo";
    expect((await call(s.app, `${API}/maintain`, "POST")).status).toBe(200);
    expect([...s.bucket.objects.keys()].some((k) => k.startsWith("exports/lib-1/"))).toBe(true);

    await shell(s.app, `${UI}/-/delete`);
    const del = (confirm: string, origin = ORIGIN) =>
      call(s.app, `${API}/delete`, "POST", { confirm }, origin);
    const wrong = await del("dem");
    expect(wrong.status).toBe(400);
    expect(((await wrong.json()) as { code: string }).code).toBe("not_confirmed");
    expect((await del("demo", "https://evil.example")).status).toBe(403);
    // Only from the app's pages: not even a human: token deletes a library.
    const byToken = await s.anon.request(`${API}/delete`, {
      method: "POST",
      headers: { Authorization: "Bearer human", "Content-Type": "application/json" },
      body: JSON.stringify({ confirm: "demo" }),
    });
    expect(byToken.status).toBe(403);
    // A stranger does not see it.
    const stranger = await s.stranger("other@example.com");
    expect((await call(stranger.app, `${API}/delete`, "POST", { confirm: "demo" })).status).toBe(
      404,
    );
    expect((await s.app.request(`${UI}/`)).status).toBe(200);

    const done = await del("demo");
    expect(done.status).toBe(204);
    expect((await s.app.request(`${UI}/`)).status).toBe(404);
    expect(await s.accounts.libraries("user_1")).toEqual([]);
    // The stranger's tokens (two) are all that is left.
    expect(s.db.query("SELECT COUNT(*) AS n FROM tokens").get()).toEqual({ n: 2 });
    expect([...s.bucket.objects.keys()].some((k) => k.startsWith("exports/lib-1/"))).toBe(false);
    const api = await s.anon.request("/api/v1/libraries/owner/demo/tree", {
      headers: { Authorization: `Bearer ${token.secret}` },
    });
    expect(api.status).toBe(401);
    // With no libraries left, home is the first run again.
    const home = await s.app.request("/", { redirect: "manual" });
    expect(home.headers.get("Location")).toBe("/welcome");
  });

  test("an account: confirm by handle; everything goes but a tombstone", async () => {
    const s = setup();
    const stranger = await s.stranger();
    await shell(s.app, "/account");
    const wrong = await call(s.app, "/api/v1/account/delete", "POST", { confirm: "nope" });
    expect(wrong.status).toBe(400);
    const forged = await call(
      s.app,
      "/api/v1/account/delete",
      "POST",
      { confirm: "owner" },
      "https://evil.example",
    );
    expect(forged.status).toBe(403);

    const done = await call(s.app, "/api/v1/account/delete", "POST", { confirm: "owner" });
    expect(done.status).toBe(204);
    expect(done.headers.get("Set-Cookie")).toContain("Max-Age=0");
    expect(s.db.query("SELECT COUNT(*) AS n FROM users WHERE id = 'user_1'").get()).toEqual({
      n: 0,
    });
    expect(s.db.query("SELECT email_hash FROM deleted_accounts").all()).toEqual([
      { email_hash: sha256Hex("owner@example.com") },
    ]);
    expect((await s.app.request("/", { redirect: "manual" })).status).toBe(302);
    // The stranger's account is untouched.
    expect((await stranger.app.request("/stranger/demo/")).status).toBe(200);
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
    const ask = (email: string) => call(s.app, "/api/v1/account/email", "POST", { email });
    expect((await ask("nope")).status).toBe(400);
    expect((await ask("owner@example.com")).status).toBe(400);
    const asked = await ask("New@Example.org");
    expect(asked.status).toBe(200);
    expect((await asked.json()) as object).toEqual({ sent_to: "new@example.org" });
    const mail = s.outbox.at(-1);
    expect(mail?.to).toBe("new@example.org");
    const t = linkIn(mail?.text ?? "").searchParams.get("t") ?? "";

    // The link cannot sign anyone in: it is for changing the email only.
    const asSignIn = await post(s.anon, "/sign-in/link", { t, next: "/" });
    expect(asSignIn.status).toBe(400);
    // Nor confirm for another account.
    const stranger = await s.stranger();
    expect((await post(stranger.app, "/account/email/confirm", { t })).status).toBe(400);

    // The mail says which account to sign in with first (V-3).
    expect(mail?.text).toContain("Sign in with owner@example.com first");
    expect(mail?.text).toContain(`within ${LINK_MINUTES} minutes`);
    const page = await text(s.app.request(`/account/email/confirm?t=${t}`));
    expect(page).toContain("Confirm your new email");
    expect(page).toContain("<strong>new@example.org</strong>");
    expect(page).toContain('href="/account">Back to Account</a>');
    // Signed in as another account, the page says so and offers to sign out, back to the link.
    const other = await stranger.app.request(`/account/email/confirm?t=${t}`);
    expect(other.status).toBe(403);
    const otherHtml = await other.text();
    expect(otherHtml).toContain("This link is for another account");
    expect(otherHtml).not.toContain("owner@example.com");
    // A post from another site is refused, and the link is not spent by it.
    const forged = await s.app.request("/account/email/confirm", {
      method: "POST",
      headers: { Origin: "https://evil.example" },
      body: new URLSearchParams({ t }),
      redirect: "manual",
    });
    expect(forged.status).toBe(403);
    const done = await post(s.app, "/account/email/confirm", { t });
    expect(done.status).toBe(303);
    expect(done.headers.get("Location")).toBe("/account?done=email");
    expect(s.outbox.at(-1)).toMatchObject({
      to: "owner@example.com",
      subject: "Your Tempra email changed",
    });
    // The account is the same; it signs in with the new address now.
    expect((await s.accounts.user("new@example.org")).id).toBe("user_1");
    expect(
      ((await (await s.app.request("/api/v1/account")).json()) as { email: string }).email,
    ).toBe("new@example.org");
    // A used link is spent.
    expect((await post(s.app, "/account/email/confirm", { t })).status).toBe(400);
  });

  test("opened signed out, the link says to sign in with the current address first (V-3)", async () => {
    const s = setup();
    await call(s.app, "/api/v1/account/email", "POST", { email: "new@example.org" });
    const link = linkIn(s.outbox.at(-1)?.text ?? "");
    const self = link.pathname + link.search;
    const r = await s.anon.request(self, { redirect: "manual" });
    // A page, not a bare redirect to sign-in, where the new address would make a new account.
    expect(r.status).toBe(200);
    const html = await r.text();
    expect(html).toContain("<h1>Sign in first</h1>");
    expect(html).toContain("<strong>new@example.org</strong>");
    expect(html).toContain("not the new one");
    // Never the account's current address to someone not signed in to it.
    expect(html).not.toContain("owner@example.com");
    // Sign-in comes back to the link.
    expect(html).toContain(
      `href="/sign-in?next=${encodeURIComponent(self).replace(/&/g, "&#38;")}"`,
    );
    // Only looking: the link still confirms once signed in.
    const done = await post(s.app, "/account/email/confirm", {
      t: link.searchParams.get("t") ?? "",
    });
    expect(done.status).toBe(303);
    // A used or unknown link says so, signed in or not, with a way on.
    const used = await s.anon.request(self);
    expect(used.status).toBe(400);
    expect(await used.text()).toContain("expired or was already used");
  });

  test("an address another account uses cannot be taken", async () => {
    const s = setup();
    await s.stranger();
    await call(s.app, "/api/v1/account/email", "POST", { email: "stranger@example.com" });
    const t = linkIn(s.outbox.at(-1)?.text ?? "").searchParams.get("t") ?? "";
    const r = await post(s.app, "/account/email/confirm", { t });
    expect(r.status).toBe(409);
    expect((await s.accounts.user("owner@example.com")).id).toBe("user_1");
  });
});

describe("terms and privacy (v2 spec: A3)", () => {
  test("on the landing page; the app's old URLs redirect there, and sign-in links them", async () => {
    const s = setup();
    for (const path of ["/terms", "/privacy"]) {
      const r = await s.anon.request(path, { redirect: "manual" });
      expect(r.status).toBe(301);
      expect(r.headers.get("Location")).toBe(`https://tempra.dev${path}`);
    }
    const signIn = await text(s.anon.request("/sign-in"));
    expect(signIn).toContain('<a href="https://tempra.dev/terms">');
    expect(signIn).toContain('<a href="https://tempra.dev/privacy">');
  });
});

describe("the account's theme (take 4, TEMPRA-113)", () => {
  test("set on the account, read back with /me, and put on the shell's root", async () => {
    const s = setup();
    const theme = async () =>
      ((await (await s.app.request("/api/v1/me")).json()) as { theme: string | null }).theme;
    const root = async (path = "/owner/demo/") =>
      /<html[^>]*>/.exec(await (await s.app.request(path, { redirect: "manual" })).text())?.[0];
    // Never chosen is dark (TEMPRA-285): on the root, and in /me and /account.
    expect(await root()).toBe('<html lang="en" data-theme="dark">');
    expect(await theme()).toBe("dark");
    const account = (await (await s.app.request("/api/v1/account")).json()) as { theme: string };
    expect(account.theme).toBe("dark");
    const light = await call(s.app, "/api/v1/account", "PATCH", { theme: "light" });
    expect(light.status).toBe(200);
    expect((await light.json()) as unknown).toEqual({ theme: "light" });
    expect(await theme()).toBe("light");
    for (const path of ["/", "/owner/demo/", "/owner/demo/a.md", "/agents"]) {
      expect(await root(path)).toBe('<html lang="en" data-theme="light">');
    }
    // System is a choice of its own, kept as such: no attribute, so the system decides.
    const system = await call(s.app, "/api/v1/account", "PATCH", { theme: "system" });
    expect((await system.json()) as unknown).toEqual({ theme: "system" });
    expect(await theme()).toBe("system");
    expect(await root()).toBe('<html lang="en">');
    // Dark as chosen, and null back to the default, which is dark too.
    await call(s.app, "/api/v1/account", "PATCH", { theme: "dark" });
    expect(await root()).toBe('<html lang="en" data-theme="dark">');
    const reset = await call(s.app, "/api/v1/account", "PATCH", { theme: null });
    expect((await reset.json()) as unknown).toEqual({ theme: "dark" });
    expect(await theme()).toBe("dark");
    // A theme that is not one is refused.
    expect((await call(s.app, "/api/v1/account", "PATCH", { theme: "sepia" })).status).toBe(400);
    expect((await call(s.app, "/api/v1/account", "PATCH", { theme: "" })).status).toBe(400);
    expect((await call(s.app, "/api/v1/account", "PATCH", {})).status).toBe(400);
    // Only from the app's pages, as the rest of the account.
    const token = await s.app.request("/api/v1/account", {
      method: "PATCH",
      headers: { Authorization: "Bearer human", "Content-Type": "application/json" },
      body: JSON.stringify({ theme: "dark" }),
    });
    expect(token.status).toBe(403);
  });
});

describe("the account's name (TEMPRA-54)", () => {
  type Named = { name: string | null; handle: string };
  const me = async (s: ReturnType<typeof setup>) =>
    (await (await s.app.request("/api/v1/me")).json()) as Named;
  const account = async (s: ReturnType<typeof setup>) =>
    (await (await s.app.request("/api/v1/account")).json()) as Named;

  test("none at first; set, read back with /me and /account, and cleared", async () => {
    const s = setup();
    expect((await me(s)).name).toBeNull();
    expect((await account(s)).name).toBeNull();
    // Trimmed, runs of spaces made one; the theme left alone.
    const set = await call(s.app, "/api/v1/account", "PATCH", { name: "  Ann   Lee Smith " });
    expect(set.status).toBe(200);
    expect((await set.json()) as unknown).toEqual({ name: "Ann Lee Smith" });
    expect(await me(s)).toMatchObject({ name: "Ann Lee Smith", handle: "owner" });
    expect((await account(s)).name).toBe("Ann Lee Smith");
    // Both at once: each is set.
    const both = await call(s.app, "/api/v1/account", "PATCH", { name: "Ann", theme: "dark" });
    expect((await both.json()) as unknown).toEqual({ name: "Ann", theme: "dark" });
    // Empty or null clears it.
    for (const cleared of ["   ", null]) {
      await call(s.app, "/api/v1/account", "PATCH", { name: "Ann" });
      const r = await call(s.app, "/api/v1/account", "PATCH", { name: cleared });
      expect((await r.json()) as unknown).toEqual({ name: null });
      expect((await me(s)).name).toBeNull();
    }
  });

  test("refused when too long, not text, or holding control characters", async () => {
    const s = setup();
    for (const name of ["x".repeat(81), 42, "Ann\nLee", "Ann\u0000", "Ann Lee"]) {
      const r = await call(s.app, "/api/v1/account", "PATCH", { name });
      expect(r.status).toBe(400);
      expect(((await r.json()) as { code: string }).code).toBe("bad_name");
    }
    // 80 characters, counted as characters, not UTF-16 units.
    expect((await call(s.app, "/api/v1/account", "PATCH", { name: "é".repeat(80) })).status).toBe(
      200,
    );
    expect((await call(s.app, "/api/v1/account", "PATCH", { name: "😀".repeat(80) })).status).toBe(
      200,
    );
    // A refused name leaves the theme unset too.
    await call(s.app, "/api/v1/account", "PATCH", { name: "Ann", theme: "dark" });
    const bad = await call(s.app, "/api/v1/account", "PATCH", { name: 1, theme: "light" });
    expect(bad.status).toBe(400);
    const after = (await (await s.app.request("/api/v1/me")).json()) as Named & { theme: string };
    expect(after).toMatchObject({ name: "Ann", theme: "dark" });
  });

  test("only from the app's pages, never with a token", async () => {
    const s = setup();
    const token = await s.app.request("/api/v1/account", {
      method: "PATCH",
      headers: { Authorization: "Bearer human", "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Mallory" }),
    });
    expect(token.status).toBe(403);
    expect(
      (await call(s.app, "/api/v1/account", "PATCH", { name: "Mallory" }, "https://evil.example"))
        .status,
    ).toBe(403);
    expect((await me(s)).name).toBeNull();
  });

  test("the library's people carry it beside the handle, for their marks", async () => {
    const s = setup();
    await call(s.app, "/api/v1/account", "PATCH", { name: "Ann Lee" });
    const w = await s.req("/files/notes/a.md", {
      method: "PUT",
      token: "human",
      body: "---\ntype: Note\n---\nHi.\n",
    });
    expect(w.status).toBeLessThan(300);
    const r = await s.app.request("/api/v1/libraries/owner/demo/agents");
    const { contributors } = (await r.json()) as {
      contributors: { person: string; person_name: string | null }[];
    };
    expect(contributors.length).toBeGreaterThan(0);
    for (const c of contributors)
      expect(c).toMatchObject({ person: "owner", person_name: "Ann Lee" });
  });
});

describe("a library's title and description (TEMPRA-102, in take 4's General settings)", () => {
  test("the owner sets and clears them; they show in the list; a member reads only", async () => {
    const s = setup();
    const patch = (body: unknown, app = s.app) =>
      call(app, "/api/v1/libraries/owner/demo", "PATCH", body);
    const set = await patch({ title: "The demo", description: "What it is for." });
    expect(set.status).toBe(200);
    expect((await set.json()) as unknown).toEqual({
      title: "The demo",
      description: "What it is for.",
    });
    // A field left out keeps its value; null clears it.
    const keep = await patch({ description: "Changed." });
    expect((await keep.json()) as unknown).toEqual({ title: "The demo", description: "Changed." });
    const list = (await (await s.app.request("/api/v1/libraries")).json()) as {
      libraries: { slug: string; title?: string; description?: string }[];
    };
    expect(list.libraries.find((l) => l.slug === "demo")).toMatchObject({
      title: "The demo",
      description: "Changed.",
    });
    expect((await (await patch({ title: null })).json()) as unknown).toEqual({
      title: null,
      description: "Changed.",
    });
    // Over the limit, or with control characters: refused.
    expect((await patch({ title: "x".repeat(121) })).status).toBe(400);
    expect((await patch({ description: "a\u0007b" })).status).toBe(400);
    // A member cannot; a stranger sees no library.
    const friend = await s.stranger("friend@example.com");
    await s.accounts.share("lib-1", friend.user.id, "write", "user_1");
    expect((await patch({ title: "Mine" }, friend.app)).status).toBe(403);
    const other = await s.stranger("other@example.com");
    expect((await patch({ title: "Mine" }, other.app)).status).toBe(404);
    // Not with a token, even a human: one.
    const token = await s.app.request("/api/v1/libraries/owner/demo", {
      method: "PATCH",
      headers: { Authorization: "Bearer human", "Content-Type": "application/json" },
      body: JSON.stringify({ title: "Mine" }),
    });
    expect(token.status).toBe(403);
  });
});
