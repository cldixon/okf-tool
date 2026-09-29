import { describe, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { ORIGIN, setup } from "./harness";

const REDIRECT = "https://claude.ai/api/mcp/auth_callback";

const b64url = (bytes: Uint8Array) =>
  btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");

type App = ReturnType<typeof setup>["app"];

async function register(app: App, name = "Claude") {
  const r = await app.request("/register", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      client_name: name,
      redirect_uris: [REDIRECT],
      token_endpoint_auth_method: "none",
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
    }),
  });
  expect(r.status).toBe(201);
  return ((await r.json()) as { client_id: string }).client_id;
}

/** Starts an authorization: returns the consent page, its handle and cookies, and the PKCE verifier. */
async function begin(app: App, clientId: string, scope = "okf:read okf:write") {
  const verifier = b64url(crypto.getRandomValues(new Uint8Array(32)));
  const challenge = b64url(sha256(new TextEncoder().encode(verifier)));
  const query = new URLSearchParams({
    response_type: "code",
    client_id: clientId,
    redirect_uri: REDIRECT,
    scope,
    state: "st4te",
    code_challenge: challenge,
    code_challenge_method: "S256",
    resource: `${ORIGIN}/mcp`,
  });
  const url = `/app/authorize?${query}`;
  const page = await app.request(url);
  const html = await page.text();
  const handle = /name="handle" value="([^"]+)"/.exec(html)?.[1] ?? "";
  const cookies = page.headers
    .getSetCookie()
    .map((c) => c.split(";")[0])
    .join("; ");
  return { page, html, handle, cookies, url, verifier };
}

async function submit(
  app: App,
  flow: Awaited<ReturnType<typeof begin>>,
  fields: Record<string, string>,
) {
  return app.request(flow.url, {
    method: "POST",
    headers: { Cookie: flow.cookies, "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ handle: flow.handle, decision: "approve", ...fields }),
    redirect: "manual",
  });
}

async function exchange(app: App, clientId: string, location: string, verifier: string) {
  const code = new URL(location).searchParams.get("code") ?? "";
  const r = await app.request("/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: REDIRECT,
      client_id: clientId,
      code_verifier: verifier,
      resource: `${ORIGIN}/mcp`,
    }),
  });
  expect(r.status).toBe(200);
  return (await r.json()) as { access_token: string; refresh_token: string; scope: string };
}

async function mcp(app: App, token: string) {
  const transport = new StreamableHTTPClientTransport(new URL(`${ORIGIN}/mcp`), {
    requestInit: { headers: { Authorization: `Bearer ${token}` } },
    fetch: async (url, init) => app.request(url.toString(), init as RequestInit),
  });
  const client = new Client({ name: "oauth-test", version: "1.0.0" });
  await client.connect(transport);
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const r = await client.callTool({ name, arguments: args });
    return {
      text: (r.content as { text: string }[]).map((c) => c.text).join("\n"),
      isError: !!r.isError,
    };
  };
  return { client, call };
}

const approve = {
  library: "demo",
  new_library: "",
  access: "write",
  prefix: "",
  actor: "claude-ai/connector",
  tiers: "all",
};

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
    expect(asm.authorization_endpoint).toBe(`${ORIGIN}/app/authorize`);
    expect(asm.registration_endpoint).toBe(`${ORIGIN}/register`);
    expect(asm.code_challenge_methods_supported).toEqual(["S256"]);
    expect(asm.client_id_metadata_document_supported).toBe(true);
  });

  test("connect, consent, token, and a write attributed to the app", async () => {
    const { app, accounts } = setup();
    const clientId = await register(app);
    const flow = await begin(app, clientId);
    expect(flow.page.status).toBe(200);
    expect(flow.html).toContain("Connect Claude to a library");
    expect(flow.html).toContain("Signed in as owner@example.com");
    expect(flow.html).toContain("<strong>claude.ai</strong>");
    expect(flow.html).toContain('value="claude/connector"');

    const done = await submit(app, flow, approve);
    expect(done.status).toBe(302);
    const location = done.headers.get("Location") ?? "";
    expect(location.startsWith(`${REDIRECT}?`)).toBe(true);
    expect(new URL(location).searchParams.get("state")).toBe("st4te");
    const tokens = await exchange(app, clientId, location, flow.verifier);
    expect(tokens.scope.split(" ").sort()).toEqual(["okf:read", "okf:write"]);
    expect(accounts.users.get("owner@example.com")?.actor).toBe("human:owner");

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
    const flow = await begin(app, clientId, "okf:read");
    expect(flow.html).toContain('value="read" checked');
    const done = await submit(app, flow, {
      ...approve,
      access: "read",
      actor: "chatgpt/connector",
    });
    const tokens = await exchange(app, clientId, done.headers.get("Location") ?? "", flow.verifier);
    expect(tokens.scope).toBe("okf:read");
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
    expect(accounts.libs.map((l) => l.slug)).toContain("team-notes");
    const { client, call } = await mcp(app, tokens.access_token);
    const tools = (await client.listTools()).tools.map((t) => t.name);
    expect(tools).not.toContain("search");
    expect(
      (await call("write", { path: "x.md", content: "---\ntype: Note\n---\n" })).text,
    ).toContain("outside_prefix");
    expect(
      (await call("write", { path: "inbox/x.md", content: "---\ntype: Note\n---\n" })).isError,
    ).toBe(false);
    expect((await call("start")).text).toContain("Library team-notes");
  });

  test("invalid choices re-show the page; cancelling returns access_denied", async () => {
    const { app } = setup();
    const clientId = await register(app);
    const flow = await begin(app, clientId);
    const bad = await submit(app, flow, { ...approve, actor: "human:me" });
    expect(bad.status).toBe(400);
    expect(await bad.text()).toContain("The ledger name must look like app/label");
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

    const list = await (await app.request("/app/grants")).text();
    expect(list).toContain("Claude");
    expect(list).toContain("claude-ai/connector");
    const grant = /name="grant" value="([^"]+)"/.exec(list)?.[1] ?? "";

    const forged = await app.request("/app/grants/revoke", {
      method: "POST",
      headers: {
        Origin: "https://evil.example",
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({ grant }),
    });
    expect(forged.status).toBe(403);
    const revoked = await app.request("/app/grants/revoke", {
      method: "POST",
      headers: { Origin: ORIGIN, "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant }),
      redirect: "manual",
    });
    expect(revoked.status).toBe(303);
    const r = await app.request("/mcp", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${tokens.access_token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });
    expect(r.status).toBe(401);
  });

  test("sign-in: the dev email only works on loopback; Access requires its JWT", async () => {
    const { app, env } = setup();
    const remote = await app.request("https://okf.example.com/app/grants");
    expect(remote.status).toBe(503);
    expect(await remote.text()).toContain("Sign-in is not set up");

    Object.assign(env, {
      ACCESS_TEAM_DOMAIN: "https://team.cloudflareaccess.com",
      ACCESS_AUD: "aud",
    });
    const unsigned = await app.request("/app/grants");
    expect(unsigned.status).toBe(403);
    expect(await unsigned.text()).toContain("Not signed in");
  });

  test("bearer tokens still work on /mcp alongside OAuth", async () => {
    const { app } = setup();
    const { call } = await mcp(app, "writer");
    expect((await call("start")).text).toContain("You are claude-code/test");
  });
});
