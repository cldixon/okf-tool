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

export interface Accounts {
  /** The users row for an Access identity, created on first sign-in. */
  user(email: string): Promise<User>;
  libraries(): Promise<LibraryRef[]>;
  createLibrary(slug: string, ownerId: string): Promise<LibraryRef>;
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
  };
}
