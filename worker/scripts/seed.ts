/**
 * `bun run seed`: creates a local user (dev@localhost, handle dev), library and write token in the
 * local D1 and prints the token. Sign in to the UI as dev@localhost (DEV_SIGNIN=1 shows the link). Stands in for token management until the UI arrives (spec: Deployment, Local development).
 * With --remote it writes to the deployed D1 instead.
 *
 *   bun run seed [--slug dev] [--actor claude-code/local] [--scope write] [--prefix notes]
 *                [--persist-to .wrangler/state] [--remote] [--json]
 *
 * Local runs use the state `cf dev` uses (worker/.wrangler/state) unless --persist-to says otherwise.
 */
import { parseArgs } from "node:util";
import { hashToken, newTokenSecret } from "../src/auth";
import { applyMigrations, type CfOptions, d1Sql } from "./cf";

export interface SeedOptions {
  slug?: string;
  actor?: string;
  human?: string;
  scope?: "read" | "write";
  prefix?: string | null;
  persistTo?: string;
  /** Write to the deployed D1 instead of the local one. */
  remote?: boolean;
}

export interface Seeded {
  token: string;
  /** The owner's handle: the library's path is {owner}/{slug}. */
  owner: string;
  slug: string;
  library_id: string;
  actor: string;
  scope: string;
}

function where(opts: SeedOptions): CfOptions {
  return opts.remote ? {} : { local: true, persistTo: opts.persistTo };
}

const q = (s: string | null | undefined) => (s == null ? "NULL" : `'${s.replace(/'/g, "''")}'`);

export async function seed(opts: SeedOptions = {}): Promise<Seeded> {
  const slug = opts.slug ?? "dev";
  const actor = opts.actor ?? "claude-code/local";
  const human = opts.human ?? "human:dev";
  const handle = human.slice("human:".length);
  const scope = opts.scope ?? "write";
  const now = new Date().toISOString();
  await applyMigrations(where(opts));

  const secret = newTokenSecret();
  const libraryId = `lib_${crypto.randomUUID()}`;
  const sql = [
    `INSERT OR IGNORE INTO users (id, email, actor, handle, created) VALUES ('user_dev', 'dev@localhost', ${q(human)}, ${q(handle)}, ${q(now)});`,
    `INSERT OR IGNORE INTO libraries (id, slug, owner, visibility, created, do_id) VALUES (${q(libraryId)}, ${q(slug)}, 'user_dev', 'private', ${q(now)}, ${q(libraryId)});`,
    `INSERT OR IGNORE INTO tokens (id, hash, library, actor, scope, prefix, created_by) VALUES (${q(`tok_${crypto.randomUUID()}`)}, ${q(hashToken(secret))}, (SELECT id FROM libraries WHERE owner = 'user_dev' AND slug = ${q(slug)}), ${q(actor)}, ${q(scope)}, ${q(opts.prefix ?? null)}, 'user_dev');`,
  ].join(" ");
  await d1Sql(sql, where(opts));
  const rows = await d1Sql(
    `SELECT l.id, u.handle FROM libraries l JOIN users u ON u.id = l.owner
     WHERE l.owner = 'user_dev' AND l.slug = ${q(slug)}`,
    where(opts),
  );
  const id = (rows[0]?.[0] as string | undefined) ?? libraryId;
  const owner = (rows[0]?.[1] as string | undefined) ?? handle;
  return { token: secret, owner, slug, library_id: id, actor, scope };
}

if (import.meta.main) {
  const { values } = parseArgs({
    options: {
      slug: { type: "string" },
      actor: { type: "string" },
      scope: { type: "string" },
      prefix: { type: "string" },
      "persist-to": { type: "string" },
      remote: { type: "boolean" },
      json: { type: "boolean" },
    },
  });
  const s = await seed({
    slug: values.slug,
    actor: values.actor,
    scope: values.scope === "read" ? "read" : "write",
    prefix: values.prefix ?? null,
    persistTo: values["persist-to"],
    remote: values.remote,
  });
  if (values.json) console.log(JSON.stringify(s));
  else {
    console.log(`Library: ${s.owner}/${s.slug} (${s.library_id})`);
    console.log(`Actor:   ${s.actor} (${s.scope})`);
    console.log(`Token:   ${s.token}`);
    if (!values.remote) {
      console.log("\nTry it with `bun run dev` running:");
      console.log(
        `  curl -H 'Authorization: Bearer ${s.token}' http://localhost:8787/api/v1/libraries/${s.owner}/${s.slug}/tree`,
      );
    }
  }
}
