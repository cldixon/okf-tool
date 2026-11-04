/**
 * `bun run mcp`: call any Tempra MCP tool from a terminal, against a PR's preview, staging or
 * production, so an agent session (Claude Code in a container, a person at a shell) can work in
 * a deployment without a connector (tempra-dev: delivery/session-mcp). One call per run:
 *
 *   bun run mcp --pr 39 --library acme-retail tools               the tool list
 *   bun run mcp --pr 39 --library acme-retail work '{"kind":"comment"}'
 *   bun run mcp --pr 39 --library acme-retail comment '{"action":"reply","thread":"…","body":"…"}'
 *   bun run mcp --url https://tempra.dev comments                 with TEMPRA_TOKEN (any deployment)
 *
 * With --pr N, a write token for the operator's library on that preview is made once (through
 * `bun run preview token`) and kept in worker/.mcp-tokens.json (gitignored) for the next calls.
 * The actor is --actor (default claude-code/dev): every write is attributed to it in the ledger.
 * Nothing is created in production or staging: there, bring a token (TEMPRA_TOKEN or --token).
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const { values, positionals } = parseArgs({
  args: process.argv.slice(2),
  allowPositionals: true,
  options: {
    pr: { type: "string" },
    url: { type: "string" },
    token: { type: "string" },
    library: { type: "string" },
    actor: { type: "string" },
    json: { type: "boolean" },
  },
});

const usage = `Usage: bun run mcp (--pr N --library <slug> | --url <base> [--token T]) [--actor A] <tool|tools> ['{json args}']`;
const [tool, rawArgs] = positionals;
if (!tool || (!values.pr && !values.url)) {
  console.error(usage);
  process.exit(2);
}

const WORKER = join(import.meta.dir, "..");
const CACHE = join(WORKER, ".mcp-tokens.json");
type Cached = { url: string; owner: string; slug: string; actor: string; token: string };

/** A token for the operator's library on PR N's preview: cached, or made once. */
async function previewToken(pr: string, slug: string, actor: string): Promise<Cached> {
  const key = `pr-${pr} ${slug} ${actor}`;
  const cache: Record<string, Cached> = existsSync(CACHE)
    ? JSON.parse(readFileSync(CACHE, "utf8"))
    : {};
  const hit = cache[key];
  if (hit) return hit;
  const proc = Bun.spawn(
    ["bun", "scripts/preview.ts", "token", "--pr", pr, "--slug", slug, "--actor", actor],
    { cwd: WORKER, stdout: "pipe", stderr: "inherit" },
  );
  const out = await new Response(proc.stdout).text();
  if ((await proc.exited) !== 0) throw new Error(`Could not get a token for PR ${pr}.`);
  const made = JSON.parse(out.trim().split("\n").at(-1) ?? "{}") as Cached;
  cache[key] = made;
  writeFileSync(CACHE, `${JSON.stringify(cache, null, 2)}\n`, { mode: 0o600 });
  return made;
}

let base: string;
let token: string;
let library: string | undefined;
if (values.pr) {
  if (!values.library) {
    console.error("--pr needs --library <slug> (one of the operator's libraries on the preview).");
    process.exit(2);
  }
  const t = await previewToken(values.pr, values.library, values.actor ?? "claude-code/dev");
  base = t.url;
  token = t.token;
  library = `${t.owner}/${t.slug}`;
} else {
  base = (values.url ?? "").replace(/\/+$/, "");
  token = values.token ?? process.env.TEMPRA_TOKEN ?? "";
  library = values.library;
  if (!token) {
    console.error("--url needs a token: --token T or TEMPRA_TOKEN.");
    process.exit(2);
  }
}

const transport = new StreamableHTTPClientTransport(new URL(`${base}/mcp`), {
  requestInit: { headers: { Authorization: `Bearer ${token}` } },
});
const client = new Client({ name: "tempra-cli", version: "1.0.0" });
await client.connect(transport);
try {
  if (tool === "tools") {
    const { tools } = await client.listTools();
    for (const t of tools) console.log(`${t.name}\t${(t.description ?? "").split("\n")[0]}`);
  } else {
    const args = rawArgs ? (JSON.parse(rawArgs) as Record<string, unknown>) : {};
    if (library && args.library === undefined) args.library = library;
    const r = await client.callTool({ name: tool, arguments: args });
    const text = (r.content as { type: string; text?: string }[])
      .map((c) => c.text ?? "")
      .join("\n");
    if (values.json) console.log(JSON.stringify({ isError: !!r.isError, text }));
    else console.log(text);
    if (r.isError) process.exitCode = 1;
  }
} finally {
  await client.close();
}
