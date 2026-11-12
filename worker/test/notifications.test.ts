import { describe, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { resolveMentions } from "../src/notify";
import { composeBatch, flushMail, MAX_WAIT_MS, QUIET_MS } from "../src/notify-mail";
import { API, LIB, ORIGIN, OWNER, setup } from "./harness";

type S = ReturnType<typeof setup>;
type App = S["app"];
type Text = { type: "text"; text: string };

/** The app's API as its pages call it: JSON, from this site. */
const call = (app: App, path: string, method = "GET", body?: unknown) =>
  app.request(path, {
    method,
    headers: { Origin: ORIGIN, "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

const doc = (title: string) =>
  `---\ntype: Metric\ntitle: ${title}\ndescription: A metric.\n---\n# ${title}\n\nRevenue minus cost.\n`;

interface InboxItem {
  id: string;
  kind: string;
  place: string;
  path: string | null;
  thread: string | null;
  actor: string;
  excerpt: string;
  href: string;
  read_at: string | null;
  done_at: string | null;
}

async function inbox(app: App, all = false) {
  const r = await call(app, `/api/v1/inbox${all ? "?all=1" : ""}`);
  expect(r.status).toBe(200);
  return (await r.json()) as { items: InboxItem[]; open: number };
}

/** The owner's library, shared with a friend at `role`; plus an agent token of the owner's. */
async function shared(role: "read" | "write" = "write") {
  const s = setup();
  const friend = await s.stranger("friend@example.com");
  await s.accounts.share(LIB.id, friend.user.id, role, OWNER.id);
  const agent = await s.accounts.createToken({
    libraryId: LIB.id,
    actor: "claude-code/laptop",
    scope: "write",
    prefix: null,
    expires: null,
    mcpTiers: "all",
    createdBy: OWNER.id,
  });
  return { s, friend, agent: agent.secret };
}

/** Writes a page as the signed-in person of `app`. */
async function write(app: App, path: string) {
  const r = await app.request(`${API}/files/${path}`, {
    method: "PUT",
    headers: { Origin: ORIGIN, "Content-Type": "text/markdown", "X-Note": "test" },
    body: doc(path),
  });
  expect(r.status).toBeLessThan(300);
}

async function open(app: App, path: string, body: string) {
  const r = await call(app, `${API}/comments`, "POST", { path, body });
  expect(r.status).toBe(201);
  return ((await r.json()) as { thread: { id: string } }).thread.id;
}

describe("mentions (TEMPRA-73)", () => {
  const people = [
    { id: "u1", handle: "ann" },
    { id: "u2", handle: "bo_b" },
  ];

  test("resolves handles of people who reach the library, once each", () => {
    expect(resolveMentions("@ann and @Bo_B, also @ann again.", people)).toEqual([
      { user: "u1", handle: "ann" },
      { user: "u2", handle: "bo_b" },
    ]);
  });

  test("ignores outsiders, emails, paths and the middle of words", () => {
    expect(resolveMentions("@zed ann@ann.com /x/@ann a@ann x.@ann", people)).toEqual([]);
  });

  test("names a managed agent when one is listed (the hook TEMPRA-69 uses)", () => {
    expect(resolveMentions("@curator please", people, [{ id: "a1", name: "curator" }])).toEqual([
      { agent: "a1", name: "curator" },
    ]);
  });

  test("a mention is stored with the comment and reaches the person's inbox", async () => {
    const { s, friend } = await shared();
    await write(s.app, "metrics/margin.md");
    const r = await call(friend.app, `${API}/comments`, "POST", {
      path: "metrics/margin.md",
      body: "@owner is this still right? cc @nobody",
    });
    expect(r.status).toBe(201);
    const { thread } = (await r.json()) as {
      thread: { id: string; comments: { mentions?: string[] }[] };
    };
    expect(thread.comments[0]?.mentions).toEqual(["@owner"]);
    const { items, open } = await inbox(s.app);
    expect(open).toBe(1);
    expect(items[0]).toMatchObject({
      kind: "mention",
      place: "owner/demo",
      path: "metrics/margin.md",
      thread: thread.id,
      actor: "human:friend",
      excerpt: "@owner is this still right? cc @nobody",
      href: "/owner/demo/metrics/margin.md#comments",
    });
  });

  test("mentioning someone outside the library does nothing and reveals nothing", async () => {
    const { s, friend } = await shared();
    const outsider = await s.stranger("outsider@example.com");
    await write(s.app, "metrics/margin.md");
    const post = async (body: string) => {
      const r = await call(s.app, `${API}/comments`, "POST", { path: "metrics/margin.md", body });
      expect(r.status).toBe(201);
      const j = (await r.json()) as { thread: { comments: { mentions?: string[] }[] } };
      return j.thread.comments[0]?.mentions ?? null;
    };
    // An existing account outside the library and a handle nobody has read the same.
    expect(await post("@outsider have a look")).toBeNull();
    expect(await post("@nosuchhandle have a look")).toBeNull();
    expect((await inbox(outsider.app)).items).toEqual([]);
    expect((await post("@friend have a look")) ?? []).toEqual(["@friend"]);
    expect((await inbox(friend.app)).items.map((i) => i.kind)).toEqual(["mention"]);
  });

  test("agents mention over MCP, and `comments` says who was mentioned", async () => {
    const { s, friend, agent } = await shared();
    await write(s.app, "metrics/margin.md");
    const transport = new StreamableHTTPClientTransport(new URL("http://localhost/mcp"), {
      requestInit: { headers: { Authorization: `Bearer ${agent}` } },
      fetch: async (url, init) => s.app.request(url.toString(), init as RequestInit),
    });
    const client = new Client({ name: "test", version: "1.0.0" });
    await client.connect(transport);
    const tool = async (name: string, args: Record<string, unknown>) => {
      const r = await client.callTool({ name, arguments: args });
      return (r.content as Text[]).map((c) => c.text).join("\n");
    };
    expect(
      await tool("comment", {
        action: "open",
        path: "metrics/margin.md",
        body: "@friend can you confirm the source?",
      }),
    ).toContain("Opened thread");
    expect(await tool("comments", { path: "metrics/margin.md" })).toContain("(mentioned @friend)");
    const items = (await inbox(friend.app)).items;
    expect(items).toMatchObject([{ kind: "mention", actor: "claude-code/laptop" }]);
  });
});

describe("the inbox (TEMPRA-72)", () => {
  test("a reply reaches who took part; the actor in person is never told of their own", async () => {
    const { s, friend } = await shared();
    await write(s.app, "metrics/margin.md");
    const id = await open(s.app, "metrics/margin.md", "Is this right?");
    // The owner wrote the page: a thread they open themselves tells nobody.
    expect((await inbox(s.app)).items).toEqual([]);
    expect((await call(friend.app, `${API}/comments/${id}`, "POST", { body: "Yes." })).status).toBe(
      200,
    );
    expect((await inbox(s.app)).items).toMatchObject([
      { kind: "reply", actor: "human:friend", excerpt: "Yes." },
    ]);
    expect((await inbox(friend.app)).items).toEqual([]);
    // The owner answers: the friend took part, so they hear of it.
    await call(s.app, `${API}/comments/${id}`, "POST", { body: "Thanks." });
    expect((await inbox(friend.app)).items).toMatchObject([{ kind: "reply", excerpt: "Thanks." }]);
    // A resolve without a body is not news; it closes the thread's items for everyone
    // (TEMPRA-116), and reopening does not open them again.
    await call(friend.app, `${API}/comments/${id}/resolve`, "POST");
    expect((await inbox(s.app)).items).toEqual([]);
    expect((await inbox(friend.app)).items).toEqual([]);
    const done = (await inbox(s.app, true)).items;
    expect(done).toHaveLength(1);
    expect(done[0]?.done_at).not.toBeNull();
    await call(friend.app, `${API}/comments/${id}/reopen`, "POST");
    expect((await inbox(s.app)).items).toEqual([]);
  });

  test("the person's own agent replying does tell them", async () => {
    const { s, agent } = await shared();
    await write(s.app, "metrics/margin.md");
    const id = await open(s.app, "metrics/margin.md", "Please add the source.");
    const r = await s.req(`/comments/${id}/resolve`, {
      method: "POST",
      token: agent,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ body: "Added." }),
    });
    expect(r.status).toBe(200);
    // The answer is news, and the resolve that carries it closes it at once (TEMPRA-116).
    expect((await inbox(s.app)).items).toEqual([]);
    expect((await inbox(s.app, true)).items).toMatchObject([
      { kind: "reply", actor: "claude-code/laptop", excerpt: "Added." },
    ]);
  });

  test("a new thread tells no one but whom it mentions (TEMPRA-173)", async () => {
    const { s, friend } = await shared();
    await write(friend.app, "notes/plan.md");
    await open(s.app, "notes/plan.md", "Can we split this?");
    expect((await inbox(friend.app)).items).toEqual([]);
    await open(s.app, "notes/plan.md", "@friend and this?");
    expect((await inbox(friend.app)).items).toMatchObject([
      { kind: "mention", path: "notes/plan.md", excerpt: "@friend and this?" },
    ]);
    // Removed from the library: no more items from it.
    await s.accounts.unshare(LIB.id, friend.user.id);
    await open(s.app, "notes/plan.md", "@friend once more");
    expect((await inbox(friend.app)).items).toHaveLength(1);
  });

  test("one state: an item is done once opened; the count is what waits (TEMPRA-189)", async () => {
    const { s, friend } = await shared();
    await write(s.app, "a.md");
    const id = await open(s.app, "a.md", "One");
    await call(friend.app, `${API}/comments/${id}`, "POST", { body: "reply 1" });
    await call(friend.app, `${API}/comments/${id}`, "POST", { body: "reply 2" });
    const { items } = await inbox(s.app);
    expect(items.map((i) => i.excerpt)).toEqual(["reply 2", "reply 1"]);
    const count = async () => (await (await call(s.app, "/api/v1/inbox/count")).json()) as unknown;
    expect(await count()).toEqual({ open: 2 });

    // Opening one marks it done: it leaves what waits and joins Earlier (`?done=1`).
    const [newest, oldest] = items;
    expect((await call(s.app, `/api/v1/inbox/${oldest?.id}/done`, "POST")).status).toBe(200);
    expect(await count()).toEqual({ open: 1 });
    const after = await inbox(s.app);
    expect(after.items.map((i) => i.excerpt)).toEqual(["reply 2"]);
    expect(after.open).toBe(1);
    const earlier = (await (await call(s.app, "/api/v1/inbox?done=1")).json()) as {
      items: InboxItem[];
    };
    expect(earlier.items.map((i) => i.id)).toEqual([String(oldest?.id)]);
    expect(earlier.items[0]?.done_at).not.toBeNull();
    expect((await inbox(s.app, true)).items).toHaveLength(2);
    void newest;
    // Another person's item is theirs alone; there is no read state to mark any more.
    expect((await call(friend.app, `/api/v1/inbox/${oldest?.id}/done`, "POST")).status).toBe(404);
    expect((await call(s.app, "/api/v1/inbox/read", "POST", {})).status).toBe(404);
    // Tokens never read the inbox.
    expect(
      (await s.anon.request("/api/v1/inbox", { headers: { Authorization: "Bearer human" } }))
        .status,
    ).toBe(403);
  });

  test("an invitation is an inbox item, done once answered; access changes are not items", async () => {
    const s = setup();
    const friend = await s.stranger("friend@example.com");
    expect(
      (await call(s.app, `${API}/invitations`, "POST", { to: "@friend", role: "read" })).status,
    ).toBe(202);
    const { items } = await inbox(friend.app);
    expect(items).toMatchObject([
      { kind: "invitation", place: "owner/demo", href: "/invitations" },
    ]);
    const inv = (await (await call(friend.app, "/api/v1/invitations")).json()) as {
      invitations: { id: string }[];
    };
    await call(friend.app, `/api/v1/invitations/${inv.invitations[0]?.id}/accept`, "POST");
    expect((await inbox(friend.app)).items).toEqual([]);
    // An access change tells no one (TEMPRA-173): the library's list shows the new role.
    await call(s.app, `${API}/members/friend`, "PUT", { role: "write" });
    expect((await inbox(friend.app)).items).toEqual([]);
    await call(s.app, `${API}/members/friend`, "DELETE");
    expect((await inbox(friend.app)).items).toEqual([]);
  });

  // The Inbox page's calls (TEMPRA-130): the library filter, Accept from a row.
  test("the library filter lists one library's items", async () => {
    const { s, friend } = await shared();
    // The friend's thread on the owner's library, answered by the owner: a reply in owner/demo.
    await write(s.app, "a.md");
    const id = await open(friend.app, "a.md", "A question");
    await call(s.app, `${API}/comments/${id}`, "POST", { body: "An answer" });
    // The owner mentions the friend on the friend's own library: a mention in friend/demo.
    await s.accounts.share(friend.lib.id, OWNER.id, "read", friend.user.id);
    const theirs = "/api/v1/libraries/friend/demo";
    const put = await friend.app.request(`${theirs}/files/b.md`, {
      method: "PUT",
      headers: { Origin: ORIGIN, "Content-Type": "text/markdown", "X-Note": "test" },
      body: doc("b"),
    });
    expect(put.status).toBeLessThan(300);
    expect(
      (await call(s.app, `${theirs}/comments`, "POST", { path: "b.md", body: "@friend Hello" }))
        .status,
    ).toBe(201);
    expect((await inbox(friend.app)).items.map((i) => i.kind).sort()).toEqual(["mention", "reply"]);
    const one = (await (await call(friend.app, "/api/v1/inbox?library=owner/demo")).json()) as {
      items: InboxItem[];
      open: number;
    };
    expect(one.items.map((i) => i.kind)).toEqual(["reply"]);
    expect(one.open).toBe(1);
  });

  test("accepting from the Inbox row adds the library; a dismissed item leaves the library's list", async () => {
    const s = setup();
    const friend = await s.stranger("friend@example.com");
    await call(s.app, `${API}/invitations`, "POST", { to: "@friend", role: "write" });
    const row = (await (await call(friend.app, "/api/v1/inbox")).json()) as {
      items: { kind: string; invitation: string | null; actions: string[] }[];
    };
    const item = row.items.find((i) => i.kind === "invitation");
    expect(item?.actions).toEqual(["accept", "decline"]);
    expect(
      (await call(friend.app, `/api/v1/invitations/${item?.invitation}/accept`, "POST")).status,
    ).toBe(200);
    // The switcher's list (GET /api/v1/libraries) now has it, with the role.
    const libs = (await (await call(friend.app, "/api/v1/libraries")).json()) as {
      libraries: { owner: string; slug: string; role?: string }[];
    };
    expect(libs.libraries).toContainEqual(
      expect.objectContaining({ owner: "owner", slug: "demo", role: "write" }),
    );
    // Done in the Inbox, gone from the library's open items (the home's For you here).
    await write(s.app, "c.md");
    await open(s.app, "c.md", "On c");
    await call(friend.app, `${API}/comments`, "POST", { path: "c.md", body: "@owner look" });
    const mine = async () =>
      (await (await call(s.app, "/api/v1/inbox?library=owner/demo")).json()) as {
        items: { id: string }[];
        open: number;
      };
    const listed = await mine();
    expect(listed.items.length).toBeGreaterThan(0);
    const first = listed.items[0]?.id;
    expect((await call(s.app, `/api/v1/inbox/${first}/done`, "POST")).status).toBe(200);
    const left = await mine();
    expect(left.items.map((i) => i.id)).not.toContain(first);
    expect(left.open).toBe(listed.open - 1);
  });

  test("no read cursor or tally any more (TEMPRA-189)", async () => {
    const { s } = await shared();
    for (const path of ["seen", "tally"]) {
      expect((await call(s.app, `${API}/${path}`)).status).toBe(404);
    }
    const list = (await (await call(s.app, "/api/v1/libraries")).json()) as {
      libraries: Record<string, unknown>[];
    };
    expect(list.libraries.every((l) => !("tally" in l))).toBe(true);
  });
});

describe("notification mail (TEMPRA-74)", () => {
  const origin = "https://app.example";

  /** A reply on the owner's thread by the friend, `n` times. */
  async function replies(n: number) {
    const { s, friend } = await shared();
    await write(s.app, "a.md");
    const id = await open(s.app, "a.md", "Question");
    for (let i = 1; i <= n; i++) {
      await call(friend.app, `${API}/comments/${id}`, "POST", { body: `reply ${i}` });
    }
    return { s, friend };
  }

  const flush = (s: S, now: Date, force = false) =>
    flushMail(
      {
        accounts: s.accounts,
        notifications: s.notifications,
        outbox: s.deps.outbox ?? null,
        origin,
        now,
      },
      { force },
    );

  test("a burst is one mail, after a quiet spell, with a one-click unsubscribe", async () => {
    const { s } = await replies(3);
    const before = s.outbox.length;
    // Still busy: it waits.
    expect(await flush(s, new Date())).toMatchObject({ mails: 0, waiting: 3 });
    const later = new Date(Date.now() + QUIET_MS + 1000);
    expect(await flush(s, later)).toMatchObject({ mails: 1, items: 3 });
    const mails = s.outbox.slice(before);
    expect(mails).toHaveLength(1);
    const m = mails[0];
    expect(m?.to).toBe("owner@example.com");
    expect(m?.subject).toBe("3 new notifications in Tempra");
    expect(m?.text).toContain("@friend replied on a.md in owner/demo");
    expect(m?.text).toContain(`${origin}/owner/demo/a.md#comments`);
    expect(m?.html).toContain(`href="${origin}/owner/demo/a.md#comments"`);
    expect(m?.html).toContain(">Unsubscribe</a>");
    const unsub = m?.headers?.["List-Unsubscribe"] ?? "";
    expect(m?.headers?.["List-Unsubscribe-Post"]).toBe("List-Unsubscribe=One-Click");
    // Sent once: nothing waits now.
    expect(await flush(s, later)).toMatchObject({ mails: 0, waiting: 0 });

    // One click, from the mail provider, no session: mail is off.
    const url = new URL(unsub.slice(1, -1));
    expect(url.pathname).toBe("/unsubscribe");
    expect((await s.anon.request(`/unsubscribe${url.search}`)).status).toBe(200);
    const r = await s.anon.request(`/unsubscribe${url.search}`, { method: "POST" });
    expect(r.status).toBe(200);
    expect(await r.text()).toContain("Unsubscribed");
    expect((await s.anon.request("/unsubscribe?k=0000", { method: "POST" })).status).toBe(404);
    const prefs = await (await call(s.app, "/api/v1/account/notifications")).json();
    expect(prefs).toEqual({ email: false });
  });

  test("a batch goes after the longest wait even while replies keep coming", async () => {
    const { s } = await replies(1);
    expect(await flush(s, new Date(Date.now() + MAX_WAIT_MS + 1000))).toMatchObject({ mails: 1 });
  });

  test("items opened in the app, the email switch off, and the daily cap are respected", async () => {
    const { s } = await replies(2);
    const later = new Date(Date.now() + QUIET_MS + 1000);
    // Opened in the app first: done, not mailed.
    for (const i of (await inbox(s.app)).items) {
      await call(s.app, `/api/v1/inbox/${i.id}/done`, "POST");
    }
    expect(await flush(s, later)).toMatchObject({ mails: 0, skipped: 2 });

    // The one switch (TEMPRA-189), on by default: off, the batch is skipped.
    const { s: s2 } = await replies(1);
    expect((await (await call(s2.app, "/api/v1/account/notifications")).json()) as unknown).toEqual(
      {
        email: true,
      },
    );
    expect(
      (await call(s2.app, "/api/v1/account/notifications", "PUT", { email: false })).status,
    ).toBe(204);
    expect(
      (await call(s2.app, "/api/v1/account/notifications", "PUT", { email: "no" })).status,
    ).toBe(400);
    expect((await (await call(s2.app, "/api/v1/account/notifications")).json()) as unknown).toEqual(
      {
        email: false,
      },
    );
    expect(await flush(s2, later)).toMatchObject({ mails: 0, skipped: 1 });

    // The cap: the day's slots taken, the batch is skipped, not held.
    const { s: s3 } = await replies(1);
    for (let i = 0; i < 20; i++)
      await s3.notifications.takeMailSlot(OWNER.id, later.toISOString().slice(0, 10));
    expect(await flush(s3, later)).toMatchObject({ mails: 0, skipped: 1 });
  });

  test("a single item's subject names who and where", () => {
    const m = composeBatch(origin, "k".repeat(48), [
      {
        id: "1",
        library: "l",
        kind: "mention",
        place: "ann/notes",
        path: "x.md",
        thread: "t",
        seq: 3,
        actor: "human:bo",
        excerpt: "@ann see <this>",
        created: new Date().toISOString(),
        read_at: null,
        done_at: null,
        title: null,
        by_user: null,
        by_agent: null,
        count: null,
      },
    ]);
    expect(m.subject).toBe("@bo mentioned you on x.md");
    expect(m.html).toContain("@ann see &#60;this&#62;");
  });
});

describe("what content writes tell people (TEMPRA-116, TEMPRA-173)", () => {
  /** The current hash of a file, or none when it is not there. */
  const hashOf = async (s: S, path: string) => {
    const r = await s.app.request(`${API}/files/${path}`, {
      headers: { Accept: "application/json" },
    });
    return r.ok ? ((await r.json()) as { hash: string }).hash : null;
  };
  const put = async (s: S, token: string, path: string, body: string) => {
    const hash = await hashOf(s, path);
    return s.req(`/files/${path}`, {
      method: "PUT",
      token,
      headers: {
        "Content-Type": "text/markdown",
        "X-Note": "agent edit",
        ...(hash ? { "If-Match": hash } : {}),
      },
      body,
    });
  };
  /** Writes as the person in `app` (the owner's session). */
  const saveAs = async (s: S, app: App, path: string, body: string) => {
    const hash = await hashOf(s, path);
    return app.request(`${API}/files/${path}`, {
      method: "PUT",
      headers: {
        Origin: ORIGIN,
        "Content-Type": "text/markdown",
        ...(hash ? { "If-Match": hash } : {}),
      },
      body,
    });
  };
  const verify = (app: App, path: string) => call(app, `${API}/verify/${path}`, "POST");
  const edited = (title: string, n: number) => doc(title).replace("Revenue minus cost.", `v${n}`);
  const days = (n: number) => new Date(Date.now() + n * 86_400_000).toISOString();
  const staleDoc = (title: string, after: string) =>
    `---\ntype: Metric\ntitle: ${title}\ndescription: A metric.\nstale_after: ${after}\n---\n# ${title}\n\nBody.\n`;

  test("an edit to a page a person verified tells no one (TEMPRA-173)", async () => {
    const { s, friend, agent } = await shared();
    await write(s.app, "metrics/margin.md");
    expect((await verify(friend.app, "metrics/margin.md")).status).toBe(200);
    const r = await put(s, agent, "metrics/margin.md", edited("Margin", 1));
    expect(r.status).toBeLessThan(300);
    // The notice is the Worker's, never the caller's.
    expect(await r.json()).not.toHaveProperty("notify");
    for (const app of [s.app, friend.app]) expect((await inbox(app)).items).toEqual([]);
  });

  test("a moved page takes its open items along", async () => {
    const { s, friend, agent } = await shared();
    await write(s.app, "metrics/margin.md");
    await open(s.app, "metrics/margin.md", "@friend is this right?");
    const moved = await s.req("/batch", {
      method: "POST",
      token: agent,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        ops: [{ op: "move", path: "metrics/margin.md", to: "metrics/gross-margin.md" }],
      }),
    });
    expect(moved.status).toBeLessThan(300);
    expect((await inbox(friend.app)).items).toMatchObject([
      { kind: "mention", path: "metrics/gross-margin.md" },
    ]);
  });

  test("staleness never reaches a person's Inbox: it is the agents' housekeeping (TEMPRA-142)", async () => {
    const s = setup();
    const writer = await s.stranger("writer@example.com");
    await s.accounts.share(LIB.id, writer.user.id, "write", OWNER.id);
    const save = (path: string, body: string) => saveAs(s, s.app, path, body);
    expect((await save("ops/soon.md", staleDoc("Soon", days(5)))).status).toBeLessThan(300);
    expect((await save("ops/past.md", staleDoc("Past", days(-5)))).status).toBeLessThan(300);
    expect((await call(s.app, `${API}/maintain`, "POST")).status).toBeLessThan(300);
    for (const app of [s.app, writer.app]) expect((await inbox(app)).items).toEqual([]);
    // The agents' work queue has it, and the home counts it as their housekeeping.
    const needs = (await (await call(s.app, `${API}/needs`)).json()) as {
      housekeeping: { stale: number };
      count: number;
    };
    expect(needs.housekeeping.stale).toBe(1);
    expect(needs.count).toBe(0);
  });

  test("resolving a thread closes its mention items too", async () => {
    const { s, friend } = await shared();
    await write(friend.app, "notes/plan.md");
    const id = await open(s.app, "notes/plan.md", "@friend can we split this?");
    const mine = (await (await call(friend.app, "/api/v1/inbox?library=owner/demo")).json()) as {
      items: (InboxItem & { actions: string[]; who: string })[];
      open: number;
    };
    expect(mine.open).toBe(1);
    expect(mine.items).toMatchObject([{ kind: "mention", actions: ["reply"], who: "owner" }]);
    expect((await call(friend.app, "/api/v1/inbox?library=owner/nope")).status).toBe(404);
    await call(s.app, `${API}/comments/${id}/resolve`, "POST");
    expect((await inbox(friend.app)).items).toEqual([]);
  });
});
