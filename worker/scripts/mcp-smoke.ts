/**
 * `bun scripts/mcp-smoke.ts --url <base> --token <token> [--read-only]`: exercises the MCP server
 * with the SDK client, like an agent would. Without --read-only it writes, edits, moves and
 * deletes a scratch concept under `_smoke/` and leaves the library's files as it found them
 * (the ledger keeps the events).
 */
import { parseArgs } from "node:util";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const { values } = parseArgs({
  options: { url: { type: "string" }, token: { type: "string" }, "read-only": { type: "boolean" } },
});
if (!values.url || !values.token) {
  console.error("usage: bun scripts/mcp-smoke.ts --url <base> --token <token> [--read-only]");
  process.exit(2);
}

const transport = new StreamableHTTPClientTransport(new URL("/mcp", values.url), {
  requestInit: { headers: { Authorization: `Bearer ${values.token}` } },
});
const client = new Client({ name: "okf-smoke", version: "1.0.0" });
await client.connect(transport);

let failed = false;
async function call(name: string, args: Record<string, unknown> = {}, expectError = false) {
  const r = await client.callTool({ name, arguments: args });
  const text = (r.content as { text: string }[]).map((c) => c.text).join("\n");
  const ok = !!r.isError === expectError;
  if (!ok) failed = true;
  console.log(`${ok ? "ok  " : "FAIL"} ${name} ${JSON.stringify(args).slice(0, 80)}`);
  if (!ok) console.log(text);
  return text;
}

const tools = (await client.listTools()).tools.map((t) => t.name);
console.log(`tools (${tools.length}): ${tools.join(", ")}`);
console.log((await call("start")).split("\n").slice(0, 4).join("\n"));
await call("browse");
if (tools.includes("log")) await call("log", { limit: 3 });
if (tools.includes("work")) await call("work");
if (tools.includes("export")) {
  const url = /(https?:\/\/\S+)/.exec(await call("export"))?.[1];
  const res = url ? await fetch(url) : null;
  const ok = res?.status === 200 && res.headers.get("Content-Type") === "application/x-tar";
  if (!ok) failed = true;
  console.log(`${ok ? "ok  " : "FAIL"} export download (${res?.status})`);
}

if (!values["read-only"]) {
  const path = `_smoke/note-${Date.now()}.md`;
  const doc = `---\ntype: Note\ntitle: Smoke\ndescription: MCP smoke test.\n---\nHello [self](/${path}).\n`;
  await call("write", { path, content: doc, note: "mcp smoke test" });
  await call("write", { path, content: doc }, true); // exists: needs if_match
  const read = await call("read", { path });
  await call("edit", { path, edits: [{ old: "Hello", new: "Hi" }], note: "mcp smoke edit" });
  if (!/hash: [0-9a-f]{64}/.test(read)) failed = true;
  await call("grep", { pattern: "Hi [self]", prefix: "_smoke" });
  if (tools.includes("search")) await call("search", { q: "smoke" });
  if (tools.includes("diff")) await call("diff", { path });
  const moved = path.replace("note-", "moved-");
  await call("move", { from: path, to: moved, note: "mcp smoke move" });
  const hash = /hash: ([0-9a-f]{64})/.exec(await call("read", { path: moved }))?.[1];
  await call("delete", { path: moved, if_match: hash, note: "mcp smoke cleanup" });
}

await client.close();
console.log(failed ? "MCP smoke FAILED" : "MCP smoke passed");
process.exit(failed ? 1 : 0);
