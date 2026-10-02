import { describe, expect, test } from "bun:test";
import { API, ORIGIN, setup, UI } from "./harness";

type S = ReturnType<typeof setup>;

/** Fills a route pattern's parameters and wildcard with plausible values. */
function fill(path: string): string {
  return path
    .replace(":owner", "owner")
    .replace(":lib", "demo")
    .replace(":request", "req_1")
    .replace(":date", "2026-10-01")
    .replace(":file", "bundle.tar")
    .replace(":id", "tok_1")
    .replace("*", "a.md");
}

/** Every route that names a library by {owner}/{slug}, with its method. */
async function libraryRoutes(s: S) {
  // Imported after the harness has stubbed cloudflare:workers.
  const { createApp } = await import("../src/app");
  const app = createApp(() => s.deps);
  const seen = new Set<string>();
  return app.routes
    .filter((r) => r.method !== "ALL" && r.path.includes(":owner/:lib"))
    .filter((r) => {
      const key = `${r.method} ${r.path}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
}

async function seedOwnerContent(s: S) {
  const r = await s.req("/files/a.md", {
    method: "PUT",
    headers: { "Content-Type": "text/markdown" },
    body: "---\ntype: Note\n---\nThe owner's secret note.\n",
  });
  expect(r.status).toBe(200);
}

describe("tenancy (v2 spec: Tenancy and authorization)", () => {
  test("every library route answers a stranger's session or tokens with 404", async () => {
    const s = setup();
    await seedOwnerContent(s);
    const other = await s.stranger();
    const routes = await libraryRoutes(s);
    // The UI's pages and the REST API, all of them.
    expect(routes.filter((r) => r.path.startsWith("/app/")).length).toBeGreaterThan(15);
    expect(routes.filter((r) => r.path.startsWith("/api/")).length).toBeGreaterThan(20);

    const failures: string[] = [];
    for (const r of routes) {
      const path = fill(r.path);
      const attempts: [string, Promise<Response>][] = path.startsWith("/app/")
        ? [
            [
              "session",
              other.app.request(path, {
                method: r.method,
                headers: { Origin: ORIGIN },
                body: r.method === "GET" ? undefined : new URLSearchParams({ confirm: "demo" }),
                redirect: "manual",
              }),
            ],
          ]
        : [other.writer, other.human].map((token) => [
            token === other.writer ? "write token" : "human token",
            s.anon.request(path, {
              method: r.method,
              headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
              body: r.method === "GET" || r.method === "DELETE" ? undefined : "{}",
            }),
          ]);
      for (const [who, res] of attempts) {
        const got = await res;
        const body = await got.text();
        // Adding the trailing slash redirects any name alike, so it tells nothing.
        if (got.status === 301 && got.headers.get("Location") === `${path}/`) continue;
        if (got.status !== 404 || body.includes("secret note")) {
          failures.push(`${r.method} ${r.path} as the stranger's ${who}: ${got.status}`);
        }
      }
    }
    expect(failures).toEqual([]);

    // Nothing was written to the owner's library.
    expect(s.store().headSeq()).toBe(1);
  });

  test("the same name under another owner is a different library", async () => {
    const s = setup();
    await seedOwnerContent(s);
    const other = await s.stranger();
    const theirs = await other.app.request("/app/libraries/stranger/demo/");
    expect(theirs.status).toBe(200);
    expect(await theirs.text()).not.toContain("a.md");
    const tree = await s.anon.request("/api/v1/libraries/stranger/demo/tree", {
      headers: { Authorization: `Bearer ${other.writer}` },
    });
    expect(tree.status).toBe(200);
    expect(JSON.stringify(await tree.json())).not.toContain("a.md");
    // And the owner cannot open the stranger's.
    expect((await s.app.request("/app/libraries/stranger/demo/")).status).toBe(404);
    const ownerToken = await s.anon.request("/api/v1/libraries/stranger/demo/tree", {
      headers: { Authorization: "Bearer writer" },
    });
    expect(ownerToken.status).toBe(404);
  });

  test("lists and token management show and touch only the account's own", async () => {
    const s = setup();
    const other = await s.stranger();
    // The owner mints a token in the UI.
    const minted = await s.app.request("/app/tokens", {
      method: "POST",
      headers: { Origin: ORIGIN },
      body: new URLSearchParams({ library: "demo", actor: "claude-code/mine", scope: "write" }),
    });
    expect(minted.status).toBe(200);
    const ownerTokens = await s.accounts.tokens("user_1");
    const ownerTokenId = ownerTokens[0]?.id ?? "";
    expect(ownerTokenId).toStartWith("tok_");

    const home = await (await other.app.request("/app")).text();
    expect(home).toContain('href="/app/libraries/stranger/demo/"');
    expect(home).not.toContain("/app/libraries/owner/");
    const tokens = await (await other.app.request("/app/tokens")).text();
    expect(tokens).not.toContain("claude-code/mine");
    expect(tokens).toContain("claude-code/stranger");

    // Revoking the owner's token from the stranger's session, or with their human: token.
    const ui = await other.app.request(`/app/tokens/${ownerTokenId}/revoke`, {
      method: "POST",
      headers: { Origin: ORIGIN },
    });
    expect(ui.status).toBe(404);
    const rest = await s.anon.request(`/api/v1/tokens/${ownerTokenId}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${other.human}` },
    });
    expect(rest.status).toBe(404);
    expect((await s.accounts.tokens("user_1"))[0]?.revoked).toBeNull();

    // REST lists are the stranger's own; minting for the owner's library is refused.
    const auth = { Authorization: `Bearer ${other.human}` };
    const libs = (await (await s.anon.request("/api/v1/libraries", { headers: auth })).json()) as {
      libraries: { id: string; owner: string }[];
    };
    expect(libs.libraries.map((l) => l.owner)).toEqual(["stranger"]);
    const listed = (await (await s.anon.request("/api/v1/tokens", { headers: auth })).json()) as {
      tokens: { id: string }[];
    };
    expect(listed.tokens.map((t) => t.id)).not.toContain(ownerTokenId);
    const forOwnerLib = await s.anon.request("/api/v1/tokens", {
      method: "POST",
      headers: { ...auth, "Content-Type": "application/json" },
      body: JSON.stringify({ library: "lib-1", actor: "claude-code/x", scope: "write" }),
    });
    expect(forOwnerLib.status).toBe(404);
  });

  test("OAuth consent offers only the signed-in account's libraries", async () => {
    const s = setup();
    const other = await s.stranger();
    await s.accounts.createLibrary("private-notes", { id: "user_1", handle: "owner" });
    const reg = await s.anon.request("/register", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        client_name: "Claude",
        redirect_uris: ["https://claude.ai/api/mcp/auth_callback"],
        token_endpoint_auth_method: "none",
      }),
    });
    const { client_id } = (await reg.json()) as { client_id: string };
    const q = new URLSearchParams({
      response_type: "code",
      client_id,
      redirect_uri: "https://claude.ai/api/mcp/auth_callback",
      scope: "okf:read okf:write",
      state: "s",
      code_challenge: "x".repeat(43),
      code_challenge_method: "S256",
    });
    const page = await (await other.app.request(`/app/authorize?${q}`)).text();
    expect(page).toContain("stranger@example.com");
    expect(page).toContain('<option value="demo"');
    expect(page).not.toContain("private-notes");
  });

  test("library paths are {owner}/{slug} in the UI and the API", () => {
    expect(UI).toBe("/app/libraries/owner/demo");
    expect(API).toBe("/api/v1/libraries/owner/demo");
  });
});
