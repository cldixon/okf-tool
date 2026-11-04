/**
 * The OAuth flow as an MCP client drives it (register, consent, token with PKCE), shared by the
 * OAuth and MCP tests.
 */
import { expect } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { ORIGIN, type setup } from "./harness";

export const REDIRECT = "https://claude.ai/api/mcp/auth_callback";

const b64url = (bytes: Uint8Array) =>
  btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");

export type App = ReturnType<typeof setup>["app"];

export async function register(app: App, name = "Claude", redirect = REDIRECT) {
  const r = await app.request("/register", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      client_name: name,
      redirect_uris: [redirect],
      token_endpoint_auth_method: "none",
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
    }),
  });
  expect(r.status).toBe(201);
  return ((await r.json()) as { client_id: string }).client_id;
}

/** Starts an authorization: returns the consent page, its handle and cookies, and the PKCE verifier. */
export async function begin(
  app: App,
  clientId: string,
  scope = "tempra:read tempra:write",
  redirect = REDIRECT,
) {
  const verifier = b64url(crypto.getRandomValues(new Uint8Array(32)));
  const challenge = b64url(sha256(new TextEncoder().encode(verifier)));
  const query = new URLSearchParams({
    response_type: "code",
    client_id: clientId,
    redirect_uri: redirect,
    scope,
    state: "st4te",
    code_challenge: challenge,
    code_challenge_method: "S256",
    resource: `${ORIGIN}/mcp`,
  });
  const url = `/authorize?${query}`;
  const page = await app.request(url);
  const html = await page.text();
  const handle = /name="handle" value="([^"]+)"/.exec(html)?.[1] ?? "";
  const cookies = page.headers
    .getSetCookie()
    .map((c) => c.split(";")[0])
    .join("; ");
  return { page, html, handle, cookies, url, verifier };
}

export async function submit(
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

export async function exchange(
  app: App,
  clientId: string,
  location: string,
  verifier: string,
  redirect = REDIRECT,
) {
  const code = new URL(location).searchParams.get("code") ?? "";
  const r = await app.request("/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: redirect,
      client_id: clientId,
      code_verifier: verifier,
      resource: `${ORIGIN}/mcp`,
    }),
  });
  expect(r.status).toBe(200);
  return (await r.json()) as { access_token: string; refresh_token: string; scope: string };
}

export type Apps = {
  apps: { id: string; app: string; actor: string | null; libraries: "all" | string[] }[];
};

export async function apps(app: App): Promise<Apps["apps"]> {
  const r = await app.request("/api/v1/apps");
  expect(r.status).toBe(200);
  return ((await r.json()) as Apps).apps;
}

/** The app's API, as its pages call it: JSON, from this site. */
export function api(app: App, path: string, method: string, body?: unknown, origin = ORIGIN) {
  return app.request(path, {
    method,
    headers: { Origin: origin, "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

export async function mcp(app: App, token: string) {
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

/** Makes a second account with its own library; returns its handle. */
export async function setupStranger(
  accounts: ReturnType<typeof setup>["accounts"],
): Promise<string> {
  const user = await accounts.user("stranger@example.com");
  await accounts.createLibrary("demo", user);
  return user.handle;
}

export const approve = {
  library: "demo",
  new_library: "",
  access: "write",
  prefix: "",
  actor: "claude-ai/connector",
  tiers: "all",
};

/**
 * Connects an app through consent with these choices and returns its tokens and an MCP client
 * on the access token.
 */
export async function connectApp(
  app: App,
  fields: Record<string, string>,
  opts: { scope?: string; name?: string } = {},
) {
  const clientId = await register(app, opts.name);
  const flow = await begin(app, clientId, opts.scope);
  const done = await submit(app, flow, fields);
  expect(done.status).toBe(302);
  const tokens = await exchange(app, clientId, done.headers.get("Location") ?? "", flow.verifier);
  return { tokens, flow, ...(await mcp(app, tokens.access_token)) };
}
