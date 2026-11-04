import { bytesToHex, randomBytes } from "@noble/hashes/utils.js";
import type { LibraryRef, MemberRole, User } from "./accounts";
import { type AuthCache, libraryTag, sessionTag, userTag } from "./authcache";
import { sha256Hex } from "./format/hash";

/**
 * Browser sign-in (v2 spec: Accounts and sign-in): single-use magic links, each with a code to
 * type on the device that asked (TEMPRA-188), then a session cookie. Only hashes of link, code and
 * session secrets are stored, in D1.
 */

export const SESSION_COOKIE = "__Host-tempra_session";
export const SESSION_IDLE_DAYS = 30;
export const SESSION_MAX_DAYS = 90;
export const LINK_MINUTES = 15;
/** Sign-in emails per address, and per IP, in any hour. */
export const LINKS_PER_EMAIL_HOUR = 5;
export const LINKS_PER_IP_HOUR = 20;
/** Wrong codes against an email's live links before their codes stop working (the links do not). */
export const CODE_TRIES = 5;
/** last_seen (and the idle expiry) is written at most this often. */
const TOUCH_MS = 3_600_000;
const DAY_MS = 86_400_000;

export interface Sessions {
  /**
   * A new link's secret, or null when this email or IP has asked too often. A link signs in, or,
   * with purpose "email-change", confirms `email` as the new address of account `user`. A sign-in
   * link may carry a code (`newCode`), stored as its hash, that does what the link does.
   */
  createLink(
    email: string,
    ip: string | null,
    change?: { user: string } | null,
    code?: string,
  ): Promise<string | null>;
  /** Uses up a link of that purpose: its email (and account), or null if unknown, used or expired. */
  consumeLink(
    secret: string,
    purpose?: LinkPurpose,
    /** For an email change: only this account's link is used up. */
    user?: string,
  ): Promise<{ email: string; user: string | null } | null>;
  /**
   * Uses up the live sign-in link of `email` whose code this is (as typed: `normalizeCode`); its
   * email and account, or null. A wrong code counts a try against every live link of the email,
   * and at CODE_TRIES their codes no longer work.
   */
  consumeCode(email: string, typed: string): Promise<{ email: string; user: string | null } | null>;
  /** A live link of that purpose without using it up: its email and account, or null. */
  peekLink(
    secret: string,
    purpose: LinkPurpose,
  ): Promise<{ email: string; user: string | null } | null>;
  /** Starts a session; returns the cookie's secret. */
  create(userId: string, userAgent: string | null): Promise<string>;
  /** The signed-in user for a cookie's secret, or null. */
  user(secret: string): Promise<User | null>;
  /**
   * The signed-in user for a cookie's secret, with the library `owner`/`slug` and their
   * membership in it, in one query (TEMPRA-192): what `authorizeLibrary` decides on for the app's
   * library requests, which made two or three round trips to D1 for it. Null when the session is
   * not live; `library` null when no library answers to that name (none, or its owner suspended).
   */
  access(secret: string, owner: string, slug: string): Promise<SessionAccess | null>;
  end(secret: string): Promise<void>;
  /** Signs the user out everywhere. */
  endAll(userId: string): Promise<void>;
  /** The user's live sessions, newest first; `id` is the stored hash, not the secret. */
  list(userId: string): Promise<SessionInfo[]>;
  /** Ends one of the user's sessions by id. */
  endById(userId: string, id: string): Promise<void>;
}

export type LinkPurpose = "sign-in" | "email-change";

/** A session's person, and a library by name with their membership, as one query finds them. */
export interface SessionAccess {
  user: User;
  library: (LibraryRef & { ownerId: string }) | null;
  /** Their role as a member; null when not one (an owner is never a member). */
  memberRole: MemberRole | null;
}

export interface SessionInfo {
  id: string;
  created: string;
  last_seen: string;
  user_agent: string | null;
}

/** A session's id (the stored hash) from the cookie's secret, to mark "this device". */
export const sessionId = (secret: string) => sha256Hex(secret);

export const newSecret = () => bytesToHex(randomBytes(32));
const hash = (secret: string) => sha256Hex(secret);

/** Crockford's base32: digits and capitals without I, L, O and U, so nothing reads as another. */
const CODE_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const CODE_LENGTH = 8;

/**
 * A sign-in code: 8 characters of Crockford's base32 (40 bits), shown as one word with no dash,
 * so a double-tap on a phone selects all of it.
 */
export function newCode(): string {
  // 32 divides 256, so a byte's low five bits are uniform.
  return [...randomBytes(CODE_LENGTH)].map((b) => CODE_ALPHABET[b & 31]).join("");
}

/**
 * A code as typed, in any case, with or without a dash or spaces; O reads as 0, I and L as 1
 * (Crockford). Null when it cannot be a code.
 */
export function normalizeCode(typed: string): string | null {
  const code = typed.toUpperCase().replace(/[\s-]/g, "").replace(/O/g, "0").replace(/[IL]/g, "1");
  if (code.length !== CODE_LENGTH) return null;
  return [...code].every((ch) => CODE_ALPHABET.includes(ch)) ? code : null;
}

/** What is stored for a code: bound to its email, so a code works only for the address it went to. */
const codeHash = (email: string, code: string) => sha256Hex(`${email}\n${code}`);
const iso = (ms: number) => new Date(ms).toISOString();

/** What `access` adds to a session's row: the library by name, and the person's membership. */
interface LibraryColumns {
  lib_id: string | null;
  lib_slug: string | null;
  lib_do_id: string | null;
  lib_owner: string | null;
  lib_owner_id: string | null;
  member_role: MemberRole | null;
}

interface SessionRow {
  hash: string;
  last_seen: string;
  expires: string;
  id: string;
  email: string;
  actor: string;
  handle: string;
  theme: string | null;
}

/** A copy of a kept answer, so no caller can change what the next request is served. */
const copyAccess = (a: SessionAccess): SessionAccess => ({
  user: { ...a.user },
  library: a.library ? { ...a.library } : null,
  memberRole: a.memberRole,
});

export function d1Sessions(
  db: D1Database,
  now = () => Date.now(),
  /**
   * The isolate's auth cache (TEMPRA-84, tempra-dev: v2/tenancy): a live session's person, and
   * its access to a library when that access lets it in, are kept for up to the cache's 30 s
   * (never past the session's own expiry), so a warm isolate answers with no D1 query. Ending a
   * session here drops them at once; anywhere else they last out their 30 s at most.
   */
  cache?: AuthCache,
): Sessions {
  /** How long an entry may be kept: the cache's window, cut short by the session's expiry. */
  const keepFor = (row: SessionRow) =>
    cache ? Math.min(cache.ms, Date.parse(row.expires) - now()) : 0;
  /**
   * A live session's row and person, with what `columns` and `joins` add to the one query;
   * `last_seen` (and the idle expiry) is moved on at most every TOUCH_MS.
   */
  async function live(
    secret: string,
    columns = "",
    joins = "",
    binds: string[] = [],
  ): Promise<{ row: SessionRow; user: User } | null> {
    const t = now();
    const row = await db
      .prepare(
        `SELECT s.hash, s.last_seen, s.expires, u.id, u.email, u.actor, u.handle, u.theme${columns}
         FROM sessions s JOIN users u ON u.id = s.user
         ${joins}
         WHERE s.hash = ?1 AND s.idle_expires > ?2 AND s.expires > ?2 AND u.suspended IS NULL`,
      )
      .bind(hash(secret), iso(t), ...binds)
      .first<SessionRow>();
    if (!row) return null;
    if (t - Date.parse(row.last_seen) > TOUCH_MS) {
      const idle = Math.min(t + SESSION_IDLE_DAYS * DAY_MS, Date.parse(row.expires));
      await db
        .prepare("UPDATE sessions SET last_seen = ?, idle_expires = ? WHERE hash = ?")
        .bind(iso(t), iso(idle), row.hash)
        .run();
    }
    const user: User = {
      id: row.id,
      email: row.email,
      actor: row.actor,
      handle: row.handle,
      theme: row.theme === "light" || row.theme === "dark" ? row.theme : null,
    };
    return { row, user };
  }

  /** `access` from D1: the same conditions as `user`, `Accounts.library` and `memberRole`, joined. */
  async function access(
    secret: string,
    owner: string,
    slug: string,
  ): Promise<{ row: SessionRow; result: SessionAccess } | null> {
    const got = await live(
      secret,
      `, l.id AS lib_id, l.slug AS lib_slug, l.do_id AS lib_do_id, o.handle AS lib_owner,
         o.id AS lib_owner_id, m.role AS member_role`,
      `LEFT JOIN users o ON o.handle = ?3 AND o.suspended IS NULL
       LEFT JOIN libraries l ON l.owner = o.id AND l.slug = ?4
       LEFT JOIN library_members m ON m.library = l.id AND m.user = u.id`,
      [owner, slug],
    );
    if (!got) return null;
    const r = got.row as SessionRow & LibraryColumns;
    const library =
      r.lib_id === null
        ? null
        : {
            id: r.lib_id,
            slug: r.lib_slug as string,
            do_id: r.lib_do_id as string,
            owner: r.lib_owner as string,
            ownerId: r.lib_owner_id as string,
          };
    return { row: got.row, result: { user: got.user, library, memberRole: r.member_role } };
  }

  return {
    async createLink(email, ip, change, code) {
      const t = now();
      const hourAgo = iso(t - 3_600_000);
      const counts = await db
        .prepare(
          `SELECT (SELECT COUNT(*) FROM sign_in_links WHERE email = ?1 AND created > ?2) AS by_email,
                  (SELECT COUNT(*) FROM sign_in_links WHERE ip = ?3 AND created > ?2) AS by_ip`,
        )
        .bind(email, hourAgo, ip ?? "")
        .first<{ by_email: number; by_ip: number }>();
      if ((counts?.by_email ?? 0) >= LINKS_PER_EMAIL_HOUR) return null;
      if (ip && (counts?.by_ip ?? 0) >= LINKS_PER_IP_HOUR) return null;
      const secret = newSecret();
      // Links older than a day are pruned by the daily cron (sweep.ts pruneAccounts).
      await db
        .prepare(
          `INSERT INTO sign_in_links (hash, email, created, expires, ip, purpose, user, code_hash)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(
          hash(secret),
          email,
          iso(t),
          iso(t + LINK_MINUTES * 60_000),
          ip,
          change ? "email-change" : "sign-in",
          change?.user ?? null,
          code && !change ? codeHash(email, code) : null,
        )
        .run();
      return secret;
    },

    async consumeCode(email, typed) {
      const t = iso(now());
      const live = `email = ?2 AND purpose = 'sign-in' AND used IS NULL AND expires > ?1
        AND code_hash IS NOT NULL`;
      const code = normalizeCode(typed);
      if (code) {
        const row = await db
          .prepare(
            `UPDATE sign_in_links SET used = ?1
             WHERE ${live} AND tries < ?3 AND code_hash = ?4
             RETURNING email, user`,
          )
          .bind(t, email, CODE_TRIES, codeHash(email, code))
          .first<{ email: string; user: string | null }>();
        if (row) return { email: row.email, user: row.user };
      }
      // A wrong code, or one that cannot be a code, is a try against every live code of the email.
      await db
        .prepare(`UPDATE sign_in_links SET tries = tries + 1 WHERE ${live}`)
        .bind(t, email)
        .run();
      return null;
    },

    async consumeLink(secret, purpose = "sign-in", user) {
      const t = iso(now());
      const row = await db
        .prepare(
          `UPDATE sign_in_links SET used = ?1
           WHERE hash = ?2 AND purpose = ?3 AND used IS NULL AND expires > ?1
             AND (?4 IS NULL OR user = ?4)
           RETURNING email, user`,
        )
        .bind(t, hash(secret), purpose, user ?? null)
        .first<{ email: string; user: string | null }>();
      return row ? { email: row.email, user: row.user } : null;
    },

    async peekLink(secret, purpose) {
      const row = await db
        .prepare(
          `SELECT email, user FROM sign_in_links
           WHERE hash = ?1 AND purpose = ?2 AND used IS NULL AND expires > ?3`,
        )
        .bind(hash(secret), purpose, iso(now()))
        .first<{ email: string; user: string | null }>();
      return row ? { email: row.email, user: row.user } : null;
    },

    async create(userId, userAgent) {
      const t = now();
      const secret = newSecret();
      await db
        .prepare(
          `INSERT INTO sessions (hash, user, created, last_seen, idle_expires, expires, user_agent)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(
          hash(secret),
          userId,
          iso(t),
          iso(t),
          iso(t + SESSION_IDLE_DAYS * DAY_MS),
          iso(t + SESSION_MAX_DAYS * DAY_MS),
          userAgent?.slice(0, 200) ?? null,
        )
        .run();
      return secret;
    },

    async user(secret) {
      const h = hash(secret);
      const key = `user\n${h}`;
      const hit = cache?.sessions.get(key) as User | undefined;
      if (hit) return { ...hit };
      const since = cache?.sessions.drops;
      const got = await live(secret);
      if (!got) return null;
      const tags = [sessionTag(h), userTag(got.user.id)];
      cache?.sessions.set(key, got.user, keepFor(got.row), tags, since);
      return { ...got.user };
    },

    async access(secret, owner, slug) {
      const h = hash(secret);
      const key = `access\n${h}\n${owner}\n${slug}`;
      const hit = cache?.sessions.get(key) as SessionAccess | undefined;
      if (hit) return copyAccess(hit);
      const since = cache?.sessions.drops;
      const found = await access(secret, owner, slug);
      if (!found) return null;
      // Only an answer that lets the person in is kept: a denial is asked again each time, so a
      // library shared with them, or made under that name, shows at once.
      const { result } = found;
      const lib = result.library;
      if (lib && (lib.ownerId === result.user.id || result.memberRole)) {
        cache?.sessions.set(
          key,
          result,
          keepFor(found.row),
          [sessionTag(h), userTag(result.user.id), userTag(lib.ownerId), libraryTag(lib.id)],
          since,
        );
      }
      return copyAccess(result);
    },

    async end(secret) {
      const h = hash(secret);
      await db.prepare("DELETE FROM sessions WHERE hash = ?").bind(h).run();
      cache?.drop(sessionTag(h));
    },

    async endAll(userId) {
      await db.prepare("DELETE FROM sessions WHERE user = ?").bind(userId).run();
      cache?.drop(userTag(userId));
    },

    async list(userId) {
      const t = iso(now());
      const r = await db
        .prepare(
          `SELECT hash AS id, created, last_seen, user_agent FROM sessions
           WHERE user = ?1 AND idle_expires > ?2 AND expires > ?2 ORDER BY last_seen DESC`,
        )
        .bind(userId, t)
        .all<SessionInfo>();
      return r.results;
    },

    async endById(userId, id) {
      await db.prepare("DELETE FROM sessions WHERE user = ? AND hash = ?").bind(userId, id).run();
      cache?.drop(sessionTag(id));
    },
  };
}

export function readCookie(req: Request, name: string): string | null {
  for (const part of (req.headers.get("Cookie") ?? "").split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === name) return v.join("=");
  }
  return null;
}

export function sessionCookie(secret: string): string {
  return `${SESSION_COOKIE}=${secret}; Path=/; Max-Age=${SESSION_MAX_DAYS * 86_400}; HttpOnly; Secure; SameSite=Lax`;
}

export const clearedSessionCookie = `${SESSION_COOKIE}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax`;

/** Where to go after signing in: only a path on this site. */
export function safeNext(next: string | null | undefined): string {
  if (!next?.startsWith("/") || next.startsWith("//") || next.includes("\\")) {
    return "/";
  }
  return next;
}
