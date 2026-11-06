import { describe, expect, test } from "bun:test";
import { SESSION_COOKIE } from "../src/session";
import { API, ORIGIN, setup } from "./harness";

type S = ReturnType<typeof setup>;
type App = S["app"];

/** The app's API as its pages call it: JSON, from this site. */
const call = (app: App, path: string, method = "GET", body?: unknown) =>
  app.request(path, {
    method,
    headers: { Origin: ORIGIN, "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

const invite = (s: S, to: string, role = "read") =>
  call(s.app, `${API}/invitations`, "POST", { to, role });

type Pending = { id: string; owner: string; slug: string; role: string; handle: string };

async function pending(app: App): Promise<Pending[]> {
  const r = await call(app, "/api/v1/invitations");
  expect(r.status).toBe(200);
  return ((await r.json()) as { invitations: Pending[] }).invitations;
}

describe("invitations (tempra-dev: v2/sharing, TEMPRA-61)", () => {
  test("the owner invites an account; it accepts and becomes a member", async () => {
    const s = setup();
    const friend = await s.stranger("friend@example.com");
    expect((await call(friend.app, `${API}/tree`)).status).toBe(404);

    const sent = await invite(s, "@friend", "write");
    expect(sent.status).toBe(202);
    expect((await sent.json()) as unknown).toEqual({ sent: "invited", handle: "friend" });
    const mail = s.outbox.at(-1);
    expect(mail?.to).toBe("friend@example.com");
    expect(mail?.subject).toBe("@owner invited you to owner/demo on Tempra");
    expect(mail?.text).toContain("/invitations");

    // Invited is not yet in: the library stays a 404 until they accept.
    expect((await call(friend.app, `${API}/tree`)).status).toBe(404);
    const [inv] = await pending(friend.app);
    // The title too, for the invitee to see the library by its name (TEMPRA-300); demo has none.
    expect(inv).toMatchObject({
      owner: "owner",
      slug: "demo",
      title: null,
      role: "write",
      handle: "owner",
    });

    const owners = (await (await call(s.app, `${API}/members`)).json()) as {
      invitations: Pending[];
    };
    expect(owners.invitations.map((i) => i.handle)).toEqual(["friend"]);

    const accepted = await call(friend.app, `/api/v1/invitations/${inv?.id}/accept`, "POST");
    expect(accepted.status).toBe(200);
    expect(await accepted.json()).toMatchObject({ owner: "owner", slug: "demo", accepted: true });
    expect((await call(friend.app, `${API}/tree`)).status).toBe(200);
    expect(await pending(friend.app)).toEqual([]);
    const after = (await (await call(friend.app, `${API}/members`)).json()) as {
      owner: string;
      role: string;
      members: { handle: string; role: string }[];
      invitations?: unknown;
    };
    expect(after).toMatchObject({ owner: "owner", role: "write" });
    expect(after.members).toMatchObject([{ handle: "friend", role: "write" }]);
    // Members see who is in, not the owner's pending invitations.
    expect(after.invitations).toBeUndefined();
  });

  test("an email with no account is answered the same, and nothing is sent", async () => {
    const s = setup();
    await s.stranger("friend@example.com");
    const before = s.outbox.length;
    const nobody = await invite(s, "nobody@example.com");
    const someone = await invite(s, "friend@example.com");
    expect(nobody.status).toBe(202);
    expect(someone.status).toBe(202);
    expect((await nobody.json()) as unknown).toEqual(await someone.json());
    expect(s.outbox.slice(before).map((m) => m.to)).toEqual(["friend@example.com"]);
    // A handle is public (it is in every URL), so an unknown one is said plainly.
    expect((await invite(s, "@nobody")).status).toBe(404);
  });

  test("decline, withdraw, expiry and renewal", async () => {
    const s = setup();
    const friend = await s.stranger("friend@example.com");
    await invite(s, "@friend");
    let [inv] = await pending(friend.app);
    expect((await call(friend.app, `/api/v1/invitations/${inv?.id}/decline`, "POST")).status).toBe(
      200,
    );
    expect((await call(friend.app, `/api/v1/invitations/${inv?.id}/accept`, "POST")).status).toBe(
      404,
    );
    expect((await call(friend.app, `${API}/tree`)).status).toBe(404);

    // The owner withdraws a new one before it is answered.
    await invite(s, "@friend");
    [inv] = await pending(friend.app);
    expect((await call(s.app, `${API}/invitations/${inv?.id}`, "DELETE")).status).toBe(204);
    expect(await pending(friend.app)).toEqual([]);

    // Inviting again while one is pending renews it (new role), without another email.
    await invite(s, "@friend");
    const mails = s.outbox.length;
    await invite(s, "@friend", "write");
    expect(s.outbox.length).toBe(mails);
    [inv] = await pending(friend.app);
    expect(inv?.role).toBe("write");

    // Expired: no longer listed or accepted.
    s.db.run("UPDATE library_invitations SET expires = ? WHERE id = ?", [
      new Date(Date.now() - 1000).toISOString(),
      inv?.id ?? "",
    ]);
    expect(await pending(friend.app)).toEqual([]);
    expect((await call(friend.app, `/api/v1/invitations/${inv?.id}/accept`, "POST")).status).toBe(
      404,
    );
  });

  test("only the invited account can answer; only the owner invites, from the app", async () => {
    const s = setup();
    const friend = await s.stranger("friend@example.com");
    const other = await s.stranger("other@example.com");
    await invite(s, "@friend", "write");
    const [inv] = await pending(friend.app);
    expect((await call(other.app, `/api/v1/invitations/${inv?.id}/accept`, "POST")).status).toBe(
      404,
    );
    const forged = await friend.app.request(`/api/v1/invitations/${inv?.id}/accept`, {
      method: "POST",
      headers: { Origin: "https://evil.example" },
    });
    expect(forged.status).toBe(403);
    await call(friend.app, `/api/v1/invitations/${inv?.id}/accept`, "POST");

    // A write member cannot invite or manage; a human: token cannot either.
    const byMember = await call(friend.app, `${API}/invitations`, "POST", {
      to: "@other",
      role: "read",
    });
    expect(byMember.status).toBe(403);
    const byToken = await s.req("/invitations", {
      method: "POST",
      token: "human",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ to: "@other", role: "read" }),
    });
    expect(byToken.status).toBe(403);
    expect((await call(friend.app, `${API}/members/friend`, "PUT", { role: "read" })).status).toBe(
      403,
    );

    // Already a member, or the owner: refused.
    expect((await invite(s, "@friend")).status).toBe(409);
    expect((await invite(s, "@owner")).status).toBe(409);
  });

  test("the owner changes a role or removes a member; a member leaves", async () => {
    const s = setup();
    const friend = await s.stranger("friend@example.com");
    await s.accounts.share("lib-1", friend.user.id, "write", "user_1");
    const changed = await call(s.app, `${API}/members/friend`, "PUT", { role: "read" });
    expect(changed.status).toBe(200);
    expect(await s.accounts.memberRole("lib-1", friend.user.id)).toBe("read");
    expect((await call(s.app, `${API}/members/nobody`, "DELETE")).status).toBe(404);
    expect((await call(s.app, `${API}/members/friend`, "DELETE")).status).toBe(204);
    expect((await call(friend.app, `${API}/tree`)).status).toBe(404);

    await s.accounts.share("lib-1", friend.user.id, "read", "user_1");
    expect((await call(friend.app, `${API}/members/friend`, "DELETE")).status).toBe(204);
    expect(await s.accounts.memberRole("lib-1", friend.user.id)).toBeNull();
  });

  test("someone with only a shared library lands on their library list, not first run", async () => {
    const s = setup();
    const user = await s.accounts.user("invited@example.com");
    const session = s.sessionFor(user.id);
    const home = () => s.anon.request("/", { headers: { Cookie: `${SESSION_COOKIE}=${session}` } });
    const before = await home();
    expect(before.status).toBe(302);
    await s.accounts.share("lib-1", user.id, "read", "user_1");
    expect((await home()).status).toBe(200);
  });

  test("a library sends a limited number of invitations a day", async () => {
    const s = setup();
    for (let i = 0; i < 20; i++) {
      const p = await s.stranger(`p${i}@example.com`);
      expect((await invite(s, `@${p.user.handle}`)).status).toBe(202);
    }
    const last = await s.stranger("late@example.com");
    const over = await invite(s, `@${last.user.handle}`);
    expect(over.status).toBe(429);
    expect(await over.text()).toContain("too_many_invitations");
  });
});
