import { describe, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { readTar } from "../src/util/tar";
import { setup } from "./harness";

type Text = { type: "text"; text: string };

async function connect(app: ReturnType<typeof setup>["app"], token = "writer") {
  const transport = new StreamableHTTPClientTransport(new URL("http://okf.test/mcp"), {
    requestInit: { headers: { Authorization: `Bearer ${token}` } },
    fetch: async (url, init) => app.request(url.toString(), init as RequestInit),
  });
  const client = new Client({ name: "test", version: "1.0.0" });
  await client.connect(transport);
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const r = await client.callTool({ name, arguments: args });
    return { text: (r.content as Text[]).map((c) => c.text).join("\n"), isError: !!r.isError };
  };
  return { client, call };
}

const hashOf = (text: string) => /hash: ([0-9a-f]{64})/.exec(text)?.[1] ?? "";

const doc = (title: string, body: string) =>
  `---\ntype: Note\ntitle: ${title}\ndescription: About ${title}.\n---\n${body}`;

describe("MCP server", () => {
  test("tiers: tool lists depend on the token", async () => {
    const { app } = setup();
    const names = async (token: string) =>
      (await (await connect(app, token)).client.listTools()).tools.map((t) => t.name).sort();
    const tier1 = [
      "attach",
      "batch",
      "browse",
      "delete",
      "edit",
      "grep",
      "move",
      "read",
      "start",
      "write",
    ];
    const tier2 = [
      "diff",
      "export",
      "history",
      "links",
      "log",
      "query",
      "revert",
      "search",
      "sources",
      "work",
    ];
    expect(await names("files")).toEqual(tier1);
    expect(await names("writer")).toEqual([...tier1, ...tier2].sort());
    expect(await names("process")).toEqual([...tier1, ...tier2, "verify"].sort());

    const { client } = await connect(app, "files");
    const read = (await client.listTools()).tools.find((t) => t.name === "read");
    expect(Object.keys(read?.inputSchema.properties ?? {})).toEqual(["path"]);
    const { client: full } = await connect(app, "writer");
    const tier2Tool = (await full.listTools()).tools.find((t) => t.name === "search");
    expect(tier2Tool?.description?.startsWith("Beyond files:")).toBe(true);
    expect(full.getInstructions()).toContain("Call `start` first");
  });

  test("the file-equivalent workflow", async () => {
    const { app } = setup();
    const { call } = await connect(app);

    expect((await call("start")).text).toContain("The library is empty");

    let r = await call("write", {
      path: "metrics/revenue.md",
      content: doc("Revenue", "Money in. See [orders](/tables/orders.md).\n"),
      note: "first concept",
    });
    expect(r.isError).toBe(false);
    expect(r.text).toContain("broken_link");
    r = await call("write", {
      path: "tables/orders.md",
      content: doc("Orders", "One row per order.\n"),
    });
    expect(r.text).toContain("Lint: none.");

    // Writing an existing path without if_match fails with the current hash.
    r = await call("write", { path: "tables/orders.md", content: doc("Orders", "x\n") });
    expect(r.isError).toBe(true);
    expect(r.text).toContain("current_hash: ");

    r = await call("read", { path: "metrics/revenue" });
    expect(r.text).toContain("trust: unverified · stale: no · status: stable · inbound links: 0");
    expect(r.text).toContain("Lint: none.");
    const h = hashOf(r.text);

    r = await call("edit", {
      path: "metrics/revenue.md",
      edits: [{ old: "Money in.", new: "Money received." }],
      if_match: h,
    });
    expect(r.isError).toBe(false);
    r = await call("edit", { path: "metrics/revenue.md", edits: [{ old: "nope", new: "x" }] });
    expect(r.isError).toBe(true);
    expect(r.text).toContain("Current document:");

    expect((await call("grep", { pattern: "received" })).text).toBe(
      "metrics/revenue.md:7: Money received. See [orders](/tables/orders.md).",
    );
    expect((await call("browse", { dir: "metrics" })).text).toBe(
      "# Concepts\n\n* [Revenue](revenue.md) - About Revenue.\n",
    );

    r = await call("move", { from: "tables", to: "data/tables", note: "reorganize" });
    expect(r.text).toContain("data/tables/orders.md");
    expect((await call("read", { path: "metrics/revenue.md" })).text).toContain(
      "[orders](/data/tables/orders.md)",
    );

    r = await call("batch", {
      note: "two at once",
      ops: [
        { op: "write", path: "a.md", content: doc("A", "a\n") },
        { op: "write", path: "b.md", content: doc("B", "[a](a.md)\n") },
      ],
    });
    expect(r.text).toContain("Applied a.md");
    const hb = hashOf((await call("read", { path: "b.md" })).text);
    expect((await call("delete", { path: "b.md", if_match: hb })).isError).toBe(false);

    const start = (await call("start")).text;
    expect(start).toContain("Concepts: 3 · attachments: 0");
    expect(start).toContain("Types: Note 3");
  });

  test("beyond files: search, query, links, log, history, diff, revert, work", async () => {
    const { app } = setup();
    const { call } = await connect(app);
    await call("write", { path: "x.md", content: doc("X", "Alpha beta.\n[y](/y.md)\n") });
    await call("write", { path: "y.md", content: doc("Y", "Gamma.\n") });
    const h = hashOf((await call("read", { path: "x.md" })).text);
    await call("write", {
      path: "x.md",
      content: doc("X", "Alpha delta.\n[y](/y.md)\n"),
      if_match: h,
      note: "delta",
    });

    expect((await call("search", { q: "alpha" })).text).toContain("x.md — X");
    expect((await call("query", { type: "Note" })).text).toContain("2 matching concepts");
    expect(JSON.parse((await call("links", { path: "y.md" })).text).inbound[0].path).toBe("x.md");
    const log = (await call("log")).text;
    expect(log.split("\n")[0]).toContain("claude-code/test · delta");
    expect((await call("history", { path: "x.md" })).text).toContain("seq 3");
    const diff = (await call("diff", { path: "x.md" })).text;
    expect(diff).toContain("-Alpha beta.");
    expect(diff).toContain("+Alpha delta.");
    expect((await call("revert", { path: "x.md", to_seq: 1, note: "undo" })).isError).toBe(false);
    expect((await call("read", { path: "x.md" })).text).toContain("Alpha beta.");

    await call("write", {
      path: "old.md",
      content: `---\ntype: Note\nstale_after: 2020-01-01T00:00:00Z\n---\n[gone](/gone.md)\n`,
    });
    const work = (await call("work")).text;
    expect(work).toContain("[stale] old.md");
    expect(work).toContain("[broken_link] old.md");
  });

  test("export and attachments give working short-lived download URLs", async () => {
    const { app } = setup();
    const { call } = await connect(app);
    await call("write", { path: "a.md", content: doc("A", "a\n") });
    const bytes = new Uint8Array([1, 2, 3, 250]);
    const r = await call("attach", {
      path: "refs/data.bin",
      content_base64: btoa(String.fromCharCode(...bytes)),
    });
    expect(r.isError).toBe(false);

    const read = (await call("read", { path: "refs/data.bin" })).text;
    const fileUrl = /download \(15 minutes\): (\S+)/.exec(read)?.[1] ?? "";
    const got = await app.request(fileUrl);
    expect(got.status).toBe(200);
    expect(new Uint8Array(await got.arrayBuffer())).toEqual(bytes);

    const exp = (await call("export")).text;
    const url = /(http\S+)/.exec(exp)?.[1] ?? "";
    const tar = await app.request(url);
    expect(tar.status).toBe(200);
    const paths = readTar(new Uint8Array(await tar.arrayBuffer()))
      .map((f) => f.path)
      .sort();
    expect(paths).toEqual(["a.md", "index.md", "log.md", "refs/data.bin", "refs/index.md"]);

    // Tampered or foreign links are refused.
    expect((await app.request(`${url.slice(0, -2)}xx`)).status).toBe(403);
    expect((await app.request(url.replace("/dl/lib-1/", "/dl/other/"))).status).toBe(403);
  });

  test("permissions: read-only tokens cannot write; only process tokens verify", async () => {
    const { app } = setup();
    const writer = await connect(app);
    await writer.call("write", { path: "a.md", content: doc("A", "a\n") });

    const reader = await connect(app, "reader");
    const r = await reader.call("write", { path: "b.md", content: doc("B", "b\n") });
    expect(r.isError).toBe(true);
    expect(r.text).toContain("read_only");

    const proc = await connect(app, "process");
    expect((await proc.call("verify", { path: "a.md" })).isError).toBe(false);
    const after = (await writer.call("read", { path: "a.md" })).text;
    expect(after).toContain("trust: machine-confirmed");
    expect(after).toContain("by: process:nightly-verify");
  });

  test("resources list and read concepts", async () => {
    const { app } = setup();
    const { client, call } = await connect(app);
    await call("write", { path: "t/a.md", content: doc("A", "a\n") });
    const list = await client.listResources();
    expect(list.resources.map((r) => [r.uri, r.title])).toEqual([["okf://demo/t/a.md", "A"]]);
    const res = await client.readResource({ uri: "okf://demo/t/a.md" });
    expect((res.contents[0] as { text: string }).text).toContain("title: A");
  });

  test("rejects requests without a valid token", async () => {
    const { app } = setup();
    const r = await app.request("/mcp", { method: "POST", body: "{}" });
    expect(r.status).toBe(401);
  });
});
