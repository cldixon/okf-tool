/**
 * `bun run admin`: operator actions on the account database (v2 spec: Tenancy, Admin). Local D1
 * by default (the state `cf dev` uses); --remote for the deployed one.
 *
 *   bun run admin transfer --library <owner>/<slug> --to <email> [--remote]
 *       Gives a library to another account (which must have signed in once). Its tokens,
 *       grants, ledger and exports stay as they are.
 *   bun run admin suspend --email <email> [--undo] [--remote]
 *       Refuses the account's sessions and tokens without deleting anything.
 *   bun run admin users [--remote]
 *       Lists accounts with their handles and libraries.
 */
import { parseArgs } from "node:util";
import { type CfOptions, d1Sql } from "./cf";

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    library: { type: "string" },
    to: { type: "string" },
    email: { type: "string" },
    undo: { type: "boolean" },
    remote: { type: "boolean" },
  },
});
const where: CfOptions = values.remote ? {} : { local: true };
const q = (s: string) => `'${s.replace(/'/g, "''")}'`;

async function one(sql: string): Promise<unknown[] | undefined> {
  return (await d1Sql(sql, where))[0];
}

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

switch (positionals[0]) {
  case "transfer": {
    const [owner, slug] = (values.library ?? "").split("/");
    if (!owner || !slug || !values.to)
      fail("Usage: transfer --library <owner>/<slug> --to <email>");
    const lib = await one(
      `SELECT l.id FROM libraries l JOIN users u ON u.id = l.owner WHERE u.handle = ${q(owner)} AND l.slug = ${q(slug)}`,
    );
    if (!lib) fail(`No library ${owner}/${slug}.`);
    const to = await one(
      `SELECT id, handle FROM users WHERE email = ${q(values.to.toLowerCase())}`,
    );
    if (!to) fail(`No account for ${values.to}; they sign in once first.`);
    const clash = await one(
      `SELECT 1 FROM libraries WHERE owner = ${q(String(to[0]))} AND slug = ${q(slug)}`,
    );
    if (clash) fail(`${to[1]} already has a library named ${slug}.`);
    await d1Sql(
      `UPDATE libraries SET owner = ${q(String(to[0]))} WHERE id = ${q(String(lib[0]))}`,
      where,
    );
    console.log(`${owner}/${slug} is now ${to[1]}/${slug}.`);
    break;
  }
  case "suspend": {
    if (!values.email) fail("Usage: suspend --email <email> [--undo]");
    const value = values.undo ? "NULL" : q(new Date().toISOString());
    const user = await one(`SELECT id FROM users WHERE email = ${q(values.email.toLowerCase())}`);
    if (!user) fail(`No account for ${values.email}.`);
    await d1Sql(`UPDATE users SET suspended = ${value} WHERE id = ${q(String(user[0]))}`, where);
    if (!values.undo) await d1Sql(`DELETE FROM sessions WHERE user = ${q(String(user[0]))}`, where);
    console.log(`${values.email} ${values.undo ? "restored" : "suspended"}.`);
    break;
  }
  case "users": {
    const rows = await d1Sql(
      `SELECT u.handle, u.email, u.suspended, group_concat(l.slug, ', ')
       FROM users u LEFT JOIN libraries l ON l.owner = u.id GROUP BY u.id ORDER BY u.handle`,
      where,
    );
    for (const [handle, email, suspended, libs] of rows) {
      console.log(`${handle}  ${email}${suspended ? "  (suspended)" : ""}  ${libs ?? ""}`);
    }
    break;
  }
  default:
    fail("Commands: transfer, suspend, users (see scripts/admin.ts).");
}
