import { OkfError } from "./store/errors";

/**
 * Per-account limits (v2 spec: Limits, abuse and metering). Defaults here; an account's overrides
 * live in users.limits as JSON (`bun run admin limits`).
 */
export interface Limits {
  /** Libraries an account may own. */
  libraries: number;
  /** Active (unrevoked, unexpired) bearer tokens across the account's libraries. */
  tokens: number;
}

export const DEFAULT_LIMITS: Limits = { libraries: 5, tokens: 50 };

/**
 * Per-minute rate limits are per deployment, in the Rate Limiting bindings (cloudflare.config.ts):
 * 60 writes per account and 600 requests per token or connected app.
 */

/** Storage per library, SQLite plus its attachments; set per deployment (LIBRARY_STORAGE_MB). */
export const DEFAULT_STORAGE_MB = 100;

/** An account's limits: the defaults with its overrides (unknown keys and bad values ignored). */
export function limitsFrom(json: string | null | undefined): Limits {
  const limits = { ...DEFAULT_LIMITS };
  if (!json) return limits;
  try {
    const o = JSON.parse(json) as Record<string, unknown>;
    for (const k of Object.keys(limits) as (keyof Limits)[]) {
      const v = o[k];
      if (typeof v === "number" && Number.isInteger(v) && v >= 0) limits[k] = v;
    }
  } catch {}
  return limits;
}

export function overLimit(what: string, limit: number): OkfError {
  return new OkfError(
    403,
    "limit_reached",
    `You have reached the limit of ${limit} ${what}. Delete some, or ask for more.`,
  );
}
