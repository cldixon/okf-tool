/**
 * The changes panel (TEMPRA-291, a spike; tempra-dev: app/source-diff): `diff` names an MCP App
 * that draws a page's Markdown between two versions in the chat; its resource is one document
 * that loads nothing, and the result carries the patch, the path and both seqs for it.
 */
import { describe, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { CHANGES_PANEL_URI, MCP_APP_MIME } from "../src/mcp/server";
import { setup } from "./harness";

type Changes = {
  v: number;
  library: { owner: string; slug: string };
  path: string;
  from: number;
  to: number;
  patch: string;
};

async function connect(app: ReturnType<typeof setup>["app"]) {
  const transport = new StreamableHTTPClientTransport(new URL("http://localhost/mcp"), {
    requestInit: { headers: { Authorization: "Bearer writer" } },
    fetch: async (url, init) => app.request(url.toString(), init as RequestInit),
  });
  const client = new Client({ name: "test", version: "1.0.0" });
  await client.connect(transport);
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const r = await client.callTool({ name, arguments: args });
    const text = (r.content as { text: string }[]).map((c) => c.text).join("\n");
    const changes = (r.structuredContent as { changes?: Changes } | undefined)?.changes;
    return { text, isError: !!r.isError, changes };
  };
  return { client, call };
}

const doc = (body: string) => `---\ntitle: X\ndescription: An x.\n---\n${body}`;

describe("the changes panel (TEMPRA-291)", () => {
  test("diff names the panel; the resource is an MCP App that loads nothing", async () => {
    const { client } = await connect(setup().app);
    const tool = (await client.listTools()).tools.find((t) => t.name === "diff");
    expect(tool?._meta).toEqual({ ui: { resourceUri: CHANGES_PANEL_URI } });

    const listed = (await client.listResources()).resources.find(
      (r) => r.uri === CHANGES_PANEL_URI,
    );
    expect(listed).toMatchObject({
      mimeType: MCP_APP_MIME,
      _meta: { ui: { prefersBorder: true } },
    });

    const read = await client.readResource({ uri: CHANGES_PANEL_URI });
    const [content] = read.contents as { uri: string; mimeType: string; text: string }[];
    expect(content).toMatchObject({ uri: CHANGES_PANEL_URI, mimeType: MCP_APP_MIME });
    expect((content as { _meta?: unknown })._meta).toEqual({ ui: { prefersBorder: true } });
    expect(content?.text).toStartWith("<!doctype html>");
    expect(content?.text).toContain('<main id="panel"></main>');
    // One script, never closed early, and Pierre's diffs inside it.
    expect(content?.text.match(/<\/script>/g)?.length).toBe(1);
    expect(content?.text).toContain("diffs-container");
    // Shiki's grammars are left out: plain text only.
    expect(content?.text.length).toBeLessThan(1_500_000);
  });

  test("the result carries the patch, the path and both seqs for the panel", async () => {
    const { call } = await connect(setup().app);
    await call("write", { path: "x.md", content: doc("Alpha beta.\n") });
    const h = /hash: (\w+)/.exec((await call("read", { path: "x.md" })).text)?.[1];
    await call("write", { path: "x.md", content: doc("Alpha delta.\n"), if_match: h });

    const r = await call("diff", { path: "x.md" });
    expect(r.isError).toBe(false);
    expect(r.text).toContain("+Alpha delta.");
    const c = r.changes as Changes;
    expect(c).toMatchObject({ v: 1, library: { owner: "owner", slug: "demo" }, path: "x.md" });
    expect(c.to).toBeGreaterThan(c.from);
    // The same unified diff the text gives, its sides labelled by version.
    expect(c.patch).toBe(r.text);
    expect(c.patch).toContain(`--- x.md@`);
    expect(c.patch).toContain("-Alpha beta.");
  });

  test("no difference is an empty patch, and the text says so", async () => {
    const { call } = await connect(setup().app);
    await call("write", { path: "x.md", content: doc("Alpha.\n") });
    const head = (await call("diff", { path: "x.md" })).changes as Changes;
    const r = await call("diff", { path: "x.md", from: head.to, to: head.to });
    expect(r.text).toContain("No difference in x.md");
    expect(r.changes?.patch).toBe("");
  });
});
