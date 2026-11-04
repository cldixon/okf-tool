import { handleMcp, type McpContext } from "../mcp/server";
import { StoreError } from "../store/errors";

/**
 * Tempra's own MCP server, called in process (TEMPRA-222; after the spike's, cldixon/tempra#62):
 * the tools, descriptions, instructions and results an outside agent gets over /mcp, built from
 * the same McpContext, without a network hop. Only the tools the turn may use are listed or
 * callable.
 */
export interface McpTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface ToolOutcome {
  text: string;
  isError: boolean;
}

/**
 * Tools that only read, in the order they are listed (a stable order keeps the cache). Only what
 * answering a thread needs (TEMPRA-231): every tool's definition is input on every model call, so
 * `start` (the prompt names the library; `browse` lists its root), `sources` (in `read`'s
 * frontmatter), `log` (`history` covers a page) and `work` (it files requests, never picks up
 * work) are left out.
 */
export const READ_TOOLS = [
  "browse",
  "read",
  "search",
  "grep",
  "query",
  "links",
  "history",
  "diff",
  "comments",
] as const;

/**
 * The turn's tools for the asker's role (tempra-dev: agents/managed-agent, What it may do): the
 * read-only tools and `comment` for everyone, and `edit` for a write member or the owner. Never
 * write, move, delete, batch, attach, prepare_upload, transform, revert, create_library, export.
 */
export function agentTools(mayEdit: boolean): string[] {
  return [...READ_TOOLS, ...(mayEdit ? ["edit"] : []), "comment"];
}

export class LocalMcp {
  private id = 0;
  private readonly allowed: Set<string>;

  constructor(
    private readonly ctx: McpContext,
    private readonly names: string[],
  ) {
    this.allowed = new Set(names);
  }

  private async rpc<T>(method: string, params: Record<string, unknown>): Promise<T> {
    const req = new Request(`${this.ctx.origin}/mcp`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: ++this.id, method, params }),
    });
    const res = await handleMcp(req, this.ctx);
    const body = (await res.json().catch(() => null)) as {
      result?: T;
      error?: { code: number; message: string };
    } | null;
    if (!body || body.error || body.result === undefined) {
      throw new StoreError(
        502,
        "mcp_failed",
        `MCP ${method} failed: ${body?.error?.message ?? `HTTP ${res.status}`}`,
      );
    }
    return body.result;
  }

  /** The turn's tools, in `names` order so the cached prefix never moves. */
  async tools(): Promise<McpTool[]> {
    const r = await this.rpc<{ tools: McpTool[] }>("tools/list", {});
    const byName = new Map(r.tools.map((t) => [t.name, t]));
    return this.names.flatMap((n) => {
      const t = byName.get(n);
      return t
        ? [{ name: t.name, description: t.description ?? "", inputSchema: t.inputSchema }]
        : [];
    });
  }

  async call(name: string, args: unknown): Promise<ToolOutcome> {
    if (!this.allowed.has(name)) return { text: `No tool named ${name} here.`, isError: true };
    const r = await this.rpc<{ content?: { type: string; text?: string }[]; isError?: boolean }>(
      "tools/call",
      { name, arguments: args && typeof args === "object" ? args : {} },
    );
    const text = (r.content ?? [])
      .map((c) => (c.type === "text" ? (c.text ?? "") : `[${c.type} not shown]`))
      .join("\n");
    return { text, isError: !!r.isError };
  }
}
