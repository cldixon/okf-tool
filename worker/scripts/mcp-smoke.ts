/**
 * `bun scripts/mcp-smoke.ts --url <base> --token <token> [--read-only]`: exercises the MCP server
 * with the SDK client, like an agent would. Without --read-only it writes, edits, moves and
 * deletes a scratch page under `_smoke/` and leaves the library's files as it found them
 * (the ledger keeps the events). `bun run gate` runs it against `cf dev`.
 */
import { parseArgs } from "node:util";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { localFetch } from "./local-fetch";

/** A 1×1 grey PNG, a real image for the upload step. */
const PIXEL_PNG = Uint8Array.from(
  atob(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAAAAAA6fptVAAAACklEQVR4nGNoAAAAggCBd81ytgAAAABJRU5ErkJggg==",
  ),
  (c) => c.charCodeAt(0),
);

/** Runs the smoke flow; returns true when every step behaved as expected. */
export async function mcpSmoke(opts: {
  url: string;
  token: string;
  readOnly?: boolean;
  log?: (line: string) => void;
}): Promise<boolean> {
  const log = opts.log ?? console.log;
  const transport = new StreamableHTTPClientTransport(new URL("/mcp", opts.url), {
    fetch: localFetch,
    requestInit: { headers: { Authorization: `Bearer ${opts.token}` } },
  });
  const client = new Client({ name: "tempra-smoke", version: "1.0.0" });
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
    const res = url ? await localFetch(url) : null;
    const ok = res?.status === 200 && res.headers.get("Content-Type") === "application/x-tar";
    if (!ok) failed = true;
    log(`${ok ? "ok  " : "FAIL"} mcp export download (${res?.status})`);
  }

  if (!opts.readOnly) {
    const path = `_smoke/note-${Date.now()}.md`;
    const doc = `---\ntype: Smoke Test\ntitle: Smoke\ndescription: MCP smoke test.\nstatus: draft\n---\nHello [self](/${path}).\n`;
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

    // A real file's bytes over an upload URL (TEMPRA-158), as an agent with a shell sends one;
    // nothing about the bytes is declared (TEMPRA-204).
    const png = PIXEL_PNG;
    const sha = new Bun.CryptoHasher("sha256").update(png).digest("hex");
    const file = `_smoke/pixel-${Date.now()}.png`;
    const prep = await call("prepare_upload", { path: file, note: "mcp smoke upload" });
    const url = /^curl -sS -T \S+ '(\S+)'$/m.exec(prep)?.[1];
    const put = url ? await localFetch(url, { method: "PUT", body: png }) : null;
    const res = put ? ((await put.json().catch(() => null)) as { hash?: string } | null) : null;
    const back = /download \(15 minutes\): (\S+)/.exec(await call("read", { path: file }))?.[1];
    const got = back ? new Uint8Array(await (await localFetch(back)).arrayBuffer()) : null;
    const uploaded =
      put?.status === 200 && res?.hash === sha && got !== null && Bun.deepEquals(got, png);
    if (!uploaded) failed = true;
    log(`${uploaded ? "ok  " : "FAIL"} mcp upload over prepare_upload (${put?.status})`);

    // An image comes back as image content that decodes (TEMPRA-153): scaled through the
    // IMAGES binding where there is one, else the original, which this PNG is small enough for.
    const r = await client.callTool({ name: "read", arguments: { path: file } });
    const blocks = r.content as { type: string; text?: string; data?: string; mimeType?: string }[];
    const img = blocks.find((b) => b.type === "image");
    const bytes = img?.data ? Uint8Array.from(atob(img.data), (c) => c.charCodeAt(0)) : null;
    const magic = bytes ? Array.from(bytes.subarray(0, 12), (b) => b.toString(16)).join(" ") : "";
    const decodes =
      !!bytes &&
      (magic.startsWith("89 50 4e 47") || // PNG
        magic.startsWith("ff d8") || // JPEG
        (magic.startsWith("52 49 46 46") && magic.endsWith("57 45 42 50"))); // RIFF....WEBP
    if (!decodes) failed = true;
    log(`${decodes ? "ok  " : "FAIL"} mcp read image (${img?.mimeType ?? "no image block"})`);
    await call("delete", { path: file, if_match: sha, note: "mcp smoke cleanup" });

    // Bytes typed into a tool argument are refused by name (TEMPRA-203).
    const typed = await call(
      "attach",
      { path: `_smoke/typed-${Date.now()}.png`, content_base64: "AAAA" },
      true,
    );
    const refused = typed.includes("base64_removed");
    if (!refused) failed = true;
    log(`${refused ? "ok  " : "FAIL"} mcp attach refuses typed bytes`);
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
