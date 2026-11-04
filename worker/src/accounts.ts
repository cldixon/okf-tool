import { type AgentKey, agentId } from "./agents";
import { hashToken, newTokenSecret } from "./auth";
import { checkHandle, HANDLE_HOLD_DAYS, handleFromEmail } from "./handles";
import { type Limits, limitsFrom, overLimit } from "./limits";
import { sha256Hex } from "./okf/hash";
import { normalizeDir } from "./okf/paths";
import { OkfError } from "./store/errors";

/** A library, addressed as {owner}/{slug} (v2 spec: Tenancy and authorization). */
export interface LibraryRef {
  id: string;
  slug: string;
  do_id: string;
  /** The owner's handle. */
  owner: string;
}

/**
 * What a caller may do in a library (tempra-dev: v2/sharing): `read` reads and comments, `write`
 * also writes content and verifies, the owner also deletes, transfers, restores and shares.
 */
export type Role = "owner" | "write" | "read";
/** A member's role; the owner is `libraries.owner`, never a member. */
export type MemberRole = Exclude<Role, "owner">;

/** A library the account reaches, as its owner or as a member. */
/** A library the user reaches, with their role and what its creator said it is for. */
export type ReachableLibrary = LibraryRef & {
  role: Role;
  title?: string | null;
  description?: string | null;
  /** When it was made (ISO), the library list's last activity before its first event. */
  created?: string | null;
};

/** A member of a library, as its owner sees the list. */
export interface Member {
  user: string;
  handle: string;
  role: MemberRole;
  created: string;
}

/** An agent acting for a person (agents.ts), as the app shows it. */
export interface AgentRow {
  id: string;
  name: string;
  platform: string;
  /** The person's current handle. */
  person: string;
  first_seen: string;
  last_seen: string;
  client: string | null;
}

/** A pending invitation to a library (TEMPRA-61). */
export interface Invitation {
  id: string;
  /** The library, as {owner}/{slug}. */
  owner: string;
  slug: string;
  role: MemberRole;
  /** The invited person's handle (the owner's view) or the inviter's (the invitee's view). */
  handle: string;
  created: string;
  expires: string;
}

/** How long an invitation stays open. */
export const INVITATION_DAYS = 14;
/** Invitations a library may send a day: enough for a team, too few to spam with. */
export const INVITATIONS_PER_DAY = 20;

/** A person's theme (take 4): light or dark, or null for the system's. */
export type Theme = "light" | "dark";

export function checkTheme(v: unknown): Theme | null {
  if (v === null || v === undefined || v === "system" || v === "") return null;
  if (v === "light" || v === "dark") return v;
  throw new OkfError(400, "bad_theme", "The theme is system, light or dark.");
}

/** The longest name an account may have, in characters (TEMPRA-54). */
export const NAME_MAX = 80;

/**
 * An account's name as given (TEMPRA-54; tempra-dev: v2/accounts, Name): trimmed, each run of
 * spaces made one, at most NAME_MAX characters, no control characters. Empty or null clears it.
 */
export function checkName(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  if (typeof v !== "string") throw new OkfError(400, "bad_name", "The name is text.");
  const name = v.trim().replace(/ {2,}/g, " ").normalize("NFC");
  if (/[\p{Cc}\p{Zl}\p{Zp}]/u.test(name)) {
    throw new OkfError(400, "bad_name", "The name cannot hold control characters or line breaks.");
  }
  if (name === "") return null;
  if (Array.from(name).length > NAME_MAX) {
    throw new OkfError(400, "bad_name", `The name is at most ${NAME_MAX} characters.`);
  }
  return name;
}

export interface User {
  id: string;
  email: string;
  actor: string;
  handle: string;
  /** The person's theme, or null for the system's (not every load carries it). */
  theme?: Theme | null;
  /** The person's name, or null when they gave none (TEMPRA-54; not every load carries it). */
  name?: string | null;
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

/**
 * The account layer (v2 spec: Accounts, Tenancy). Every query that lists or changes libraries
 * or tokens is scoped to one user; nothing here returns another account's rows.
 */
export interface Accounts {
  /** The users row for a verified email, created (with a free handle) on first sign-in. */
  user(email: string): Promise<User>;
  /**
   * Whether this email may sign in under the deployment's SIGNUP mode (v2 spec: A4): an existing
   * account always may; open lets anyone in, invite only emails on the invite list.
   */
  mayJoin(email: string, mode: SignupMode): Promise<boolean>;
  /**
   * Records an email that asked for access (TEMPRA-125). `added` when it is new (the person is
   * told once); `notify` when the operator should be told too: it takes one of the day's notices
   * (WAITLIST_NOTICES_PER_DAY).
   */
  joinWaitlist(email: string, ip: string | null): Promise<{ added: boolean; notify: boolean }>;
  /** Emails waiting for the operator's decision, oldest first. */
  waitlist(): Promise<WaitlistEntry[]>;
  /**
   * Decides a waiting email: `invited` also puts it on the invite list. False when it is not
   * waiting (unknown, or decided already).
   */
  decideWaitlist(email: string, decision: "invited" | "dismissed"): Promise<boolean>;
  /**
   * The operator invites an email directly (TEMPRA-278, operator.ts): on the invite list, and a
   * waiting waitlist row decided as invited. `added` when it was not invited before.
   */
  inviteEmail(email: string): Promise<{ added: boolean }>;
  /**
   * Everyone invited, newest first, with the account each made (TEMPRA-278): `account` is null
   * until they sign up. Bounded by the invite list, which only the operator grows.
   */
  invited(): Promise<InvitedEntry[]>;
  /**
   * Counts for the operator's portal (TEMPRA-278): totals, and the people (by session) and agents
   * seen since each time.
   */
  activityCounts(since: { day: string; week: string; month: string }): Promise<ActivityCounts>;
  /** The account by its users row id; null when there is none or it is suspended. */
  account(userId: string): Promise<User | null>;
  /**
   * The handles and names of these accounts in one query (TEMPRA-84, TEMPRA-54), by users row
   * id; an id with no account, or a suspended one, is left out, as `account` would answer null.
   */
  people(userIds: string[]): Promise<Map<string, { handle: string; name: string | null }>>;
  /** The libraries the user owns, by name. */
  libraries(userId: string): Promise<LibraryRef[]>;
  /**
   * The libraries the user reaches: their own, then those shared with them, each with the
   * user's role (tempra-dev: v2/sharing). Owner-only screens and limits use `libraries`.
   */
  reachable(userId: string): Promise<ReachableLibrary[]>;
  /** The user's role as a member of a library; null when they are not one. */
  memberRole(libraryId: string, userId: string): Promise<MemberRole | null>;
  /** A library's members, by handle. */
  members(libraryId: string): Promise<Member[]>;
  /**
   * Makes a user a member of a library, or changes their role; 409 for the library's owner.
   * Invitations (TEMPRA-61) come later; until then the operator shares with `bun run admin`.
   */
  share(
    libraryId: string,
    userId: string,
    role: MemberRole,
    grantedBy: string | null,
  ): Promise<void>;
  /** Ends a membership; false when there was none. */
  unshare(libraryId: string, userId: string): Promise<boolean>;
  /**
   * Records that a person's agent connected (consent, a minted token, MCP initialize), with what
   * it said about itself; returns its id. Names agents only, never authorizes.
   */
  recordAgent(
    userId: string,
    key: AgentKey,
    seen?: { client?: string | null; userAgent?: string | null },
  ): Promise<string>;
  /** Agents by id, with their person's handle; unknown ids are left out. */
  agents(ids: string[]): Promise<AgentRow[]>;
  /** An account by handle or email, for inviting; null when there is none or it is suspended. */
  findAccount(by: { handle: string } | { email: string }): Promise<User | null>;
  /**
   * Invites an account to a library with a role, or renews a pending invitation (new role,
   * new expiry). 409 when they own it or are already a member; 429 past the daily limit.
   */
  invite(
    libraryId: string,
    userId: string,
    role: MemberRole,
    invitedBy: string,
  ): Promise<{ id: string; renewed: boolean }>;
  /** A library's pending invitations, by the invited person's handle. */
  libraryInvitations(libraryId: string): Promise<Invitation[]>;
  /** The person's pending invitations, with the inviter's handle. */
  invitations(userId: string): Promise<Invitation[]>;
  /**
   * Accepts or declines the person's own pending invitation; accepting makes them a member.
   * Null when there is no such open invitation for them.
   */
  decideInvitation(
    id: string,
    userId: string,
    accept: boolean,
  ): Promise<{ owner: string; slug: string; role: MemberRole } | null>;
  /** Withdraws a pending invitation to a library; false when there was none. */
  revokeInvitation(id: string, libraryId: string): Promise<boolean>;
  /** A library by its path, with its owner's users row id; null when there is none. */
  library(owner: string, slug: string): Promise<(LibraryRef & { ownerId: string }) | null>;
  /** A library by its Durable Object name, with its owner's users row id (for a maintainer). */
  libraryByDoId(doId: string): Promise<(LibraryRef & { ownerId: string }) | null>;
  /**
   * Creates a library owned by `owner`, within their library limit. With `grant`, a "selected"
   * app connection's id (AccountGrant.id), the connection that made it also reaches it
   * (grant_libraries), in the same transaction. Refuses `bad_slug`, `slug_taken` (409) and
   * `library_limit` (403).
   */
  createLibrary(
    slug: string,
    owner: Pick<User, "id" | "handle">,
    opts?: { title?: string | null; description?: string | null; grant?: string },
  ): Promise<LibraryRef & { title: string | null; description: string | null }>;
  /**
   * The libraries a "selected" connection created (TEMPRA-100), by id: only rows written by that
   * connection's own grant id for that same person.
   */
  grantLibraries(grantId: string, userId: string): Promise<string[]>;
  /** A library's title and description as its creator gave them; null when there is no such library. */
  about(libraryId: string): Promise<{ title: string | null; description: string | null } | null>;
  /**
   * Tokens on the user's libraries and those they minted on libraries shared with them, newest
   * first, with the library (its slug, or owner/slug when shared) and the minter's email.
   */
  tokens(userId: string): Promise<TokenRow[]>;
  /** Stores a new token's hash; returns the secret, which is shown once and never again. */
  createToken(t: NewToken): Promise<{ id: string; secret: string }>;
  /** Revokes a token on one of the user's libraries, or one they minted; 404 for anything else. */
  revokeToken(id: string, userId: string): Promise<void>;
  /** The account's limits: defaults with its overrides. */
  limits(userId: string): Promise<Limits>;
  /** What the account uses against its limits. */
  usage(userId: string): Promise<{ libraries: number; tokens: number }>;
  /** Moves the account to a new, confirmed email address; 409 if another account has it. */
  setEmail(userId: string, email: string): Promise<void>;
  /**
   * Changes the user's handle and, for future writes, their human: actor; 409 if another account
   * has it or holds it. The old handle is held for this account (v2 spec: Handles). The operator
   * may assign a reserved handle (`reserved: "allow"`).
   */
  setHandle(userId: string, handle: string, opts?: { reserved?: "allow" }): Promise<User>;
  /** The person's theme: light, dark, or null for the system's (take 4). */
  setTheme(userId: string, theme: Theme | null): Promise<void>;
  /** The person's name, checked by `checkName`, or null to clear it (TEMPRA-54). */
  setName(userId: string, name: string | null): Promise<void>;
  /**
   * Sets a library's title and description (TEMPRA-102): a field given is set (null clears it),
   * one left out keeps its value; the same limits as createLibrary. The route checks the owner.
   */
  describeLibrary(
    libraryId: string,
    about: { title?: string | null; description?: string | null },
  ): Promise<{ title: string | null; description: string | null }>;
  /** The current handle of the account that released `handle` within the hold, if any. */
  heldHandle(handle: string): Promise<string | null>;
  /** Removes a library's rows and its tokens. Its storage is wiped separately (lifecycle.ts). */
  deleteLibrary(libraryId: string): Promise<void>;
  /** Removes the user's rows (they own no libraries by now), keeps a tombstone, holds the handle. */
  deleteUser(user: Pick<User, "id" | "email" | "handle">): Promise<void>;
}

/**
 * The account's tokens, for its token limit: those it minted, and older ones on its libraries
 * with no recorded minter. A member's tokens on a shared library are the member's.
 */
const mintedBy = (n: number) =>
  `(created_by = ?${n} OR (created_by IS NULL AND library IN (SELECT id FROM libraries WHERE owner = ?${n})))`;
const MINTED_BY_1 = mintedBy(1);
const MINTED_BY_11 = mintedBy(11);

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

/**
 * An optional one-line text a person or agent gives a library (its title, its description):
 * trimmed, at most `max` characters, no line breaks or control characters, so it cannot pose as
 * more lines of `start` or of a page. Empty is null.
 */
export function checkLine(
  value: string | null | undefined,
  what: string,
  max: number,
): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string")
    throw new OkfError(400, `bad_${what}`, `The ${what} must be text.`);
  const s = value.trim();
  if (s === "") return null;
  // biome-ignore lint/suspicious/noControlCharactersInRegex: refusing control characters
  if (/[\u0000-\u001f\u007f\u2028\u2029]/.test(s) || s.length > max) {
    throw new OkfError(400, `bad_${what}`, `The ${what} is one line of at most ${max} characters.`);
  }
  return s;
}

export type SignupMode = "open" | "invite" | "closed";

/** An invited email and, once they signed up, their account (TEMPRA-278). */
export interface InvitedEntry {
  email: string;
  /** When they were invited (ISO). */
  invited: string;
  /** Their account, once they made one. */
  account: { handle: string | null; created: string | null } | null;
}

/** How many of each were seen in the last day, 7 days and 30 days. */
export interface Windows {
  day: number;
  week: number;
  month: number;
}

/** The operator's activity numbers (TEMPRA-278): people from sessions, agents from `agents`. */
export interface ActivityCounts {
  accounts: number;
  libraries: number;
  people: Windows;
  agents: Windows;
}

export interface WaitlistEntry {
  email: string;
  created: string;
}

/** At most this many waitlist notices a day reach the operator; the digest counts the rest. */
export const WAITLIST_NOTICES_PER_DAY = 10;

/** The deployment's SIGNUP var; anything unknown counts as invite. */
export function signupMode(value: string | undefined): SignupMode {
  return value === "open" || value === "closed" ? value : "invite";
}

/** The ledger actor of a person: `human:<handle>` (spec: Auth, identity and actors). */
export const humanActor = (handle: string) => `human:${handle}`;

export { checkHandle } from "./handles";

/** The oldest release time a hold still counts from. */
const holdCutoff = () => new Date(Date.now() - HANDLE_HOLD_DAYS * 86_400_000).toISOString();

export function d1Accounts(db: D1Database): Accounts {
  const limitsOf = async (userId: string) => {
    const row = await db
      .prepare("SELECT limits FROM users WHERE id = ?")
      .bind(userId)
      .first<{ limits: string | null }>();
    return limitsFrom(row?.limits);
  };
  const byEmail = (email: string) =>
    db
      .prepare("SELECT id, email, actor, handle, theme, name FROM users WHERE email = ?")
      .bind(email)
      .first<User>();
  return {
    async user(email) {
      const found = await byEmail(email);
      if (found) return found;
      const base = handleFromEmail(email);
      for (let n = 1; n <= 20; n++) {
        const handle = n === 1 ? base : `${base}-${n}`;
        const user = {
          id: `user_${crypto.randomUUID()}`,
          email,
          actor: humanActor(handle),
          handle,
        };
        // Ignored when the email (a concurrent sign-up) or the handle is taken or held.
        const r = await db
          .prepare(
            `INSERT OR IGNORE INTO users (id, email, actor, handle, created)
             SELECT ?1, ?2, ?3, ?4, ?5
             WHERE NOT EXISTS (SELECT 1 FROM handle_holds WHERE handle = ?4 AND released > ?6)`,
          )
          .bind(
            user.id,
            user.email,
            user.actor,
            user.handle,
            new Date().toISOString(),
            holdCutoff(),
          )
          .run();
        if (r.meta.changes) return user;
        const raced = await byEmail(email);
        if (raced) return raced;
      }
      throw new OkfError(500, "internal", "Could not find a free handle.");
    },
    async mayJoin(email, mode) {
      if (mode === "open" || (await byEmail(email))) return true;
      if (mode === "closed") return false;
      const invited = await db
        .prepare("SELECT 1 AS x FROM invites WHERE email = ?")
        .bind(email)
        .first();
      return invited !== null;
    },
    async joinWaitlist(email, ip) {
      const now = new Date();
      const added = await db
        .prepare("INSERT OR IGNORE INTO waitlist (email, created, ip) VALUES (?, ?, ?)")
        .bind(email, now.toISOString(), ip)
        .run();
      if (!added.meta.changes) return { added: false, notify: false };
      const dayAgo = new Date(now.getTime() - 86_400_000).toISOString();
      const claimed = await db
        .prepare(
          `UPDATE waitlist SET notified = ?1 WHERE email = ?2
             AND (SELECT COUNT(*) FROM waitlist WHERE notified > ?3) < ?4`,
        )
        .bind(now.toISOString(), email, dayAgo, WAITLIST_NOTICES_PER_DAY)
        .run();
      return { added: true, notify: claimed.meta.changes > 0 };
    },
    async waitlist() {
      const r = await db
        .prepare(
          `SELECT email, created FROM waitlist w WHERE decision IS NULL
             AND NOT EXISTS (SELECT 1 FROM invites i WHERE i.email = w.email)
             AND NOT EXISTS (SELECT 1 FROM users u WHERE u.email = w.email)
           ORDER BY created`,
        )
        .all<WaitlistEntry>();
      return r.results;
    },
    async decideWaitlist(email, decision) {
      const now = new Date().toISOString();
      const decide = db
        .prepare(
          "UPDATE waitlist SET decision = ?, decided = ? WHERE email = ? AND decision IS NULL",
        )
        .bind(decision, now, email);
      const [r] = await db.batch(
        decision === "invited"
          ? [
              decide,
              db
                .prepare(
                  "INSERT OR IGNORE INTO invites (email, created) SELECT email, ? FROM waitlist WHERE email = ? AND decision = 'invited'",
                )
                .bind(now, email),
            ]
          : [decide],
      );
      return (r?.meta.changes ?? 0) > 0;
    },
    async inviteEmail(raw) {
      const email = raw.trim().toLowerCase();
      const now = new Date().toISOString();
      const [added] = await db.batch([
        db.prepare("INSERT OR IGNORE INTO invites (email, created) VALUES (?, ?)").bind(email, now),
        db
          .prepare(
            "UPDATE waitlist SET decision = 'invited', decided = ? WHERE email = ? AND decision IS NULL",
          )
          .bind(now, email),
      ]);
      return { added: (added?.meta.changes ?? 0) > 0 };
    },
    async invited() {
      const r = await db
        .prepare(
          `SELECT i.email, i.created AS invited, u.id AS uid, u.handle, u.created AS made
             FROM invites i LEFT JOIN users u ON u.email = i.email
           ORDER BY i.created DESC`,
        )
        .all<{
          email: string;
          invited: string;
          uid: string | null;
          handle: string | null;
          made: string | null;
        }>();
      return r.results.map((x) => ({
        email: x.email,
        invited: x.invited,
        account: x.uid ? { handle: x.handle, created: x.made } : null,
      }));
    },
    async activityCounts(since) {
      const total = (sql: string) =>
        db
          .prepare(sql)
          .first<{ n: number }>()
          .then((r) => r?.n ?? 0);
      // One row each: who was seen since each time, from the month's rows (last_seen indexed).
      const seen = (table: "sessions" | "agents", who: "user" | "id") =>
        db
          .prepare(
            `SELECT COUNT(DISTINCT CASE WHEN last_seen >= ?1 THEN ${who} END) AS day,
                    COUNT(DISTINCT CASE WHEN last_seen >= ?2 THEN ${who} END) AS week,
                    COUNT(DISTINCT ${who}) AS month
               FROM ${table} WHERE last_seen >= ?3`,
          )
          .bind(since.day, since.week, since.month)
          .first<Windows>()
          .then((r) => ({ day: r?.day ?? 0, week: r?.week ?? 0, month: r?.month ?? 0 }));
      const [accounts, libraries, people, agents] = await Promise.all([
        total("SELECT COUNT(*) AS n FROM users WHERE suspended IS NULL"),
        total("SELECT COUNT(*) AS n FROM libraries"),
        seen("sessions", "user"),
        seen("agents", "id"),
      ]);
      return { accounts, libraries, people, agents };
    },
    async account(userId) {
      return db
        .prepare(
          "SELECT id, email, actor, handle, theme, name FROM users WHERE id = ? AND suspended IS NULL",
        )
        .bind(userId)
        .first<User>();
    },
    async people(userIds) {
      const unique = [...new Set(userIds)];
      const people = new Map<string, { handle: string; name: string | null }>();
      // D1 binds at most 100 parameters a statement: one query per 100 people.
      for (let i = 0; i < unique.length; i += 100) {
        const ids = unique.slice(i, i + 100);
        const r = await db
          .prepare(
            `SELECT id, handle, name FROM users
             WHERE id IN (${ids.map(() => "?").join(", ")}) AND suspended IS NULL`,
          )
          .bind(...ids)
          .all<{ id: string; handle: string; name: string | null }>();
        for (const row of r.results)
          people.set(row.id, { handle: row.handle, name: row.name ?? null });
      }
      return people;
    },
    async libraries(userId) {
      const r = await db
        .prepare(
          `SELECT l.id, l.slug, l.do_id, u.handle AS owner
           FROM libraries l JOIN users u ON u.id = l.owner
           WHERE l.owner = ? ORDER BY l.slug`,
        )
        .bind(userId)
        .all<LibraryRef>();
      return r.results;
    },
    async reachable(userId) {
      const r = await db
        .prepare(
          `SELECT l.id, l.slug, l.do_id, u.handle AS owner, 'owner' AS role, 0 AS shared,
                  l.title, l.description, l.created
           FROM libraries l JOIN users u ON u.id = l.owner WHERE l.owner = ?1
           UNION ALL
           SELECT l.id, l.slug, l.do_id, u.handle AS owner, m.role, 1 AS shared,
                  l.title, l.description, l.created
           FROM library_members m JOIN libraries l ON l.id = m.library
           JOIN users u ON u.id = l.owner
           WHERE m.user = ?1 AND u.suspended IS NULL
           ORDER BY shared, owner, slug`,
        )
        .bind(userId)
        .all<ReachableLibrary & { shared: number }>();
      return r.results.map(({ shared: _, ...l }) => l);
    },
    async recordAgent(userId, key, seen = {}) {
      const id = agentId(userId, key.platform);
      const now = new Date().toISOString();
      await db
        .prepare(
          `INSERT INTO agents (id, user, platform, name, first_seen, last_seen, client, user_agent)
           VALUES (?1, ?2, ?3, ?4, ?5, ?5, ?6, ?7)
           ON CONFLICT (id) DO UPDATE SET last_seen = ?5, name = ?4,
             client = COALESCE(?6, client), user_agent = COALESCE(?7, user_agent)`,
        )
        .bind(
          id,
          userId,
          key.platform,
          key.name.slice(0, 80),
          now,
          seen.client?.slice(0, 120) ?? null,
          seen.userAgent?.slice(0, 200) ?? null,
        )
        .run();
      return id;
    },
    async agents(ids) {
      if (ids.length === 0) return [];
      const unique = [...new Set(ids)].slice(0, 100);
      const r = await db
        .prepare(
          `SELECT a.id, a.name, a.platform, u.handle AS person, a.first_seen, a.last_seen, a.client
           FROM agents a JOIN users u ON u.id = a.user
           WHERE a.id IN (${unique.map(() => "?").join(", ")})`,
        )
        .bind(...unique)
        .all<AgentRow>();
      return r.results;
    },
    async findAccount(by) {
      const [col, value] =
        "handle" in by
          ? ["handle", by.handle.trim().replace(/^@/, "").toLowerCase()]
          : ["email", by.email.trim().toLowerCase()];
      return db
        .prepare(
          `SELECT id, email, actor, handle, theme, name FROM users WHERE ${col} = ? AND suspended IS NULL`,
        )
        .bind(value)
        .first<User>();
    },
    async invite(libraryId, userId, role, invitedBy) {
      if (role !== "read" && role !== "write") {
        throw new OkfError(400, "bad_role", "A member's role is read or write.");
      }
      const lib = await db
        .prepare(
          `SELECT owner, (SELECT role FROM library_members WHERE library = ?1 AND user = ?2) AS member
           FROM libraries WHERE id = ?1`,
        )
        .bind(libraryId, userId)
        .first<{ owner: string; member: string | null }>();
      if (!lib) throw new OkfError(404, "no_library", "No such library.");
      if (lib.owner === userId) throw new OkfError(409, "is_owner", "That's the library's owner.");
      if (lib.member) {
        throw new OkfError(
          409,
          "already_member",
          `They are already a member, with ${lib.member} access.`,
        );
      }
      const now = new Date();
      const expires = new Date(now.getTime() + INVITATION_DAYS * 86_400_000).toISOString();
      const renewed = await db
        .prepare(
          `UPDATE library_invitations SET role = ?, expires = ?, invited_by = ?
           WHERE library = ? AND user = ? AND status = 'pending' RETURNING id`,
        )
        .bind(role, expires, invitedBy, libraryId, userId)
        .first<{ id: string }>();
      if (renewed) return { id: renewed.id, renewed: true };
      const id = `inv_${crypto.randomUUID()}`;
      const dayAgo = new Date(now.getTime() - 86_400_000).toISOString();
      // The day's count is checked in the same statement, so a burst cannot slip past it.
      const r = await db
        .prepare(
          `INSERT INTO library_invitations (id, library, user, role, invited_by, created, expires)
           SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7
           WHERE (SELECT COUNT(*) FROM library_invitations WHERE library = ?2 AND created > ?8) < ?9`,
        )
        .bind(
          id,
          libraryId,
          userId,
          role,
          invitedBy,
          now.toISOString(),
          expires,
          dayAgo,
          INVITATIONS_PER_DAY,
        )
        .run();
      if (!r.meta.changes) {
        throw new OkfError(
          429,
          "too_many_invitations",
          `A library can send ${INVITATIONS_PER_DAY} invitations a day.`,
        );
      }
      return { id, renewed: false };
    },
    async libraryInvitations(libraryId) {
      const r = await db
        .prepare(
          `SELECT i.id, o.handle AS owner, l.slug, i.role, u.handle, i.created, i.expires
           FROM library_invitations i JOIN libraries l ON l.id = i.library
           JOIN users o ON o.id = l.owner JOIN users u ON u.id = i.user
           WHERE i.library = ? AND i.status = 'pending' AND i.expires > ?
           ORDER BY i.created DESC`,
        )
        .bind(libraryId, new Date().toISOString())
        .all<Invitation>();
      return r.results;
    },
    async invitations(userId) {
      const r = await db
        .prepare(
          `SELECT i.id, o.handle AS owner, l.slug, i.role, b.handle, i.created, i.expires
           FROM library_invitations i JOIN libraries l ON l.id = i.library
           JOIN users o ON o.id = l.owner LEFT JOIN users b ON b.id = i.invited_by
           WHERE i.user = ? AND i.status = 'pending' AND i.expires > ? AND o.suspended IS NULL
           ORDER BY i.created DESC`,
        )
        .bind(userId, new Date().toISOString())
        .all<Invitation & { handle: string | null }>();
      return r.results.map((i) => ({ ...i, handle: i.handle ?? i.owner }));
    },
    async decideInvitation(id, userId, accept) {
      const now = new Date().toISOString();
      const inv = await db
        .prepare(
          `SELECT i.library, i.role, i.invited_by, o.handle AS owner, l.slug
           FROM library_invitations i JOIN libraries l ON l.id = i.library
           JOIN users o ON o.id = l.owner
           WHERE i.id = ? AND i.user = ? AND i.status = 'pending' AND i.expires > ?
             AND o.suspended IS NULL`,
        )
        .bind(id, userId, now)
        .first<{
          library: string;
          role: MemberRole;
          invited_by: string;
          owner: string;
          slug: string;
        }>();
      if (!inv) return null;
      const decide = db
        .prepare(
          "UPDATE library_invitations SET status = ?, decided = ? WHERE id = ? AND status = 'pending'",
        )
        .bind(accept ? "accepted" : "declined", now, id);
      if (!accept) {
        await decide.run();
        return { owner: inv.owner, slug: inv.slug, role: inv.role };
      }
      await db.batch([
        decide,
        db
          .prepare(
            `INSERT INTO library_members (library, user, role, granted_by, created)
             SELECT ?1, ?2, ?3, ?4, ?5 WHERE EXISTS (SELECT 1 FROM libraries WHERE id = ?1 AND owner != ?2)
             ON CONFLICT (library, user) DO UPDATE SET role = excluded.role`,
          )
          .bind(inv.library, userId, inv.role, inv.invited_by, now),
      ]);
      return { owner: inv.owner, slug: inv.slug, role: inv.role };
    },
    async revokeInvitation(id, libraryId) {
      const r = await db
        .prepare(
          `UPDATE library_invitations SET status = 'revoked', decided = ?
           WHERE id = ? AND library = ? AND status = 'pending'`,
        )
        .bind(new Date().toISOString(), id, libraryId)
        .run();
      return r.meta.changes > 0;
    },
    async memberRole(libraryId, userId) {
      const row = await db
        .prepare("SELECT role FROM library_members WHERE library = ? AND user = ?")
        .bind(libraryId, userId)
        .first<{ role: MemberRole }>();
      return row?.role ?? null;
    },
    async members(libraryId) {
      const r = await db
        .prepare(
          `SELECT m.user, u.handle, m.role, m.created FROM library_members m
           JOIN users u ON u.id = m.user WHERE m.library = ? ORDER BY u.handle`,
        )
        .bind(libraryId)
        .all<Member>();
      return r.results;
    },
    async share(libraryId, userId, role, grantedBy) {
      if (role !== "read" && role !== "write") {
        throw new OkfError(400, "bad_role", "A member's role is read or write.");
      }
      const r = await db
        .prepare(
          `INSERT INTO library_members (library, user, role, granted_by, created)
           SELECT ?1, ?2, ?3, ?4, ?5
           WHERE EXISTS (SELECT 1 FROM libraries WHERE id = ?1 AND owner != ?2)
           ON CONFLICT (library, user) DO UPDATE SET role = excluded.role`,
        )
        .bind(libraryId, userId, role, grantedBy, new Date().toISOString())
        .run();
      if (!r.meta.changes) {
        throw new OkfError(409, "is_owner", "The library's owner cannot also be a member.");
      }
    },
    async unshare(libraryId, userId) {
      const r = await db
        .prepare("DELETE FROM library_members WHERE library = ? AND user = ?")
        .bind(libraryId, userId)
        .run();
      return r.meta.changes > 0;
    },
    async libraryByDoId(doId) {
      return db
        .prepare(
          `SELECT l.id, l.slug, l.do_id, u.handle AS owner, u.id AS ownerId
           FROM libraries l JOIN users u ON u.id = l.owner
           WHERE l.do_id = ? AND u.suspended IS NULL`,
        )
        .bind(doId)
        .first<LibraryRef & { ownerId: string }>();
    },
    async library(owner, slug) {
      return db
        .prepare(
          `SELECT l.id, l.slug, l.do_id, u.handle AS owner, u.id AS ownerId
           FROM libraries l JOIN users u ON u.id = l.owner
           WHERE u.handle = ? AND l.slug = ? AND u.suspended IS NULL`,
        )
        .bind(owner, slug)
        .first<LibraryRef & { ownerId: string }>();
    },
    async createLibrary(slugInput, owner, opts = {}) {
      const slug = checkSlug(slugInput);
      const title = checkLine(opts.title, "title", 120);
      const description = checkLine(opts.description, "description", 300);
      const { libraries: max } = await limitsOf(owner.id);
      const id = `lib_${crypto.randomUUID()}`;
      const now = new Date().toISOString();
      // The count is checked in the same statement, so two creates cannot both slip under it.
      const insert = db
        .prepare(
          `INSERT OR IGNORE INTO libraries (id, slug, owner, visibility, created, do_id, title, description)
           SELECT ?1, ?2, ?3, 'private', ?4, ?1, ?6, ?7
           WHERE (SELECT COUNT(*) FROM libraries WHERE owner = ?3) < ?5`,
        )
        .bind(id, slug, owner.id, now, max, title, description);
      const [r] = await db.batch([
        insert,
        // A new library has no attachments, so its blob references are complete from the start:
        // every later one is recorded by the write path (TEMPRA-91).
        db
          .prepare(
            `INSERT OR IGNORE INTO blob_ref_libraries (library, counted)
             SELECT ?1, ?2 WHERE EXISTS (SELECT 1 FROM libraries WHERE id = ?1)`,
          )
          .bind(id, now),
        // Only if the library above went in, and only for the person who owns it.
        ...(opts.grant
          ? [
              db
                .prepare(
                  `INSERT INTO grant_libraries (grant_id, user, library, created)
                   SELECT ?1, ?2, ?3, ?4 WHERE EXISTS (SELECT 1 FROM libraries WHERE id = ?3 AND owner = ?2)`,
                )
                .bind(opts.grant, owner.id, id, now),
            ]
          : []),
      ]);
      if (!r?.meta.changes) {
        const exists = await db
          .prepare("SELECT 1 AS x FROM libraries WHERE owner = ? AND slug = ?")
          .bind(owner.id, slug)
          .first();
        if (exists) {
          throw new OkfError(409, "slug_taken", `You already have a library named ${slug}.`);
        }
        throw overLimit("libraries", max, "library_limit");
      }
      return { id, slug, do_id: id, owner: owner.handle, title, description };
    },
    async setTheme(userId, theme) {
      await db.prepare("UPDATE users SET theme = ?1 WHERE id = ?2").bind(theme, userId).run();
    },
    async setName(userId, name) {
      await db.prepare("UPDATE users SET name = ?1 WHERE id = ?2").bind(name, userId).run();
    },
    async describeLibrary(libraryId, about) {
      const current = await db
        .prepare("SELECT title, description FROM libraries WHERE id = ?")
        .bind(libraryId)
        .first<{ title: string | null; description: string | null }>();
      if (!current) throw new OkfError(404, "not_found", "No such library.");
      const title =
        about.title === undefined ? current.title : checkLine(about.title, "title", 120);
      const description =
        about.description === undefined
          ? current.description
          : checkLine(about.description, "description", 300);
      await db
        .prepare("UPDATE libraries SET title = ?1, description = ?2 WHERE id = ?3")
        .bind(title, description, libraryId)
        .run();
      return { title, description };
    },
    async about(libraryId) {
      return db
        .prepare("SELECT title, description FROM libraries WHERE id = ?")
        .bind(libraryId)
        .first<{ title: string | null; description: string | null }>();
    },
    async grantLibraries(grantId, userId) {
      const r = await db
        .prepare("SELECT library FROM grant_libraries WHERE grant_id = ? AND user = ?")
        .bind(grantId, userId)
        .all<{ library: string }>();
      return r.results.map((row) => row.library);
    },
    async tokens(userId) {
      // A union, not `l.owner = ?1 OR t.created_by = ?1`: an OR across two tables scans tokens.
      const r = await db
        .prepare(
          `SELECT t.id,
                  CASE WHEN l.owner = ?1 THEN l.slug ELSE o.handle || '/' || l.slug END AS library,
                  t.actor, t.scope, t.prefix, t.expires, t.mcp_tiers,
                  u.email AS created_by, t.revoked
           FROM tokens t JOIN libraries l ON l.id = t.library
           JOIN users o ON o.id = l.owner
           LEFT JOIN users u ON u.id = t.created_by
           WHERE t.rowid IN (
             SELECT t2.rowid FROM tokens t2 JOIN libraries l2 ON l2.id = t2.library WHERE l2.owner = ?1
             UNION SELECT rowid FROM tokens WHERE created_by = ?1)
           ORDER BY t.rowid DESC`,
        )
        .bind(userId)
        .all<TokenRow>();
      return r.results;
    },
    async createToken(t) {
      const id = `tok_${crypto.randomUUID()}`;
      const secret = newTokenSecret();
      const owner = await db
        .prepare("SELECT owner FROM libraries WHERE id = ?")
        .bind(t.libraryId)
        .first<{ owner: string }>();
      if (!owner) throw new OkfError(404, "no_library", "No such library.");
      // A token counts against the account that minted it (a member's, on a shared library).
      const account = t.createdBy ?? owner.owner;
      const { tokens: max } = await limitsOf(account);
      const r = await db
        .prepare(
          `INSERT INTO tokens (id, hash, library, actor, scope, prefix, expires, mcp_tiers, created_by)
           SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9
           WHERE (SELECT COUNT(*) FROM tokens WHERE revoked IS NULL
                  AND (expires IS NULL OR expires > ?10)
                  AND ${MINTED_BY_11}) < ?12`,
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
          new Date().toISOString(),
          account,
          max,
        )
        .run();
      if (!r.meta.changes) throw overLimit("active tokens", max);
      return { id, secret };
    },
    limits: limitsOf,
    async usage(userId) {
      const row = await db
        .prepare(
          `SELECT (SELECT COUNT(*) FROM libraries WHERE owner = ?1) AS libraries,
                  (SELECT COUNT(*) FROM tokens WHERE revoked IS NULL
                     AND (expires IS NULL OR expires > ?2)
                     AND ${MINTED_BY_1}) AS tokens`,
        )
        .bind(userId, new Date().toISOString())
        .first<{ libraries: number; tokens: number }>();
      return { libraries: row?.libraries ?? 0, tokens: row?.tokens ?? 0 };
    },
    async setEmail(userId, email) {
      const r = await db
        .prepare(
          `UPDATE users SET email = ?1 WHERE id = ?2
           AND NOT EXISTS (SELECT 1 FROM users WHERE email = ?1 AND id != ?2)`,
        )
        .bind(email, userId)
        .run();
      if (!r.meta.changes) {
        throw new OkfError(409, "email_taken", "Another account uses that email address.");
      }
    },
    async revokeToken(id, userId) {
      const r = await db
        .prepare(
          `UPDATE tokens SET revoked = ?1 WHERE id = ?2 AND revoked IS NULL
           AND (library IN (SELECT id FROM libraries WHERE owner = ?3) OR created_by = ?3)`,
        )
        .bind(new Date().toISOString(), id, userId)
        .run();
      if (!r.meta.changes) throw new OkfError(404, "not_found", "No such active token.");
    },
    async setHandle(userId, handleInput, opts = {}) {
      const handle = checkHandle(handleInput, opts);
      const byId = () =>
        db
          .prepare("SELECT id, email, actor, handle, theme, name FROM users WHERE id = ?")
          .bind(userId)
          .first<User>();
      const before = await byId();
      if (!before) throw new OkfError(404, "not_found", "No such account.");
      if (before.handle === handle) return before;
      const now = new Date().toISOString();
      const [r] = await db.batch([
        db
          .prepare(
            `UPDATE users SET handle = ?1, actor = ?2 WHERE id = ?3
             AND NOT EXISTS (SELECT 1 FROM users WHERE handle = ?1 AND id != ?3)
             AND NOT EXISTS (SELECT 1 FROM handle_holds
                             WHERE handle = ?1 AND user != ?3 AND released > ?4)`,
          )
          .bind(handle, humanActor(handle), userId, holdCutoff()),
        // Only when the rename went through: the old handle is held, a reclaimed one released.
        db
          .prepare(
            `INSERT OR REPLACE INTO handle_holds (handle, user, released)
             SELECT ?1, ?2, ?3 WHERE EXISTS (SELECT 1 FROM users WHERE id = ?2 AND handle = ?4)`,
          )
          .bind(before.handle, userId, now, handle),
        db
          .prepare(
            "DELETE FROM handle_holds WHERE handle = ?1 AND EXISTS (SELECT 1 FROM users WHERE id = ?2 AND handle = ?1)",
          )
          .bind(handle, userId),
      ]);
      if (!r?.meta.changes)
        throw new OkfError(409, "handle_taken", `The handle ${handle} is taken.`);
      return (await byId()) ?? before;
    },
    async heldHandle(handle) {
      const row = await db
        .prepare(
          `SELECT u.handle FROM handle_holds h JOIN users u ON u.id = h.user
           WHERE h.handle = ? AND h.released > ? AND u.suspended IS NULL`,
        )
        .bind(handle, holdCutoff())
        .first<{ handle: string }>();
      return row?.handle ?? null;
    },
    async deleteLibrary(libraryId) {
      await db.batch([
        db.prepare("DELETE FROM tokens WHERE library = ?").bind(libraryId),
        db.prepare("DELETE FROM library_members WHERE library = ?").bind(libraryId),
        db.prepare("DELETE FROM library_invitations WHERE library = ?").bind(libraryId),
        db.prepare("DELETE FROM notifications WHERE library = ?").bind(libraryId),
        db.prepare("DELETE FROM library_seen WHERE library = ?").bind(libraryId),
        db.prepare("DELETE FROM notification_prefs WHERE library = ?").bind(libraryId),
        db.prepare("DELETE FROM grant_libraries WHERE library = ?").bind(libraryId),
        // Its health row (TEMPRA-92), keyed by the object's name.
        db
          .prepare(
            "DELETE FROM library_health WHERE library IN (SELECT do_id FROM libraries WHERE id = ?)",
          )
          .bind(libraryId),
        db.prepare("DELETE FROM libraries WHERE id = ?").bind(libraryId),
      ]);
    },
    async deleteUser(user) {
      await db.batch([
        db.prepare("DELETE FROM sessions WHERE user = ?").bind(user.id),
        db.prepare("DELETE FROM sign_in_links WHERE email = ?").bind(user.email),
        // Tokens left now are on others' libraries (theirs went with their libraries): a token
        // with no creator would act for the owner, so these are revoked first.
        db
          .prepare("UPDATE tokens SET revoked = ? WHERE created_by = ? AND revoked IS NULL")
          .bind(new Date().toISOString(), user.id),
        db.prepare("UPDATE tokens SET created_by = NULL WHERE created_by = ?").bind(user.id),
        db.prepare("DELETE FROM library_members WHERE user = ?").bind(user.id),
        db.prepare("DELETE FROM library_invitations WHERE user = ?").bind(user.id),
        db.prepare("DELETE FROM agents WHERE user = ?").bind(user.id),
        db.prepare("DELETE FROM notifications WHERE user = ?").bind(user.id),
        db.prepare("DELETE FROM agent_usage WHERE user = ?").bind(user.id),
        db.prepare("DELETE FROM library_seen WHERE user = ?").bind(user.id),
        db.prepare("DELETE FROM notification_prefs WHERE user = ?").bind(user.id),
        db.prepare("DELETE FROM grant_libraries WHERE user = ?").bind(user.id),
        db.prepare("DELETE FROM users WHERE id = ?").bind(user.id),
        db
          .prepare("INSERT OR REPLACE INTO handle_holds (handle, user, released) VALUES (?, ?, ?)")
          .bind(user.handle, user.id, new Date().toISOString()),
        db
          .prepare("INSERT INTO deleted_accounts (email_hash, deleted) VALUES (?, ?)")
          .bind(sha256Hex(user.email), new Date().toISOString()),
      ]);
    },
  };
}
