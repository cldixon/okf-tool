import { describe, expect, test } from "bun:test";
import { readdirSync } from "node:fs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import {
  REPLY_MAX_WORDS,
  SYSTEM_PROMPT,
  serverInstructions,
  turnPrompt,
} from "../src/managed/turn";
import { managedShorten, render } from "../src/prompts";
import { setup } from "./harness";
import { deps, TURNS } from "./prompt-fixtures";

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

describe("prompts (TEMPRA-314)", () => {
  test("render fills placeholders and refuses missing or unused values", () => {
    expect(render("At most {{N}} a {{UNIT}}.", { N: 6, UNIT: "call" })).toBe("At most 6 a call.");
    expect(render("No placeholders, {single} braces.")).toBe("No placeholders, {single} braces.");
    expect(() => render("At most {{N}}.")).toThrow("no value for {{N}}");
    expect(() => render("Plain.", { N: 6 })).toThrow("unused {{N}}");
    // A value goes in as it is: placeholders and replacement patterns inside it are text.
    expect(render("Said: {{X}}", { X: "{{Y}} $& $1" })).toBe("Said: {{Y}} $& $1");
  });

  test("every registered tool has its file in prompts/tools/, and every file a tool", async () => {
    const files = readdirSync(`${import.meta.dir}/../src/prompts/mcp/tools`)
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

  // The managed agent's, likewise: its system prompt (a cached prefix, quoting the instructions'
  // sections by name), a turn's first message for a few kinds of thread, the note to shorten.
  test("what the managed agent is sent", async () => {
    const turns: Record<string, string> = {};
    for (const [name, o] of Object.entries(TURNS)) turns[name] = await turnPrompt(deps, o);
    expect({
      serverInstructions: serverInstructions(),
      system: SYSTEM_PROMPT,
      turns,
      shorten: managedShorten({ WORDS: 95, REPLY_MAX_WORDS }),
    }).toMatchSnapshot();
  });

  test("no note, marker or placeholder reaches a model", async () => {
    const { instructions, tools } = await listed();
    const fixed = [instructions ?? "", SYSTEM_PROMPT, ...tools.map((t) => t.description ?? "")];
    for (const text of fixed) {
      expect(text).not.toContain("<!--");
      expect(text).not.toMatch(/\{\{[A-Z_]+\}\}/);
    }
    // A turn carries people's text, which may hold anything; only the prompt's own notes go.
    const turn = await turnPrompt(deps, TURNS["page, may edit"]);
    expect(turn).not.toContain("<!--");
  });
});
