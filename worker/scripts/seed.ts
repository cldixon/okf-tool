/**
 * `bun run seed`: creates a local user, library and write token in the local D1 and prints the
 * token. Stands in for token management until the UI arrives (spec: Deployment, Local development).
 * With --remote it writes to the deployed D1 instead.
 *
 *   bun run seed [--slug dev] [--actor claude-code/local] [--scope write] [--prefix notes]
 *                [--persist-to .wrangler/state] [--remote] [--json]
 */
import { parseArgs } from "node:util";
import { hashToken, newTokenSecret } from "../src/auth";

const WORKER_DIR = new URL("..", import.meta.url).pathname;
// The binding name, so it works whatever the deployment named its database.
const DB = "DB";

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
  slug: string;
  library_id: string;
  actor: string;
  scope: string;
}

function wrangler(args: string[], opts: SeedOptions): string {
  const full = ["bunx", "wrangler", ...args, opts.remote ? "--remote" : "--local"];
  if (opts.persistTo && !opts.remote) full.push("--persist-to", opts.persistTo);
  const p = Bun.spawnSync(full, {
    cwd: WORKER_DIR,
    env: { ...process.env, WRANGLER_SEND_METRICS: "false", CI: "1" },
  });
  if (p.exitCode !== 0) {
    throw new Error(
      `wrangler ${args.join(" ")} failed:\n${p.stderr.toString()}${p.stdout.toString()}`,
    );
  }
  return p.stdout.toString();
}

const q = (s: string | null | undefined) => (s == null ? "NULL" : `'${s.replace(/'/g, "''")}'`);

export function seed(opts: SeedOptions = {}): Seeded {
  const slug = opts.slug ?? "dev";
  const actor = opts.actor ?? "claude-code/local";
  const human = opts.human ?? "human:dev";
  const scope = opts.scope ?? "write";
  const now = new Date().toISOString();
  wrangler(["d1", "migrations", "apply", DB], opts);

  const secret = newTokenSecret();
  const libraryId = `lib_${crypto.randomUUID()}`;
  const sql = [
    `INSERT OR IGNORE INTO users (id, email, actor, created) VALUES ('user_dev', 'dev@localhost', ${q(human)}, ${q(now)});`,
    `INSERT OR IGNORE INTO libraries (id, slug, owner, visibility, created, do_id) VALUES (${q(libraryId)}, ${q(slug)}, 'user_dev', 'private', ${q(now)}, ${q(libraryId)});`,
    `INSERT INTO tokens (id, hash, library, actor, scope, prefix, created_by) VALUES (${q(`tok_${crypto.randomUUID()}`)}, ${q(hashToken(secret))}, (SELECT id FROM libraries WHERE slug = ${q(slug)}), ${q(actor)}, ${q(scope)}, ${q(opts.prefix ?? null)}, 'user_dev');`,
  ].join(" ");
  wrangler(["d1", "execute", DB, "--command", sql], opts);
  const out = wrangler(
    [
      "d1",
      "execute",
      DB,
      "--json",
      "--command",
      `SELECT id FROM libraries WHERE slug = ${q(slug)}`,
    ],
    opts,
  );
  const id = (JSON.parse(out) as { results: { id: string }[] }[])[0]?.results[0]?.id ?? libraryId;
  return { token: secret, slug, library_id: id, actor, scope };
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
  const s = seed({
    slug: values.slug,
    actor: values.actor,
    scope: values.scope === "read" ? "read" : "write",
    prefix: values.prefix ?? null,
    persistTo: values["persist-to"],
    remote: values.remote,
  });
  if (values.json) console.log(JSON.stringify(s));
  else {
    console.log(`Library: ${s.slug} (${s.library_id})`);
    console.log(`Actor:   ${s.actor} (${s.scope})`);
    console.log(`Token:   ${s.token}`);
    if (!values.remote) {
      console.log("\nTry it with `bun run dev` running:");
      console.log(
        `  curl -H 'Authorization: Bearer ${s.token}' http://localhost:8787/api/v1/libraries/${s.slug}/tree`,
      );
    }
  }
}
