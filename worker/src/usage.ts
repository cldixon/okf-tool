import type { TokenInfo } from "./auth";
import { sha256Hex } from "./format/hash";
import type { Quota } from "./quota";
import { StoreError } from "./store/errors";

/**
 * Rate limits and metering (tempra-dev: v2/limits): tokens and connected apps by request and by
 * the account's writes; a browser session by request alone (TEMPRA-80), so agents spending the
 * account's write budget never lock its person out of the app.
 */

/** Seconds a client over a per-minute limit is told to wait (`Retry-After`): the limiters' period. */
export const RETRY_AFTER_S = 60;

export interface UsageEvent {
  /**
   * A request, a write, a sign-in email, a change-feed connection opened, an image handed to a
   * model over MCP (TEMPRA-153; bytes: what was sent), a PDF handed to one (TEMPRA-164), a
   * diagram drawn by the render Worker (TEMPRA-165), or a file fetched from a URL an agent named
   * (TEMPRA-157; bytes: what was read).
   */
  kind:
    | "request"
    | "write"
    | "email"
    | "feed"
    | "read_image"
    | "read_pdf"
    | "render"
    | "fetch"
    | "cost";
  /** The account: a library owner's handle, or an email for sign-in mail. */
  account: string;
  library?: string;
  bytes?: number;
  /**
   * `cost` (TEMPRA-228): what one MCP tool call or REST request cost its library's object, under
   * `op` (`mcp:write`, `GET /files/*`, or `read_flush` for the object's own flush of read counts).
   */
  op?: string;
  cost?: {
    /** Library DO calls. */
    calls: number;
    rowsRead: number;
    rowsWritten: number;
    /** Of rowsWritten: the search index's (`fts`, `fts_rows`) and the read counts' flush. */
    ftsRowsWritten: number;
    readFlushRowsWritten: number;
    /** The round trips to the object, summed. */
    ms: number;
  };
}

/**
 * An Analytics Engine data point for a usage event. The first blobs and doubles keep their places
 * (kind, account, library; 1, bytes); a cost adds its op as blob 4 and doubles 3 to 8: calls,
 * rows read, rows written, FTS rows written, read-flush rows written, ms (TEMPRA-228).
 */
export function usagePoint(e: UsageEvent): {
  blobs: string[];
  doubles: number[];
  indexes: string[];
} {
  const c = e.cost;
  return {
    blobs: [e.kind, e.account, e.library ?? "", ...(e.op !== undefined ? [e.op] : [])],
    doubles: [
      1,
      e.bytes ?? 0,
      ...(c
        ? [c.calls, c.rowsRead, c.rowsWritten, c.ftsRowsWritten, c.readFlushRowsWritten, c.ms]
        : []),
    ],
    indexes: [e.account.slice(0, 96)],
  };
}

export interface UsageDeps {
  /** True when the call may go ahead; absent means no limits (tests, local dev). */
  /**
   * One against a limiter; `render` is the MCP render cap per account (TEMPRA-166), keyed
   * `render:<account>` on WRITE_LIMITER, whose limit (60 a minute) is the render limit too.
   */
  rateLimit?: (kind: "write" | "request" | "session" | "render", key: string) => Promise<boolean>;
  /** Records a data point; never throws, never blocks. */
  meter?: (e: UsageEvent) => void;
  /** The monthly quotas (quota.ts, TEMPRA-232); absent means none. One per isolate. */
  quota?: Quota;
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
  "comment",
  "create_library",
]);

/** Who a request counts against: a per-token (or per-connection) key and the account. */
export interface Admission {
  key: string;
  /** The account: the handle of the person the caller acts for. */
  account: string;
  library?: string;
}

export function tokenAdmission(token: TokenInfo): Admission {
  // Grants approved before A1 carry no owner handle; their library id stands in until reconnected.
  return {
    key: `${token.id}|${token.library.id}|${token.actor}`,
    // The person it acts for (a member's agents spend the member's budget, not the owner's).
    account: token.person || token.library.owner || token.library.id,
    library: token.library.id,
  };
}

/**
 * Counts a request (and a write); 429 when it is over a per-minute limit. `limited: false` meters
 * without these limits: a person in the web UI, held to their session's own (admitSession).
 */
export async function admit(
  d: UsageDeps,
  who: Admission,
  write: boolean,
  limited = true,
): Promise<void> {
  const { key, account, library } = who;
  if (limited && d.rateLimit && !(await d.rateLimit("request", key))) {
    throw new StoreError(429, "rate_limited", "Too many requests from this token; slow down.");
  }
  if (limited && write && d.rateLimit && !(await d.rateLimit("write", account))) {
    throw new StoreError(
      429,
      "rate_limited",
      "Too many writes to this account in the last minute; slow down.",
    );
  }
  // The month's requests (TEMPRA-232, quota.ts): counted in memory, 403 past the ceiling.
  if (limited) await d.quota?.admitRequest(account);
  d.meter?.({ kind: "request", account, library });
  if (write) d.meter?.({ kind: "write", account, library });
}

/**
 * Counts a request made with a session cookie (TEMPRA-80): every page, API call and feed upgrade
 * of one browser session, keyed by the session's stored hash (the cookie's secret never leaves
 * the Worker). Per session, as a token is limited per token; a second session takes a sign-in
 * link, and those are limited too. 429 when over SESSION_LIMITER's per-minute limit.
 */
export async function admitSession(d: UsageDeps, secret: string): Promise<void> {
  if (d.rateLimit && !(await d.rateLimit("session", `session:${sha256Hex(secret)}`))) {
    throw new StoreError(
      429,
      "rate_limited",
      "Too many requests from this browser session; wait a minute.",
    );
  }
}

/** Whether a JSON-RPC body (one message or a batch) calls a tool that writes. */
export function mcpWrites(body: unknown): boolean {
  const msgs = Array.isArray(body) ? body : [body];
  return msgs.some((m) => {
    const msg = m as { method?: string; params?: { name?: string } };
    return msg?.method === "tools/call" && WRITE_TOOLS.has(String(msg.params?.name ?? ""));
  });
}
