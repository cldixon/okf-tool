import { describe, expect, test } from "bun:test";
import { SESSION_COOKIE } from "../src/session";
import { ORIGIN, setup } from "./harness";
import {
  type App,
  api,
  approve,
  apps,
  begin,
  connectApp,
  exchange,
  mcp,
  REDIRECT,
  register,
  setupStranger,
  submit,
} from "./oauth-flow";

describe("OAuth for MCP clients", () => {
  test("discovery: /mcp challenges with protected-resource metadata", async () => {
    const { app } = setup();
    const r = await app.request("/mcp", { method: "POST", body: "{}" });
    expect(r.status).toBe(401);
    expect(r.headers.get("WWW-Authenticate")).toContain(
      `resource_metadata="${ORIGIN}/.well-known/oauth-protected-resource/mcp"`,
    );
    const prm = (await (await app.request("/.well-known/oauth-protected-resource/mcp")).json()) as {
      resource: string;
      authorization_servers: string[];
    };
    expect(prm.resource).toBe(`${ORIGIN}/mcp`);
    const asm = (await (
      await app.request("/.well-known/oauth-authorization-server")
    ).json()) as Record<string, unknown>;
    expect(asm.authorization_endpoint).toBe(`${ORIGIN}/authorize`);
    expect(asm.registration_endpoint).toBe(`${ORIGIN}/register`);
    expect(asm.code_challenge_methods_supported).toEqual(["S256"]);
    expect(asm.client_id_metadata_document_supported).toBe(true);
  });

  test("connect, consent, token, and a write attributed to the app", async () => {
    const { app, accounts } = setup();
    const clientId = await register(app);
    const flow = await begin(app, clientId);
    expect(flow.page.status).toBe(200);
    expect(flow.html).toContain("<h1>Connect Claude</h1>");
    expect(flow.html).toContain("Signed in as owner@example.com");
    expect(flow.html).toContain("<strong>claude.ai</strong>");
    expect(flow.html).toContain('value="claude/connector"');

    const done = await submit(app, flow, approve);
    expect(done.status).toBe(302);
    const location = done.headers.get("Location") ?? "";
    expect(location.startsWith(`${REDIRECT}?`)).toBe(true);
    expect(new URL(location).searchParams.get("state")).toBe("st4te");
    const tokens = await exchange(app, clientId, location, flow.verifier);
    expect(tokens.scope.split(" ").sort()).toEqual(["tempra:read", "tempra:write"]);
    expect((await accounts.user("owner@example.com")).actor).toBe("human:owner");

    const { call } = await mcp(app, tokens.access_token);
    const w = await call("write", {
      path: "a.md",
      content: "---\ntype: Note\n---\nhi\n",
      note: "via oauth",
    });
    expect(w.isError).toBe(false);
    expect((await call("read", { path: "a.md" })).text).toContain("by: claude-ai/connector");
    expect((await call("start")).text).toContain("You are claude-ai/connector (write)");
  });

  test("a read-only grant cannot write", async () => {
    const { app } = setup();
    const clientId = await register(app, "ChatGPT");
    const flow = await begin(app, clientId, "tempra:read");
    expect(flow.html).toContain('value="read" checked');
    const done = await submit(app, flow, {
      ...approve,
      access: "read",
      actor: "chatgpt/connector",
    });
    const tokens = await exchange(app, clientId, done.headers.get("Location") ?? "", flow.verifier);
    expect(tokens.scope).toBe("tempra:read");
    const { call } = await mcp(app, tokens.access_token);
    const w = await call("write", { path: "a.md", content: "---\ntype: Note\n---\nhi\n" });
    expect(w.isError).toBe(true);
    expect(w.text).toContain("read_only");
    expect((await call("start")).isError).toBe(false);
  });

  test("a new library, a directory limit and file tools only", async () => {
    const { app, accounts } = setup();
    const clientId = await register(app);
    const flow = await begin(app, clientId);
    const done = await submit(app, flow, {
      ...approve,
      library: "",
      new_library: "team-notes",
      prefix: "inbox",
      tiers: "files",
    });
    const tokens = await exchange(app, clientId, done.headers.get("Location") ?? "", flow.verifier);
    expect((await accounts.libraries("user_1")).map((l) => l.slug)).toContain("team-notes");
    const { client, call } = await mcp(app, tokens.access_token);
    const tools = (await client.listTools()).tools.map((t) => t.name);
    expect(tools).not.toContain("search");
    expect(
      (await call("write", { path: "x.md", content: "---\ntype: Note\n---\n" })).text,
    ).toContain("outside_prefix");
    expect(
      (await call("write", { path: "inbox/x.md", content: "---\ntype: Note\n---\n" })).isError,
    ).toBe(false);
    expect((await call("start")).text).toContain("Library owner/team-notes");
  });

  test("consent says what approving creates, and offers to sign in as someone else (V-9)", async () => {
    const s = setup();
    // An account with no libraries yet: approving creates one named notes.
    const fresh = await s.accounts.user("fresh@example.com");
    const cookie = `${SESSION_COOKIE}=${s.sessionFor(fresh.id)}`;
    const asFresh: App = {
      request: (input, init) => {
        const headers = new Headers(init?.headers);
        headers.set("Cookie", [headers.get("Cookie"), cookie].filter(Boolean).join("; "));
        return s.anon.request(input, { ...init, headers });
      },
    };
    const flow = await begin(asFresh, await register(s.app));
    expect(flow.html).toContain("Connecting creates the library <strong>notes</strong>.");
    expect(flow.html).not.toContain("Name in the ledger");
    // The connection's name sits folded under More options, in plain words.
    expect(flow.html).toContain("<summary>More options</summary>");
    expect(flow.html).toContain("Connection name");
    // Not you? Sign out, and come back to this same consent once signed in again.
    expect(flow.html).toContain("Not you? Sign out");
    const out = await asFresh.request("/sign-out", {
      method: "POST",
      headers: { Origin: ORIGIN },
      body: new URLSearchParams({ next: flow.url }),
      redirect: "manual",
    });
    expect(out.status).toBe(303);
    expect(out.headers.get("Location")).toBe(`/sign-in?next=${encodeURIComponent(flow.url)}`);
    // Someone with libraries is not told one will be created.
    const owner = await begin(s.app, await register(s.app));
    expect(owner.html).not.toContain("Connecting creates the library");
  });

  test("invalid choices re-show the page; cancelling returns access_denied", async () => {
    const { app } = setup();
    const clientId = await register(app);
    const flow = await begin(app, clientId);
    const bad = await submit(app, flow, { ...approve, actor: "human:me" });
    expect(bad.status).toBe(400);
    const page = await bad.text();
    expect(page).toContain("The connection name is two parts joined by a slash");
    // Announced, and tied to its field (V-10); the folded options open to show it.
    expect(page).toContain('id="consent-error" role="alert"');
    expect(page).toMatch(/name="actor"[^>]*aria-invalid="true" aria-describedby="consent-error actor-hint"/);
    expect(page).toContain("<details open>");
    // The same handle still works after the error.
    const denied = await submit(app, flow, { decision: "deny" });
    expect(denied.status).toBe(302);
    expect(new URL(denied.headers.get("Location") ?? "").searchParams.get("error")).toBe(
      "access_denied",
    );
  });

  test("grants are listed and revoked; a revoked token stops working", async () => {
    const { app } = setup();
    const clientId = await register(app);
    const flow = await begin(app, clientId);
    const done = await submit(app, flow, approve);
    const tokens = await exchange(app, clientId, done.headers.get("Location") ?? "", flow.verifier);

    const list = await apps(app);
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ app: "Claude", actor: "claude-ai/connector" });
    const grant = list[0]?.id ?? "";

    const forged = await api(
      app,
      `/api/v1/apps/${grant}`,
      "DELETE",
      undefined,
      "https://evil.example",
    );
    expect(forged.status).toBe(403);
    const byToken = await app.request(`/api/v1/apps/${grant}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${tokens.access_token}` },
    });
    expect(byToken.status).toBe(403);
    const revoked = await api(app, `/api/v1/apps/${grant}`, "DELETE");
    expect(revoked.status).toBe(204);
    expect(await apps(app)).toEqual([]);
    const r = await app.request("/mcp", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${tokens.access_token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });
    expect(r.status).toBe(401);
    // A Bearer challenge, so the client signs in again rather than showing no tools.
    expect(r.headers.get("WWW-Authenticate")).toContain('error="invalid_token"');
    expect(r.headers.get("WWW-Authenticate")).toContain("oauth-protected-resource/mcp");
  });

  test("a connection whose account was deleted outright is told to sign in again", async () => {
    const { app, db } = setup();
    const clientId = await register(app);
    const flow = await begin(app, clientId);
    const done = await submit(app, flow, approve);
    const tokens = await exchange(app, clientId, done.headers.get("Location") ?? "", flow.verifier);
    // A data reset: the account rows go, the OAuth grant stays behind in KV.
    for (const t of [
      "tokens",
      "sessions",
      "sign_in_links",
      "library_members",
      "agents",
      "libraries",
      "handle_holds",
      "users",
    ]) {
      db.run(`DELETE FROM ${t}`);
    }
    const r = await app.request("/mcp", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${tokens.access_token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });
    expect(r.status).toBe(401);
    expect(r.headers.get("WWW-Authenticate")).toContain('error="invalid_token"');
  });

  test("deleting the library, or the account, revokes its connections", async () => {
    for (const how of ["library", "account"] as const) {
      const { app } = setup();
      const clientId = await register(app);
      const flow = await begin(app, clientId);
      const done = await submit(app, flow, approve);
      const tokens = await exchange(
        app,
        clientId,
        done.headers.get("Location") ?? "",
        flow.verifier,
      );
      const [path, confirm] =
        how === "library"
          ? ["/api/v1/libraries/owner/demo/delete", "demo"]
          : ["/api/v1/account/delete", "owner"];
      const del = await api(app, path, "POST", { confirm });
      expect(del.status).toBe(204);
      const r = await app.request("/mcp", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${tokens.access_token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
      });
      expect(r.status).toBe(401);
    }
  });

  test("all libraries: every library the account owns, including later ones", async () => {
    const { app, accounts } = setup();
    const clientId = await register(app);
    const flow = await begin(app, clientId);
    expect(flow.html).toContain('name="libraries" value="all" checked');
    const done = await submit(app, flow, { ...approve, libraries: "all", library: "" });
    const tokens = await exchange(app, clientId, done.headers.get("Location") ?? "", flow.verifier);
    const { client, call } = await mcp(app, tokens.access_token);

    // One library: no `library` needed.
    expect((await call("start")).text).toContain("# Library owner/demo");
    await accounts.createLibrary("developers", { id: "user_1", handle: "owner" });
    const listed = await call("start");
    expect(listed.text).toContain("# Your libraries (2)");
    expect(listed.text).toContain("- owner/developers");
    const ambiguous = await call("read", { path: "a.md" });
    expect(ambiguous.isError).toBe(true);
    expect(ambiguous.text).toContain("library_required");

    const note = "---\ntype: Note\n---\nhi\n";
    expect(
      (await call("write", { library: "owner/developers", path: "a.md", content: note })).isError,
    ).toBe(false);
    expect((await call("read", { library: "developers", path: "a.md" })).text).toContain(
      "by: claude-ai/connector",
    );
    expect((await call("read", { library: "owner/demo", path: "a.md" })).text).toContain(
      "not_found",
    );
    expect((await call("start", { library: "developers" })).text).toContain(
      "Other libraries you can reach: owner/demo",
    );
    const uris = (await client.listResources()).resources.map((r) => r.uri);
    expect(uris).toContain("tempra://owner/developers/a.md");

    // Another account's library is not reachable by name.
    const other = await setupStranger(accounts);
    const theirs = await call("read", { library: `${other}/demo`, path: "a.md" });
    expect(theirs.text).toContain("no_library");

    // Deleting one library keeps a connection to all of them.
    const del = await api(app, "/api/v1/libraries/owner/developers/delete", "POST", {
      confirm: "developers",
    });
    expect(del.status).toBe(204);
    expect((await call("start")).text).toContain("# Library owner/demo");
    expect((await apps(app))[0]?.libraries).toBe("all");
  });

  test("a member connects their own agent to a shared library, held to their role", async () => {
    const s = setup();
    const friend = await s.stranger("friend@example.com");
    await s.accounts.share("lib-1", friend.user.id, "write", "user_1");
    const clientId = await register(friend.app);
    const flow = await begin(friend.app, clientId);
    // Their own demo by slug; the owner's as owner/slug, marked shared with their role.
    expect(flow.html).toContain('name="library" value="demo"');
    expect(flow.html).toContain('name="library" value="owner/demo"');
    expect(flow.html).toContain("shared with you, read and write");
    const done = await submit(friend.app, flow, {
      ...approve,
      libraries: "selected",
      library: "owner/demo",
    });
    const tokens = await exchange(
      friend.app,
      clientId,
      done.headers.get("Location") ?? "",
      flow.verifier,
    );
    const { call } = await mcp(friend.app, tokens.access_token);
    expect((await call("start")).text).toContain("# Library owner/demo");
    const note = "---\ntype: Note\n---\nFrom the friend's agent.\n";
    expect((await call("write", { path: "f.md", content: note })).isError).toBe(false);
    // Their writes count against their own account, not the owner's.
    const writes = s.usage.filter((e) => e.kind === "write").map((e) => e.account);
    expect(writes).toContain("friend");
    expect(writes).not.toContain("owner");
    expect(await apps(friend.app)).toMatchObject([{ libraries: ["owner/demo"] }]);

    // Lowered to read: the same connection reads and comments, and cannot write.
    await s.accounts.share("lib-1", friend.user.id, "read", "user_1");
    const refused = await call("write", { path: "g.md", content: note });
    expect(refused.isError).toBe(true);
    expect(refused.text).toContain("read_only");
    const comment = await call("comment", { action: "open", path: "f.md", body: "A question." });
    expect(comment.isError).toBe(false);

    // Removed: the library is gone from the connection.
    await s.accounts.unshare("lib-1", friend.user.id);
    expect((await call("read", { library: "owner/demo", path: "f.md" })).text).toContain(
      "no_library",
    );
  });

  test("all libraries means the account's own, never ones shared with it", async () => {
    const s = setup();
    const friend = await s.stranger("friend@example.com");
    await s.accounts.share("lib-1", friend.user.id, "write", "user_1");
    const clientId = await register(friend.app);
    const flow = await begin(friend.app, clientId);
    const done = await submit(friend.app, flow, { ...approve, libraries: "all", library: "" });
    const tokens = await exchange(
      friend.app,
      clientId,
      done.headers.get("Location") ?? "",
      flow.verifier,
    );
    const { call } = await mcp(friend.app, tokens.access_token);
    expect((await call("start")).text).toContain("# Library friend/demo");
    expect((await call("read", { library: "owner/demo", path: "a.md" })).text).toContain(
      "no_library",
    );
  });

  test("each person's agents are their own identities, recorded in the ledger", async () => {
    const s = setup();
    const friend = await s.stranger("friend@example.com");
    await s.accounts.share("lib-1", friend.user.id, "write", "user_1");
    const CHATGPT = "https://chatgpt.com/connector_platform_oauth_redirect";
    /** Connects an app as a person, to the owner's demo, and writes one note through it. */
    const connect = async (app: App, name: string, redirect: string, pick: string) => {
      const clientId = await register(app, name, redirect);
      const flow = await begin(app, clientId, "tempra:read tempra:write", redirect);
      const done = await submit(app, flow, { ...approve, libraries: "selected", library: pick });
      const t = await exchange(
        app,
        clientId,
        done.headers.get("Location") ?? "",
        flow.verifier,
        redirect,
      );
      const { call } = await mcp(app, t.access_token);
      const path = `${name.toLowerCase()}-${crypto.randomUUID().slice(0, 8)}.md`;
      const w = await call("write", { path, content: "---\ntype: Note\n---\nHi.\n" });
      expect(w.isError).toBe(false);
    };
    await connect(s.app, "Claude", REDIRECT, "demo");
    await connect(s.app, "ChatGPT", CHATGPT, "demo");
    await connect(friend.app, "Claude", REDIRECT, "owner/demo");
    await connect(friend.app, "ChatGPT", CHATGPT, "owner/demo");
    // Connecting the same app again is the same agent.
    await connect(friend.app, "Claude", REDIRECT, "owner/demo");

    const r = await s.app.request("/api/v1/libraries/owner/demo/agents");
    expect(r.status).toBe(200);
    const { contributors } = (await r.json()) as {
      contributors: {
        person: string;
        agent: { id: string; name: string; platform: string; client: string | null };
        requests: number;
      }[];
    };
    const seen = contributors.map((c) => `${c.agent.name} (${c.agent.platform}) for ${c.person}`);
    expect(seen.sort()).toEqual([
      "ChatGPT (chatgpt.com) for friend",
      "ChatGPT (chatgpt.com) for owner",
      "Claude (claude.ai) for friend",
      "Claude (claude.ai) for owner",
    ]);
    expect(new Set(contributors.map((c) => c.agent.id)).size).toBe(4);
    const friendsClaude = contributors.find(
      (c) => c.person === "friend" && c.agent.name === "Claude",
    );
    expect(friendsClaude?.requests).toBe(2);
    // What the client said at MCP initialize, kept as a claim.
    expect(friendsClaude?.agent.client).toBe("oauth-test 1.0.0");

    // Each request names its person and agent by id, stable across handle changes.
    const log = (await (await s.req("/requests", { token: "human" })).json()) as {
      requests: { by: { person: string; agent?: string } | null }[];
    };
    expect(log.requests[0]?.by).toEqual({
      person: friend.user.id,
      agent: friendsClaude?.agent.id as string,
    });
  });

  test("selected libraries: only those, and a suspended account is cut off", async () => {
    const { app, accounts, db } = setup();
    await accounts.createLibrary("private", { id: "user_1", handle: "owner" });
    const clientId = await register(app);
    const flow = await begin(app, clientId);
    const done = await submit(app, flow, { ...approve, libraries: "selected" });
    const tokens = await exchange(app, clientId, done.headers.get("Location") ?? "", flow.verifier);
    const { call } = await mcp(app, tokens.access_token);
    expect((await call("start")).text).toContain("# Library owner/demo");
    expect((await call("read", { library: "owner/private", path: "a.md" })).text).toContain(
      "no_library",
    );
    // A library created later is not selected.
    await accounts.createLibrary("later", { id: "user_1", handle: "owner" });
    expect((await call("start")).text).toContain("# Library owner/demo");
    expect((await apps(app))[0]?.libraries).toEqual(["demo"]);

    db.run("UPDATE users SET suspended = ? WHERE id = ?", [new Date().toISOString(), "user_1"]);
    const r = await app.request("/mcp", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${tokens.access_token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });
    expect(r.status).toBe(401);
    // A Bearer challenge, so the client signs in again rather than showing no tools.
    expect(r.headers.get("WWW-Authenticate")).toContain('error="invalid_token"');
    expect(r.headers.get("WWW-Authenticate")).toContain("oauth-protected-resource/mcp");
  });

  test("a connection whose account was deleted outright is told to sign in again", async () => {
    const { app, db } = setup();
    const clientId = await register(app);
    const flow = await begin(app, clientId);
    const done = await submit(app, flow, approve);
    const tokens = await exchange(app, clientId, done.headers.get("Location") ?? "", flow.verifier);
    // A data reset: the account rows go, the OAuth grant stays behind in KV.
    for (const t of [
      "tokens",
      "sessions",
      "sign_in_links",
      "library_members",
      "agents",
      "libraries",
      "handle_holds",
      "users",
    ]) {
      db.run(`DELETE FROM ${t}`);
    }
    const r = await app.request("/mcp", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${tokens.access_token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });
    expect(r.status).toBe(401);
    expect(r.headers.get("WWW-Authenticate")).toContain('error="invalid_token"');
  });

  test("selecting nothing re-shows the page", async () => {
    const { app } = setup();
    const clientId = await register(app);
    const flow = await begin(app, clientId);
    const bad = await submit(app, flow, { ...approve, libraries: "selected", library: "" });
    expect(bad.status).toBe(400);
    expect(await bad.text()).toContain("Pick at least one library");
  });

  test("bearer tokens still work on /mcp alongside OAuth", async () => {
    const { app } = setup();
    const { call } = await mcp(app, "writer");
    expect((await call("start")).text).toContain("You are claude-code/test");
  });

  describe("Create libraries (TEMPRA-100)", () => {
    const creates = { ...approve, create_libraries: "on" };

    test("consent offers it, on, for a write connection, and the choice round-trips", async () => {
      const { app } = setup();
      const clientId = await register(app);
      const flow = await begin(app, clientId);
      expect(flow.html).toContain('name="create_libraries" value="on" checked');
      const readFlow = await begin(app, clientId, "tempra:read");
      expect(readFlow.html).not.toContain("create_libraries");

      // Only with read and write and all tools: asked for with Read only or File tools only, the
      // page comes back saying so, the box marked (V-9), rather than dropping it quietly.
      for (const wrong of [{ access: "read" }, { tiers: "files" }]) {
        const again = await begin(app, clientId);
        const refused = await submit(app, again, { ...creates, ...wrong });
        expect(refused.status).toBe(400);
        const html = await refused.text();
        expect(html).toContain("Create libraries needs Read and write and All tools");
        expect(html).toMatch(/name="create_libraries"[^>]*aria-invalid="true"/);
      }

      const on = await connectApp(app, creates);
      const off = await connectApp(app, approve);
      const files = await connectApp(app, { ...approve, tiers: "files" });
      const read = await connectApp(app, { ...approve, access: "read" });
      const listed = (await apps(app)) as unknown as { actor: string; create_libraries: boolean }[];
      expect(listed.map((a) => a.create_libraries).sort()).toEqual([false, false, false, true]);

      expect((await on.call("create_library", { slug: "made" })).isError).toBe(false);
      for (const c of [off, files, read]) {
        expect((await c.call("create_library", { slug: "nope" })).text).toContain(
          "create_not_allowed",
        );
      }
    });

    test("a selected grant reaches the library it created and no other", async () => {
      const { app, accounts } = setup();
      await accounts.createLibrary("private", { id: "user_1", handle: "owner" });
      const first = await connectApp(app, { ...creates, libraries: "selected" });
      const second = await connectApp(app, { ...creates, libraries: "selected" });

      expect((await first.call("create_library", { slug: "made" })).isError).toBe(false);
      const started = await first.call("start");
      expect(started.text).toContain("# Your libraries (2)");
      expect(started.text).toContain("- owner/demo");
      expect(started.text).toContain("- owner/made");
      expect(started.text).not.toContain("private");
      expect((await first.call("read", { library: "owner/private", path: "a.md" })).text).toContain(
        "no_library",
      );
      // A library made later in the app is not added to it.
      await accounts.createLibrary("later", { id: "user_1", handle: "owner" });
      expect((await first.call("start")).text).not.toContain("later");

      // The person's other selected connection is untouched.
      expect((await second.call("start")).text).toContain("# Library owner/demo");
      expect((await second.call("read", { library: "owner/made", path: "a.md" })).text).toContain(
        "no_library",
      );
      // ...and so is each one's own creation.
      expect((await second.call("create_library", { slug: "made-two" })).isError).toBe(false);
      expect(
        (await first.call("read", { library: "owner/made-two", path: "a.md" })).text,
      ).toContain("no_library");

      const byLibs = (await apps(app)).map((a) => a.libraries).sort();
      expect(byLibs).toEqual([
        ["demo", "made"],
        ["demo", "made-two"],
      ]);

      // Deleting the library picked at consent keeps a connection that still has what it made.
      const del = await api(app, "/api/v1/libraries/owner/demo/delete", "POST", {
        confirm: "demo",
      });
      expect(del.status).toBe(204);
      expect((await first.call("start")).text).toContain("# Library owner/made");
      expect((await apps(app)).map((a) => a.libraries).sort()).toEqual([["made"], ["made-two"]]);
      // Deleting that too leaves it nothing: revoked.
      await api(app, "/api/v1/libraries/owner/made/delete", "POST", { confirm: "made" });
      expect((await apps(app)).map((a) => a.libraries)).toEqual([["made-two"]]);
    });

    test("a member's agent creates only in its own person's name", async () => {
      const s = setup();
      const friend = await s.stranger("friend@example.com");
      await s.accounts.share("lib-1", friend.user.id, "write", "user_1");
      const c = await connectApp(friend.app, {
        ...creates,
        libraries: "selected",
        library: "owner/demo",
      });
      expect((await c.call("create_library", { slug: "owner/x" })).text).toContain("bad_slug");
      const made = await c.call("create_library", { slug: "x" });
      expect(made.text).toContain("Created library friend/x, owned by @friend");
      expect(await s.accounts.library("owner", "x")).toBeNull();
      expect((await s.accounts.library("friend", "x"))?.ownerId).toBe(friend.user.id);
      // The owner cannot see it; the friend's agent still reaches the shared library at its role.
      expect((await s.app.request("/api/v1/libraries/friend/x/tree")).status).toBe(404);
      expect((await c.call("start")).text).toContain("- owner/demo");
    });

    test("POST /api/v1/libraries takes an app's access token under the same rules", async () => {
      const { app, anon, accounts, db } = setup();
      const post = (token: string, body: unknown) =>
        anon.request("/api/v1/libraries", {
          method: "POST",
          headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });
      const on = await connectApp(app, { ...creates, libraries: "selected" });
      const r = await post(on.tokens.access_token, { slug: "via-rest", title: "Via REST" });
      expect(r.status).toBe(201);
      expect(await r.json()).toMatchObject({
        owner: "owner",
        slug: "via-rest",
        title: "Via REST",
      });
      expect((await on.call("start", { library: "owner/via-rest" })).text).toContain(
        "Title: Via REST",
      );
      expect((await post(on.tokens.access_token, { slug: "via-rest" })).status).toBe(409);

      const off = await connectApp(app, approve);
      const refused = await post(off.tokens.access_token, { slug: "nope" });
      expect(refused.status).toBe(403);
      expect(((await refused.json()) as { code: string }).code).toBe("create_not_allowed");
      // A forged or revoked token is not one.
      const forged = await post(`user_1:x:${"a".repeat(32)}`, { slug: "nope" });
      expect(forged.status).toBe(401);
      // An agent's bearer token still cannot; a human: token still can.
      expect((await post("writer", { slug: "nope" })).status).toBe(403);
      expect((await post("human", { slug: "by-human" })).status).toBe(201);

      // Revoked at /apps: the token is gone.
      const revoke = await connectApp(app, creates);
      const id = revoke.tokens.access_token.split(":")[1] ?? "";
      expect((await api(app, `/api/v1/apps/${id}`, "DELETE")).status).toBe(204);
      expect((await post(revoke.tokens.access_token, { slug: "nope" })).status).toBe(401);
      // A suspended account creates nothing, over REST or MCP.
      db.run("UPDATE users SET suspended = ? WHERE id = ?", [new Date().toISOString(), "user_1"]);
      expect((await post(on.tokens.access_token, { slug: "nope" })).status).toBe(401);
      expect(await accounts.library("owner", "nope")).toBeNull();
    });
  });
});
