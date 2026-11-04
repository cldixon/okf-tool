import type { Json, JsonObject, TrustTier, Verification } from "./types";

const ACTOR = /^(?:human:\S+|process:\S+|[^\s/:]+\/\S+)$/;
const OFFSET = /(?:Z|[+-]\d{2}:?\d{2})$/i;

/** The actor convention: `human:<id>`, `process:<id>` or `<producer>/<version>`. */
export function isActor(s: string): boolean {
  return ACTOR.test(s);
}

/** An ISO 8601 datetime with an explicit offset, as timestamps require. */
export function hasOffset(s: string): boolean {
  return /^\d{4}-\d{2}-\d{2}T/.test(s) && OFFSET.test(s);
}

function time(s: string | undefined): number {
  if (!s) return Number.NaN;
  return Date.parse(s);
}

/** a >= b for timestamps, falling back to string order when either does not parse. */
function atOrAfter(a: string, b: string): boolean {
  const ta = time(a);
  const tb = time(b);
  if (Number.isNaN(ta) || Number.isNaN(tb)) return a >= b;
  return ta >= tb;
}

/**
 * Trust tier (with the lapse rule): human-reviewed only while the latest `human:`
 * verification is at or after `generated.at`; machine-confirmed when any other verification exists.
 */
export function trustTier(generated: JsonObject | null, verified: Verification[]): TrustTier {
  if (verified.length === 0) return "unverified";
  const genAt = typeof generated?.at === "string" ? generated.at : null;
  const human = verified.filter((v) => v.by.startsWith("human:"));
  if (human.length > 0) {
    const latest = human.reduce((a, b) => (atOrAfter(b.at, a.at) ? b : a));
    if (genAt === null || atOrAfter(latest.at, genAt)) return "human-reviewed";
  }
  return verified.some((v) => !v.by.startsWith("human:")) ? "machine-confirmed" : "unverified";
}

/** A page is stale when `now >= stale_after`. */
export function isStale(staleAfter: Json | undefined, now = Date.now()): boolean {
  const t = staleTime(staleAfter);
  return t !== null && now >= t;
}

/** How far ahead of `stale_after` a page is stale soon (TEMPRA-63). */
export const STALE_SOON_DAYS = 14;
export const STALE_SOON_MS = STALE_SOON_DAYS * 86_400_000;

/** `stale_after` as epoch milliseconds, or null when absent or unparseable. */
export function staleTime(staleAfter: Json | undefined): number | null {
  if (typeof staleAfter !== "string") return null;
  const t = Date.parse(staleAfter);
  return Number.isNaN(t) ? null : t;
}

export type Staleness = "stale" | "stale_soon";

/**
 * Where a page stands against its clock: stale once `stale_after` has passed, stale soon within
 * STALE_SOON_DAYS of it. Only `stale_after` and the time decide it; no other write moves it.
 */
export function staleness(staleAfter: Json | undefined, now = Date.now()): Staleness | null {
  const t = staleTime(staleAfter);
  if (t === null) return null;
  if (now >= t) return "stale";
  return now + STALE_SOON_MS >= t ? "stale_soon" : null;
}

/** Absent status is `stable`. */
export function effectiveStatus(status: Json | undefined): string {
  return typeof status === "string" && status !== "" ? status : "stable";
}

/** Normalizes a `verified` value: a bare mapping is a one-element list. */
export function normalizeVerified(value: Json | undefined): Verification[] {
  if (value === undefined || value === null) return [];
  const list = Array.isArray(value) ? value : [value];
  const out: Verification[] = [];
  for (const v of list) {
    if (v && typeof v === "object" && !Array.isArray(v)) {
      const by = v.by;
      const at = v.at;
      if (typeof by === "string")
        out.push({ by, at: typeof at === "string" ? at : String(at ?? "") });
    }
  }
  return out;
}
