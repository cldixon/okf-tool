import { describe, expect, test } from "bun:test";
import { sha256Hex } from "../src/format/hash";
import { API, ORIGIN, setup } from "./harness";

// The app's own pages call the REST API with the session cookie (TEMPRA-9).

const page = "---\ntype: Note\ntitle: A\ndescription: A note.\n---\nBody.\n";

function put(origin: Record<string, string>) {
  return {
    method: "PUT",
    headers: { "Content-Type": "text/markdown", "X-Note": "from the app", ...origin },
    body: page,
  };
}

describe("session on the REST API", () => {
  test("the signed-in owner reads their library without a token", async () => {
    const s = setup();
    const res = await s.app.request(`${API}/tree`);
    expect(res.status).toBe(200);
    expect(await res.json()).toHaveProperty("seq");
  });

  test("a person in the app is metered but not held to the agents' budgets, even when spent", async () => {
    const s = setup();
    // Every token and account limit spent; the session's own still has room.
    s.deps.rateLimit = async (kind) => kind === "session";
    expect((await s.app.request(`${API}/tree`)).status).toBe(200);
    expect((await s.app.request(`${API}/files/a.md`, put({ Origin: ORIGIN }))).status).toBe(200);
    expect(s.usage.filter((u) => u.kind === "write")).toHaveLength(1);
  });

  // TEMPRA-80: a runaway tab or a script with the cookie is limited like a token is.
  test("a session over its own limit gets a 429 with Retry-After, on the API and on pages", async () => {
    const s = setup();
    const keys: string[] = [];
    let room = true;
    s.deps.rateLimit = async (kind, key) => {
      keys.push(`${kind}:${key}`);
      return kind !== "session" || room;
    };
    expect((await s.app.request(`${API}/tree`)).status).toBe(200);
    // Keyed by the session's stored hash, never the cookie's secret.
    expect(keys).toContain(`session:session:${sha256Hex(s.ownerSession)}`);
    expect(keys.join()).not.toContain(s.ownerSession);
    room = false;
    const api = await s.app.request(`${API}/tree`);
    expect(api.status).toBe(429);
    expect(api.headers.get("Retry-After")).toBe("60");
    expect(((await api.json()) as { code: string }).code).toBe("rate_limited");
    const page = await s.app.request("/owner/demo/");
    expect(page.status).toBe(429);
    expect(page.headers.get("Retry-After")).toBe("60");
    expect(page.headers.get("Content-Type")).toContain("text/html");
    const account = await s.app.request("/api/v1/account");
    expect(account.status).toBe(429);
  });

  test("health checks, and requests with a token, do not count against a session", async () => {
    const s = setup();
    const kinds: string[] = [];
    s.deps.rateLimit = async (kind) => {
      kinds.push(kind);
      return kind !== "session";
    };
    expect((await s.app.request("/healthz")).status).toBeLessThan(500);
    // A token wins over a cookie sent alongside it: limited per token.
    const withToken = await s.app.request(`${API}/tree`, {
      headers: { Authorization: "Bearer writer" },
    });
    expect(withToken.status).toBe(200);
    expect(kinds).not.toContain("session");
  });

  test("no session and no token is 401, not a sign-in redirect", async () => {
    const s = setup();
    const res = await s.anon.request(`${API}/tree`);
    expect(res.status).toBe(401);
    expect(((await res.json()) as { code: string }).code).toBe("no_token");
  });

  test("a write from the app's pages is attributed to the person, with its note", async () => {
    const s = setup();
    const res = await s.app.request(`${API}/files/a.md`, put({ Origin: ORIGIN }));
    expect(res.status).toBe(200);
    const ledger = (await (await s.app.request(`${API}/requests?limit=1`)).json()) as {
      requests: { actor: string; note: string | null }[];
    };
    expect(ledger.requests[0]).toMatchObject({ actor: "human:owner", note: "from the app" });
  });

  test("Sec-Fetch-Site same-origin stands in for a missing Origin", async () => {
    const s = setup();
    const res = await s.app.request(`${API}/files/a.md`, put({ "Sec-Fetch-Site": "same-origin" }));
    expect(res.status).toBe(200);
  });

  test("a session write from another site, or with no origin at all, is refused", async () => {
    const s = setup();
    const origins: Record<string, string>[] = [
      { Origin: "https://evil.example" },
      {},
      { Origin: "null" },
    ];
    for (const origin of origins) {
      const res = await s.app.request(`${API}/files/a.md`, put(origin));
      expect(res.status).toBe(403);
      expect(((await res.json()) as { code: string }).code).toBe("cross_origin");
    }
    expect(s.store().headSeq()).toBe(0);
  });

  test("a bearer token, when sent, decides alone: a bad one is not rescued by the session", async () => {
    const s = setup();
    const res = await s.app.request(`${API}/tree`, {
      headers: { Authorization: "Bearer not-a-token" },
    });
    expect(res.status).toBe(401);
  });

  test("library and token management works from the session, writes same-site only", async () => {
    const s = setup();
    const libs = (await (await s.app.request("/api/v1/libraries")).json()) as {
      libraries: { owner: string; slug: string }[];
    };
    expect(libs.libraries).toEqual([expect.objectContaining({ owner: "owner", slug: "demo" })]);

    const body = JSON.stringify({ library: "demo", actor: "claude-code/app", scope: "read" });
    const headers = { "Content-Type": "application/json" };
    const crossSite = await s.app.request("/api/v1/tokens", { method: "POST", headers, body });
    expect(crossSite.status).toBe(403);
    const minted = await s.app.request("/api/v1/tokens", {
      method: "POST",
      headers: { ...headers, Origin: ORIGIN },
      body,
    });
    expect(minted.status).toBe(201);
    const tokens = (await (await s.app.request("/api/v1/tokens")).json()) as {
      tokens: { actor: string }[];
    };
    expect(tokens.tokens.map((t) => t.actor)).toContain("claude-code/app");
  });

  test("a stranger's session sees nothing of the owner's library or tokens", async () => {
    const s = setup();
    const other = await s.stranger();
    expect((await other.app.request(`${API}/tree`)).status).toBe(404);
    const libs = await (await other.app.request("/api/v1/libraries")).text();
    expect(libs).not.toContain('"owner":"owner"');
  });
});
