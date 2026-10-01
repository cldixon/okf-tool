/**
 * `bun scripts/mcp-smoke.ts --url <base> --token <token> [--read-only]`: exercises the MCP server
 * with the SDK client, like an agent would. Without --read-only it writes, edits, moves and
 * deletes a scratch concept under `_smoke/` and leaves the library's files as it found them
 * (the ledger keeps the events). `bun run gate` runs it against `cf dev`.
 */
import { parseArgs } from "node:util";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

/** Runs the smoke flow; returns true when every step behaved as expected. */
export async function mcpSmoke(opts: {
  url: string;
  token: string;
  readOnly?: boolean;
  log?: (line: string) => void;
}): Promise<boolean> {
  const log = opts.log ?? console.log;
  const transport = new StreamableHTTPClientTransport(new URL("/mcp", opts.url), {
    requestInit: { headers: { Authorization: `Bearer ${opts.token}` } },
  });
  const client = new Client({ name: "okf-smoke", version: "1.0.0" });
  await client.connect(transport);

  let failed = false;
  const call = async (name: string, args: Record<string, unknown> = {}, expectError = false) => {
    const r = await client.callTool({ name, arguments: args });
    const text = (r.content as { text: string }[]).map((c) => c.text).join("\n");
    const ok = !!r.isError === expectError;
    if (!ok) failed = true;
    log(`${ok ? "ok  " : "FAIL"} mcp ${name} ${JSON.stringify(args).slice(0, 70)}`);
    if (!ok) log(text);
    return text;
  };

  const tools = (await client.listTools()).tools.map((t) => t.name);
  log(`mcp tools (${tools.length}): ${tools.join(", ")}`);
  await call("start");
  await call("browse");
  if (tools.includes("log")) await call("log", { limit: 3 });
  if (tools.includes("work")) await call("work");
  if (tools.includes("export")) {
    const url = /(https?:\/\/\S+)/.exec(await call("export"))?.[1];
    const res = url ? await fetch(url) : null;
    const ok = res?.status === 200 && res.headers.get("Content-Type") === "application/x-tar";
    if (!ok) failed = true;
    log(`${ok ? "ok  " : "FAIL"} mcp export download (${res?.status})`);
  }

  if (!opts.readOnly) {
    const path = `_smoke/note-${Date.now()}.md`;
    const doc = `---\ntype: Note\ntitle: Smoke\ndescription: MCP smoke test.\n---\nHello [self](/${path}).\n`;
    await call("write", { path, content: doc, note: "mcp smoke test" });
    await call("write", { path, content: doc }, true); // exists: needs if_match
    const read = await call("read", { path });
    if (!/hash: [0-9a-f]{64}/.test(read)) failed = true;
    await call("edit", { path, edits: [{ old: "Hello", new: "Hi" }], note: "mcp smoke edit" });
    await call("grep", { pattern: "Hi [self]", prefix: "_smoke" });
    if (tools.includes("search")) await call("search", { q: "smoke" });
    if (tools.includes("diff")) await call("diff", { path });
    const moved = path.replace("note-", "moved-");
    await call("move", { from: path, to: moved, note: "mcp smoke move" });
    const hash = /hash: ([0-9a-f]{64})/.exec(await call("read", { path: moved }))?.[1];
    await call("delete", { path: moved, if_match: hash, note: "mcp smoke cleanup" });
  }

  await client.close();
  return !failed;
}

if (import.meta.main) {
  const { values } = parseArgs({
    options: {
      url: { type: "string" },
      token: { type: "string" },
      "read-only": { type: "boolean" },
    },
  });
  if (!values.url || !values.token) {
    console.error("usage: bun scripts/mcp-smoke.ts --url <base> --token <token> [--read-only]");
    process.exit(2);
  }
  const ok = await mcpSmoke({
    url: values.url,
    token: values.token,
    readOnly: values["read-only"],
  });
  console.log(ok ? "MCP smoke passed" : "MCP smoke FAILED");
  process.exit(ok ? 0 : 1);
}
