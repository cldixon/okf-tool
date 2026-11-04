import { describe, expect, test } from "bun:test";
import type { TokenInfo } from "../src/auth";
import { DEFAULT_LIMITS, limitsFrom } from "../src/limits";
import { ORIGIN, setup, UI } from "./harness";

type S = ReturnType<typeof setup>;

/** JSON to the API as the signed-in owner, from the app's pages. */
function post(s: S, path: string, body: unknown) {
  return s.app.request(path, {
    method: "POST",
    headers: { Origin: ORIGIN, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

const md = (body: string) => `---\ntype: Note\n---\n${body}\n`;

describe("limits (v2 spec: Limits, abuse and metering)", () => {
  test("overrides apply over the defaults; junk is ignored", () => {
    expect(limitsFrom(null)).toEqual(DEFAULT_LIMITS);
    expect(limitsFrom('{"libraries": 20, "tokens": -1, "x": 3}')).toEqual({
      ...DEFAULT_LIMITS,
      libraries: 20,
    });
    expect(limitsFrom("not json")).toEqual(DEFAULT_LIMITS);
  });

  test("libraries per account, everywhere one can be created", async () => {
    const s = setup();
    for (let n = 2; n <= 10; n++) {
      expect((await post(s, "/api/v1/libraries", { slug: `lib-${n}` })).status).toBe(201);
    }
    const eleventh = await post(s, "/api/v1/libraries", { slug: "lib-11" });
    expect(eleventh.status).toBe(403);
    expect(await eleventh.text()).toContain("limit of 10 libraries");
    const rest = await s.anon.request("/api/v1/libraries", {
      method: "POST",
      headers: { Authorization: "Bearer human", "Content-Type": "application/json" },
      body: JSON.stringify({ slug: "lib-11" }),
    });
    expect(rest.status).toBe(403);
    expect(((await rest.json()) as { code: string }).code).toBe("library_limit");

    // An override raises it; the account page shows both.
    s.db.run(`UPDATE users SET limits = '{"libraries": 11}' WHERE id = 'user_1'`);
    expect((await post(s, "/api/v1/libraries", { slug: "lib-11" })).status).toBe(201);
    const account = (await (await s.app.request("/api/v1/account")).json()) as {
      usage: { libraries: number };
      limits: { libraries: number };
    };
    expect(account.usage.libraries).toBe(11);
    expect(account.limits.libraries).toBe(11);
  });

  test("active tokens per account; revoked ones do not count", async () => {
    const s = setup();
    s.db.run(`UPDATE users SET limits = '{"tokens": 1}' WHERE id = 'user_1'`);
    const mint = () =>
      post(s, "/api/v1/tokens", { library: "demo", actor: "claude-code/a", scope: "write" });
    expect((await mint()).status).toBe(201);
    const second = await mint();
    expect(second.status).toBe(403);
    expect(await second.text()).toContain("limit of 1 active tokens");
    const id = (await s.accounts.tokens("user_1"))[0]?.id ?? "";
    await s.accounts.revokeToken(id, "user_1");
    expect((await mint()).status).toBe(201);
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
    // What each request cost its library is a data point of its own (TEMPRA-228, below).
    const counted = () => s.usage.filter((e) => e.kind !== "cost");
    expect(counted()).toEqual([
      { kind: "request", account: "owner", library: "lib-1" },
      { kind: "write", account: "owner", library: "lib-1" },
      { kind: "request", account: "owner", library: "lib-1" },
    ]);
    // People in the web UI are not limited per token, and a page is not metered; the library's
    // API answers its shell carries (TEMPRA-175: the tree and the agents) are, one data point
    // each, as the app's own calls for them would have been.
    await s.app.request(`${UI}/`);
    expect(counted().slice(3)).toEqual(
      Array(2).fill({ kind: "request", account: "owner", library: "lib-1" }),
    );
  });

  test("metering: what each request and tool call cost its library (TEMPRA-228)", async () => {
    const s = setup();
    const put = await s.req("/files/a.md", {
      method: "PUT",
      headers: { "Content-Type": "text/markdown", "X-Tempra-Cost": "1" },
      body: md("searchable words"),
    });
    expect(put.status).toBe(200);
    const costs = s.usage.filter((e) => e.kind === "cost");
    expect(costs.map((e) => [e.op, e.account, e.library])).toEqual([
      ["PUT /files/*", "owner", "lib-1"],
    ]);
    const c = costs[0]?.cost;
    expect(c?.calls).toBeGreaterThan(0);
    expect(c?.rowsWritten).toBeGreaterThan(0);
    // The search index's rows are told apart: a new page adds its fts row and its rowid.
    expect(c?.ftsRowsWritten).toBeGreaterThanOrEqual(2);
    // Asked for, the answer carries it, each DO call by its operation.
    const header = JSON.parse(put.headers.get("X-Tempra-Cost") ?? "null");
    expect(header.rows_written).toBe(c?.rowsWritten);
    expect(header.ops.map((o: { op: string }) => o.op)).toContain("write");
    // Not asked for, it does not.
    const tree = await s.req("/tree");
    expect(tree.headers.get("X-Tempra-Cost")).toBeNull();

    const mcp = (name: string, args: unknown) =>
      s.anon.request("/mcp", {
        method: "POST",
        headers: {
          Authorization: "Bearer writer",
          "Content-Type": "application/json",
          Accept: "application/json, text/event-stream",
          "X-Tempra-Cost": "1",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: { name, arguments: args },
        }),
      });
    const edit = await mcp("edit", {
      path: "a.md",
      edits: [{ old: "searchable", new: "findable" }],
    });
    const cost = JSON.parse(edit.headers.get("X-Tempra-Cost") ?? "null");
    expect(cost.ops.map((o: { op: string }) => o.op)).toContain("edit");
    expect(cost.fts_rows_written).toBeGreaterThan(0);
    expect(s.usage.filter((e) => e.kind === "cost").at(-1)?.op).toBe("mcp:edit");
  });
});

describe("grants approved before A1 (no owner handle in their props)", () => {
  test("rate limits and metering fall back to the library id", async () => {
    const s = setup();
    const keys: string[] = [];
    s.deps.rateLimit = async (kind, key) => {
      keys.push(`${kind}:${key}`);
      return true;
    };
    const { TOKENS } = await import("./harness");
    const writer = TOKENS.writer as TokenInfo;
    const old = { ...writer, library: { ...writer.library, owner: "" } };
    const { admit, tokenAdmission } = await import("../src/usage");
    await admit(s.deps, tokenAdmission(old), true);
    expect(keys).toContain("write:lib-1");
    expect(s.usage.at(-1)).toMatchObject({ kind: "write", account: "lib-1" });
  });
});
