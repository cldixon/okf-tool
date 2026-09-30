import { bytesToHex, randomBytes } from "@noble/hashes/utils.js";
import { sha256Hex } from "./okf/hash";
import { OkfError } from "./store/errors";

/** A bearer token bound to one actor and one library (spec: Auth, identity and actors). */
export interface TokenInfo {
  id: string;
  actor: string;
  scope: "read" | "write";
  prefix: string | null;
  mcp_tiers: string;
  library: { id: string; slug: string; do_id: string };
  /** The users row id of the human who minted the token, when known. */
  created_by?: string | null;
}

export type Authenticate = (secret: string) => Promise<TokenInfo>;

/** Only a hash of each secret is stored. */
export const hashToken = (secret: string) => sha256Hex(secret);

export function newTokenSecret(): string {
  return `okf_${bytesToHex(randomBytes(24))}`;
}

interface TokenRow {
  id: string;
  actor: string;
  scope: string;
  prefix: string | null;
  mcp_tiers: string;
  expires: string | null;
  revoked: string | null;
  created_by: string | null;
  library_id: string;
  slug: string;
  do_id: string;
}

const CACHE_MS = 30_000;

/** Looks tokens up in D1 by hash, with a short per-isolate cache so revocation lands within 30s. */
export function d1Authenticate(db: D1Database, now = () => Date.now()): Authenticate {
  const cache = new Map<string, { row: TokenRow | null; at: number }>();
  return async (secret) => {
    const hash = hashToken(secret);
    let hit = cache.get(hash);
    if (!hit || now() - hit.at > CACHE_MS) {
      const row = await db
        .prepare(
          `SELECT t.id, t.actor, t.scope, t.prefix, t.mcp_tiers, t.expires, t.revoked, t.created_by,
                  l.id AS library_id, l.slug, l.do_id
           FROM tokens t JOIN libraries l ON l.id = t.library WHERE t.hash = ?`,
        )
        .bind(hash)
        .first<TokenRow>();
      hit = { row, at: now() };
      if (cache.size > 1000) cache.clear();
      cache.set(hash, hit);
    }
    const row = hit.row;
    if (!row) throw new OkfError(401, "bad_token", "Unknown bearer token.");
    if (row.revoked) throw new OkfError(401, "token_revoked", "This token has been revoked.");
    if (row.expires && Date.parse(row.expires) <= now()) {
      throw new OkfError(401, "token_expired", "This token has expired.");
    }
    return {
      id: row.id,
      actor: row.actor,
      scope: row.scope === "write" ? "write" : "read",
      prefix: row.prefix || null,
      mcp_tiers: row.mcp_tiers,
      library: { id: row.library_id, slug: row.slug, do_id: row.do_id },
      created_by: row.created_by,
    };
  };
}
