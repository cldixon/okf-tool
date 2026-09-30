import { hashToken, newTokenSecret } from "./auth";
import { normalizeDir } from "./okf/paths";
import { OkfError } from "./store/errors";

/** The account layer the consent page needs (spec: Data model, D1 schema). */
export interface LibraryRef {
  id: string;
  slug: string;
  do_id: string;
}

export interface User {
  id: string;
  email: string;
  actor: string;
}

/** A bearer token as the Tokens page lists it; the secret itself is never stored. */
export interface TokenRow {
  id: string;
  library: string;
  actor: string;
  scope: "read" | "write";
  prefix: string | null;
  expires: string | null;
  mcp_tiers: string;
  created_by: string | null;
  revoked: string | null;
}

export interface NewToken {
  libraryId: string;
  actor: string;
  scope: "read" | "write";
  prefix: string | null;
  expires: string | null;
  mcpTiers: "all" | "files";
  /** The users row id of the human who minted it. */
  createdBy: string | null;
}

export interface Accounts {
  /** The users row for an Access identity, created on first sign-in. */
  user(email: string): Promise<User>;
  libraries(): Promise<LibraryRef[]>;
  createLibrary(slug: string, ownerId: string | null): Promise<LibraryRef>;
  /** Every token, newest first, with its library's slug and its minter's email. */
  tokens(): Promise<TokenRow[]>;
  /** Stores a new token's hash; returns the secret, which is shown once and never again. */
  createToken(t: NewToken): Promise<{ id: string; secret: string }>;
  revokeToken(id: string): Promise<void>;
}

const AGENT_ACTOR = /^[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._-]*$/;
const PROCESS_ACTOR = /^process:[a-z0-9][a-z0-9._-]*$/;

/**
 * Checks a new token's fields (spec: Auth, identity and actors). The actor is `<app>/<label>`,
 * `process:<id>`, or `human:` only when `human` is the signed-in human's own actor.
 */
export function checkNewToken(
  input: {
    actor: string;
    scope: string;
    prefix?: string | null;
    expires?: string | null;
    mcpTiers?: string;
  },
  human: string | null,
): Omit<NewToken, "libraryId" | "createdBy"> {
  const actor = input.actor.trim().toLowerCase();
  if (actor.startsWith("human:")) {
    if (actor !== human) {
      throw new OkfError(
        403,
        "human_actor",
        human
          ? `A human: token can only carry your own actor, ${human}.`
          : "human: tokens are minted only in the web UI, by the signed-in human.",
      );
    }
  } else if (!AGENT_ACTOR.test(actor) && !PROCESS_ACTOR.test(actor)) {
    throw new OkfError(
      400,
      "bad_actor",
      "The actor must look like app/label (e.g. claude-code/laptop) or process:name (e.g. process:nightly-verify).",
    );
  }
  if (input.scope !== "read" && input.scope !== "write") {
    throw new OkfError(400, "bad_scope", "`scope` is read or write.");
  }
  const rawPrefix = (input.prefix ?? "").trim();
  if (rawPrefix.includes(".."))
    throw new OkfError(400, "bad_prefix", "The directory cannot contain '..'.");
  let expires: string | null = null;
  const e = (input.expires ?? "").trim();
  if (e) {
    // A date means the end of that day, UTC.
    const iso = /^\d{4}-\d{2}-\d{2}$/.test(e) ? `${e}T23:59:59Z` : e;
    const t = Date.parse(iso);
    if (Number.isNaN(t) || !/(?:Z|[+-]\d\d:\d\d)$/.test(iso)) {
      throw new OkfError(
        400,
        "bad_expires",
        "`expires` is a date (2026-12-31) or an ISO 8601 datetime with an offset.",
      );
    }
    if (t <= Date.now()) throw new OkfError(400, "bad_expires", "`expires` is in the past.");
    expires = new Date(t).toISOString();
  }
  return {
    actor,
    scope: input.scope,
    prefix: normalizeDir(rawPrefix) || null,
    expires,
    mcpTiers: input.mcpTiers === "files" ? "files" : "all",
  };
}

const SLUG = /^[a-z0-9][a-z0-9-]{0,62}$/;

export function checkSlug(slug: string): string {
  const s = slug.trim().toLowerCase();
  if (!SLUG.test(s)) {
    throw new OkfError(
      400,
      "bad_slug",
      "A library name uses lowercase letters, digits and hyphens, up to 63 characters.",
    );
  }
  return s;
}

/** `human:<email local part>` by default (spec: Auth, identity and actors). */
export function humanActor(email: string): string {
  const local =
    email
      .split("@")[0]
      ?.toLowerCase()
      .replace(/[^a-z0-9._-]/g, "-") || "user";
  return `human:${local}`;
}

export function d1Accounts(db: D1Database): Accounts {
  return {
    async user(email) {
      const found = await db
        .prepare("SELECT id, email, actor FROM users WHERE email = ?")
        .bind(email)
        .first<User>();
      if (found) return found;
      const user = { id: `user_${crypto.randomUUID()}`, email, actor: humanActor(email) };
      await db
        .prepare("INSERT INTO users (id, email, actor, created) VALUES (?, ?, ?, ?)")
        .bind(user.id, user.email, user.actor, new Date().toISOString())
        .run();
      return user;
    },
    async libraries() {
      const r = await db
        .prepare("SELECT id, slug, do_id FROM libraries ORDER BY slug")
        .all<LibraryRef>();
      return r.results;
    },
    async createLibrary(slugInput, ownerId) {
      const slug = checkSlug(slugInput);
      const id = `lib_${crypto.randomUUID()}`;
      const r = await db
        .prepare(
          "INSERT OR IGNORE INTO libraries (id, slug, owner, visibility, created, do_id) VALUES (?, ?, ?, 'private', ?, ?)",
        )
        .bind(id, slug, ownerId, new Date().toISOString(), id)
        .run();
      if (!r.meta.changes) {
        throw new OkfError(409, "library_exists", `A library named ${slug} already exists.`);
      }
      return { id, slug, do_id: id };
    },
    async tokens() {
      const r = await db
        .prepare(
          `SELECT t.id, l.slug AS library, t.actor, t.scope, t.prefix, t.expires, t.mcp_tiers,
                  u.email AS created_by, t.revoked
           FROM tokens t JOIN libraries l ON l.id = t.library
           LEFT JOIN users u ON u.id = t.created_by
           ORDER BY t.rowid DESC`,
        )
        .all<TokenRow>();
      return r.results;
    },
    async createToken(t) {
      const id = `tok_${crypto.randomUUID()}`;
      const secret = newTokenSecret();
      await db
        .prepare(
          `INSERT INTO tokens (id, hash, library, actor, scope, prefix, expires, mcp_tiers, created_by)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(
          id,
          hashToken(secret),
          t.libraryId,
          t.actor,
          t.scope,
          t.prefix,
          t.expires,
          t.mcpTiers,
          t.createdBy,
        )
        .run();
      return { id, secret };
    },
    async revokeToken(id) {
      const r = await db
        .prepare("UPDATE tokens SET revoked = ? WHERE id = ? AND revoked IS NULL")
        .bind(new Date().toISOString(), id)
        .run();
      if (!r.meta.changes) throw new OkfError(404, "not_found", "No such active token.");
    },
  };
}
