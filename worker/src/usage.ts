import type { TokenInfo } from "./auth";
import { OkfError } from "./store/errors";

/**
 * Rate limits and metering for tokens and connected apps (v2 spec: Limits, Metering). People in
 * the web UI are not rate limited; their writes are few and deliberate.
 */

export interface UsageEvent {
  kind: "request" | "write" | "email";
  /** The account: a library owner's handle, or an email for sign-in mail. */
  account: string;
  library?: string;
  bytes?: number;
}

export interface UsageDeps {
  /** True when the call may go ahead; absent means no limits (tests, local dev). */
  rateLimit?: (kind: "write" | "request", key: string) => Promise<boolean>;
  /** Records a data point; never throws, never blocks. */
  meter?: (e: UsageEvent) => void;
}

/** MCP tools that change a library. */
export const WRITE_TOOLS = new Set([
  "write",
  "edit",
  "move",
  "delete",
  "batch",
  "attach",
  "revert",
  "verify",
]);

/** Counts a request (and a write) for a token; 429 when it is over a per-minute limit. */
export async function admit(d: UsageDeps, token: TokenInfo, write: boolean): Promise<void> {
  const account = token.library.owner;
  const requestKey = `${token.id}|${token.library.id}|${token.actor}`;
  if (d.rateLimit && !(await d.rateLimit("request", requestKey))) {
    throw new OkfError(429, "rate_limited", "Too many requests from this token; slow down.");
  }
  if (write && d.rateLimit && !(await d.rateLimit("write", account))) {
    throw new OkfError(
      429,
      "rate_limited",
      "Too many writes to this account in the last minute; slow down.",
    );
  }
  d.meter?.({ kind: "request", account, library: token.library.id });
  if (write) d.meter?.({ kind: "write", account, library: token.library.id });
}

/** Whether a JSON-RPC body (one message or a batch) calls a tool that writes. */
export function mcpWrites(body: unknown): boolean {
  const msgs = Array.isArray(body) ? body : [body];
  return msgs.some((m) => {
    const msg = m as { method?: string; params?: { name?: string } };
    return msg?.method === "tools/call" && WRITE_TOOLS.has(String(msg.params?.name ?? ""));
  });
}
