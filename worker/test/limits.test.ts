import { describe, expect, test } from "bun:test";
import { DEFAULT_LIMITS, limitsFrom } from "../src/limits";
import { ORIGIN, setup, UI } from "./harness";

type S = ReturnType<typeof setup>;

function post(s: S, path: string, fields: Record<string, string>) {
  return s.app.request(path, {
    method: "POST",
    headers: { Origin: ORIGIN },
    body: new URLSearchParams(fields),
    redirect: "manual",
  });
}

const md = (body: string) => `---\ntype: Note\n---\n${body}\n`;

describe("limits (v2 spec: Limits, abuse and metering)", () => {
  test("overrides apply over the defaults; junk is ignored", () => {
    expect(limitsFrom(null)).toEqual(DEFAULT_LIMITS);
    expect(limitsFrom('{"libraries": 10, "tokens": -1, "x": 3}')).toEqual({
      ...DEFAULT_LIMITS,
      libraries: 10,
    });
    expect(limitsFrom("not json")).toEqual(DEFAULT_LIMITS);
  });

  test("libraries per account, everywhere one can be created", async () => {
    const s = setup();
    for (const n of [2, 3, 4, 5]) {
      expect((await post(s, "/app/libraries", { slug: `lib-${n}` })).status).toBe(303);
    }
    const sixth = await post(s, "/app/libraries", { slug: "lib-6" });
    expect(sixth.status).toBe(400);
    expect(await sixth.text()).toContain("limit of 5 libraries");
    const rest = await s.anon.request("/api/v1/libraries", {
      method: "POST",
      headers: { Authorization: "Bearer human", "Content-Type": "application/json" },
      body: JSON.stringify({ slug: "lib-6" }),
    });
    expect(rest.status).toBe(403);
    expect(((await rest.json()) as { code: string }).code).toBe("limit_reached");

    // An override raises it; the account page shows both.
    s.db.run(`UPDATE users SET limits = '{"libraries": 6}' WHERE id = 'user_1'`);
    expect((await post(s, "/app/libraries", { slug: "lib-6" })).status).toBe(303);
    expect(await (await s.app.request("/app/account")).text()).toContain("Libraries: 6 of 6.");
  });

  test("active tokens per account; revoked ones do not count", async () => {
    const s = setup();
    s.db.run(`UPDATE users SET limits = '{"tokens": 1}' WHERE id = 'user_1'`);
    const mint = () =>
      post(s, "/app/tokens", { library: "demo", actor: "claude-code/a", scope: "write" });
    expect((await mint()).status).toBe(200);
    const second = await mint();
    expect(second.status).toBe(400);
    expect(await second.text()).toContain("limit of 1 active tokens");
    const id = (await s.accounts.tokens("user_1"))[0]?.id ?? "";
    await s.accounts.revokeToken(id, "user_1");
    expect((await mint()).status).toBe(200);
  });

  test("storage per library: writes stop at the limit, reads go on", async () => {
    const s = setup();
    const put = (path: string, body: string | Uint8Array, type = "text/markdown") =>
      s.req(`/files/${path}`, { method: "PUT", headers: { "Content-Type": type }, body });
    expect((await put("a.md", md("first"))).status).toBe(200);
    expect((await put("pic.bin", new Uint8Array(2048), "application/octet-stream")).status).toBe(
      200,
    );
    s.limits.storageBytes = 1024;
    const over = await put("b.md", md("second"));
    expect(over.status).toBe(507);
    expect(((await over.json()) as { code: string }).code).toBe("storage_full");
    const read = await s.req("/files/a.md");
    expect(read.status).toBe(200);
    // Deletes and moves still go through, so a full library can be cleared.
    const del = await s.req("/files/a.md", {
      method: "DELETE",
      headers: { "If-Match": read.headers.get("ETag") ?? "" },
    });
    expect(del.status).toBeLessThan(300);
  });

  test("rate limits: 429 from REST and MCP, writes counted per account", async () => {
    const s = setup();
    const seen: string[] = [];
    let allowWrites = true;
    s.deps.rateLimit = async (kind, key) => {
      seen.push(`${kind}:${key}`);
      return kind === "request" || allowWrites;
    };
    const put = () =>
      s.req("/files/a.md", {
        method: "PUT",
        headers: { "Content-Type": "text/markdown" },
        body: md("x"),
      });
    expect((await put()).status).toBe(200);
    expect(seen).toContain("write:owner");
    allowWrites = false;
    const limited = await put();
    expect(limited.status).toBe(429);
    expect((await s.req("/tree")).status).toBe(200);

    const mcp = (method: string, params: unknown) =>
      s.anon.request("/mcp", {
        method: "POST",
        headers: {
          Authorization: "Bearer writer",
          "Content-Type": "application/json",
          Accept: "application/json, text/event-stream",
        },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      });
    expect(
      (await mcp("tools/call", { name: "write", arguments: { path: "b.md", content: md("y") } }))
        .status,
    ).toBe(429);
    expect((await mcp("tools/call", { name: "read", arguments: { path: "a.md" } })).status).toBe(
      200,
    );
  });

  test("metering: a data point per request and per write", async () => {
    const s = setup();
    await s.req("/files/a.md", {
      method: "PUT",
      headers: { "Content-Type": "text/markdown" },
      body: md("x"),
    });
    await s.req("/tree");
    expect(s.usage).toEqual([
      { kind: "request", account: "owner", library: "lib-1" },
      { kind: "write", account: "owner", library: "lib-1" },
      { kind: "request", account: "owner", library: "lib-1" },
    ]);
    // People in the web UI are not metered or limited.
    await s.app.request(`${UI}/`);
    expect(s.usage).toHaveLength(3);
  });
});
