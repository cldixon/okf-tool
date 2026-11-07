import { describe, expect, test } from "bun:test";
import { readdirSync } from "node:fs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { render } from "../src/mcp/prompts";
import { setup } from "./harness";

/** Every tool, as the `process` token (tier 2 and `verify`) lists them. */
async function listed() {
  const { app } = setup();
  const transport = new StreamableHTTPClientTransport(new URL("http://localhost/mcp"), {
    requestInit: { headers: { Authorization: "Bearer process" } },
    fetch: async (url, init) => app.request(url.toString(), init as RequestInit),
  });
  const client = new Client({ name: "test", version: "1.0.0" });
  await client.connect(transport);
  const tools = (await client.listTools()).tools.map((t) => ({
    name: t.name,
    description: t.description,
  }));
  return { instructions: client.getInstructions(), tools };
}

describe("MCP prompts (TEMPRA-314)", () => {
  test("render fills placeholders and refuses missing or unused values", () => {
    expect(render("At most {{N}} a {{UNIT}}.", { N: 6, UNIT: "call" })).toBe("At most 6 a call.");
    expect(render("No placeholders, {single} braces.")).toBe("No placeholders, {single} braces.");
    expect(() => render("At most {{N}}.")).toThrow("no value for {{N}}");
    expect(() => render("Plain.", { N: 6 })).toThrow("unused {{N}}");
  });

  test("every registered tool has its file in prompts/tools/, and every file a tool", async () => {
    const files = readdirSync(`${import.meta.dir}/../src/mcp/prompts/tools`)
      .map((f) => f.replace(/\.md$/, ""))
      .sort();
    const { tools } = await listed();
    expect(tools.map((t) => t.name).sort()).toEqual(files);
  });

  // What agents are sent, byte for byte. A change here changes every client's prompt (and the
  // managed agent's cached prefix): when it is meant, update with `bun test -u` and review the diff.
  test("the instructions and tool descriptions agents see", async () => {
    expect(await listed()).toMatchSnapshot();
  });
});
