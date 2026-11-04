/**
 * `bun run admin`: operator actions on the account database (v2 spec: Tenancy, Admin). Local D1
 * by default (the state `cf dev` uses); --remote for the deployed one.
 *
 *   bun run admin transfer --library <owner>/<slug> --to <email> [--remote]
 *       Gives a library to another account (which must have signed in once). Its ledger and
 *       exports stay as they are; tokens act for whoever minted them, so the old owner's stop
 *       working unless they are made a member (share). The new owner stops being a member.
 *   bun run admin share --library <owner>/<slug> --to <email> --role read|write [--remote]
 *   bun run admin unshare --library <owner>/<slug> --to <email> [--remote]
 *       Makes an account a member of a library, changes its role, or ends the membership
 *       (tempra-dev: v2/sharing). Temporary, until invitations (TEMPRA-61).
 *   bun run admin suspend --email <email> [--undo] [--remote]
 *       Refuses the account's sessions and tokens without deleting anything.
 *   bun run admin users [--remote]
 *       Lists accounts with their handles and libraries.
 *   bun run admin limits --email <email> [--set libraries=10,tokens=100,agent_daily_usd=5] [--reset] [--remote]
 *       Shows an account's limits, or overrides them (v2 spec: Limits; defaults in limits.ts), and
 *       this month against the monthly quotas (TEMPRA-232; writes_monthly, requests_monthly and
 *       storage_mb set the same way): storage from D1, and with --remote the month's metered
 *       writes and requests from Analytics Engine (CLOUDFLARE_API_TOKEN and _ACCOUNT_ID).
 *   bun run admin invite --email <email> [--remote]      Lets an email sign up when SIGNUP=invite.
 *   bun run admin uninvite --email <email> [--remote]    Withdraws an invite (accounts stay).
 *   bun run admin waitlist [--remote]                    Invites and the waitlist, newest first.
 *   bun run admin rename --email <email> --handle <handle> [--remote]
 *       Gives an account a new handle, reserved ones included (v2 spec: Handles): an official
 *       account, or reclaiming one that impersonates. The old handle is held for the account.
 */
import { parseArgs } from "node:util";
import { deploymentFor } from "../cloudflare.config";
import { checkHandle, HANDLE_HOLD_DAYS } from "../src/handles";
import { DEFAULT_LIMITS, type Limits, limitsFrom } from "../src/limits";
import { monthOf, monthResets } from "../src/quota";
import { type CfOptions, d1Sql, MODE } from "./cf";

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    library: { type: "string" },
    to: { type: "string" },
    email: { type: "string" },
    handle: { type: "string" },
    undo: { type: "boolean" },
    set: { type: "string" },
    reset: { type: "boolean" },
    role: { type: "string" },
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
    // The new owner is no longer a member of their own library.
    await d1Sql(
      `UPDATE libraries SET owner = ${q(String(to[0]))} WHERE id = ${q(String(lib[0]))};
       DELETE FROM library_members WHERE library = ${q(String(lib[0]))} AND user = ${q(String(to[0]))};`,
      where,
    );
    console.log(`${owner}/${slug} is now ${to[1]}/${slug}.`);
    break;
  }
  case "share":
  case "unshare": {
    const share = positionals[0] === "share";
    const [owner, slug] = (values.library ?? "").split("/");
    if (!owner || !slug || !values.to || (share && !["read", "write"].includes(values.role ?? "")))
      fail(
        share
          ? "Usage: share --library <owner>/<slug> --to <email> --role read|write"
          : "Usage: unshare --library <owner>/<slug> --to <email>",
      );
    const lib = await one(
      `SELECT l.id, l.owner FROM libraries l JOIN users u ON u.id = l.owner WHERE u.handle = ${q(owner)} AND l.slug = ${q(slug)}`,
    );
    if (!lib) fail(`No library ${owner}/${slug}.`);
    const to = await one(
      `SELECT id, handle FROM users WHERE email = ${q(values.to.toLowerCase())}`,
    );
    if (!to) fail(`No account for ${values.to}; they sign in once first.`);
    if (to[0] === lib[1]) fail(`${to[1]} owns ${owner}/${slug}.`);
    if (share) {
      await d1Sql(
        `INSERT INTO library_members (library, user, role, granted_by, created)
         VALUES (${q(String(lib[0]))}, ${q(String(to[0]))}, ${q(String(values.role))}, ${q(String(lib[1]))}, ${q(new Date().toISOString())})
         ON CONFLICT (library, user) DO UPDATE SET role = excluded.role`,
        where,
      );
      console.log(`${to[1]} has ${values.role} access to ${owner}/${slug}.`);
    } else {
      await d1Sql(
        `DELETE FROM library_members WHERE library = ${q(String(lib[0]))} AND user = ${q(String(to[0]))}`,
        where,
      );
      console.log(`${to[1]} no longer has ${owner}/${slug}.`);
    }
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
  case "limits": {
    if (!values.email)
      fail("Usage: limits --email <email> [--set libraries=10,tokens=100] [--reset]");
    const user = await one(
      `SELECT id, limits, handle,
              (SELECT COALESCE(SUM(storage_bytes), 0) FROM libraries WHERE owner = users.id),
              (SELECT COUNT(*) FROM libraries WHERE owner = users.id)
         FROM users WHERE email = ${q(values.email.toLowerCase())}`,
    );
    if (!user) fail(`No account for ${values.email}.`);
    let overrides = JSON.parse(String(user[1] ?? "{}")) as Partial<Limits>;
    if (values.reset) overrides = {};
    for (const pair of (values.set ?? "").split(",").filter(Boolean)) {
      const [k, v] = pair.split("=");
      if (!k || !(k in DEFAULT_LIMITS) || !/^\d+$/.test(v ?? "")) fail(`Bad setting ${pair}.`);
      overrides[k as keyof Limits] = Number(v);
    }
    if (values.set || values.reset) {
      const json = Object.keys(overrides).length ? q(JSON.stringify(overrides)) : "NULL";
      await d1Sql(`UPDATE users SET limits = ${json} WHERE id = ${q(String(user[0]))}`, where);
    }
    const limits = limitsFrom(JSON.stringify(overrides));
    console.log(JSON.stringify(limits));
    await printMonth(String(user[2]), Number(user[3] ?? 0), Number(user[4] ?? 0), limits);
    break;
  }
  case "invite":
  case "uninvite": {
    if (!values.email) fail(`Usage: ${positionals[0]} --email <email>`);
    const email = values.email.trim().toLowerCase();
    if (positionals[0] === "invite") {
      await d1Sql(
        `INSERT OR IGNORE INTO invites (email, created) VALUES (${q(email)}, ${q(new Date().toISOString())})`,
        where,
      );
      await d1Sql(
        `UPDATE waitlist SET decision = 'invited', decided = ${q(new Date().toISOString())} WHERE email = ${q(email)} AND decision IS NULL`,
        where,
      );
      console.log(
        `${email} is invited, but not emailed. Invite from the operator's portal (admin.tempra.dev) to email them too.`,
      );
    } else {
      await d1Sql(`DELETE FROM invites WHERE email = ${q(email)}`, where);
      console.log(`${email} is no longer invited.`);
    }
    break;
  }
  case "waitlist": {
    for (const [email, created] of await d1Sql(
      "SELECT email, created FROM invites ORDER BY created DESC",
      where,
    )) {
      console.log(`invited   ${created}  ${email}`);
    }
    for (const [email, created, decision] of await d1Sql(
      "SELECT email, created, COALESCE(decision, 'waiting') FROM waitlist ORDER BY created DESC",
      where,
    )) {
      // Approved rows are in the invites list above too.
      if (decision !== "invited") console.log(`${String(decision).padEnd(9)} ${created}  ${email}`);
    }
    break;
  }
  case "rename": {
    if (!values.email || !values.handle) fail("Usage: rename --email <email> --handle <handle>");
    const handle = checkHandle(values.handle, { reserved: "allow" });
    const user = await one(
      `SELECT id, handle FROM users WHERE email = ${q(values.email.toLowerCase())}`,
    );
    if (!user) fail(`No account for ${values.email}.`);
    const [id, old] = [String(user[0]), String(user[1])];
    if (old === handle) fail(`${values.email} already has the handle ${handle}.`);
    const cutoff = new Date(Date.now() - HANDLE_HOLD_DAYS * 86_400_000).toISOString();
    const other = await one(
      `SELECT 'live' FROM users WHERE handle = ${q(handle)} AND id != ${q(id)}
       UNION ALL SELECT 'held' FROM handle_holds
       WHERE handle = ${q(handle)} AND user != ${q(id)} AND released > ${q(cutoff)}`,
    );
    // An impersonating account is renamed first, then its handle given here: the hold is cleared.
    if (other?.[0] === "live") fail(`Another account has ${handle}; rename it first.`);
    await d1Sql(
      `UPDATE users SET handle = ${q(handle)}, actor = ${q(`human:${handle}`)} WHERE id = ${q(id)};
       INSERT OR REPLACE INTO handle_holds (handle, user, released)
         VALUES (${q(old)}, ${q(id)}, ${q(new Date().toISOString())});
       DELETE FROM handle_holds WHERE handle = ${q(handle)};`,
      where,
    );
    console.log(
      `${old} is now ${handle}${other ? " (its hold on another account was cleared)" : ""}.`,
    );
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
    fail(
      "Commands: transfer, share, unshare, suspend, users, limits, invite, uninvite, waitlist, rename (see scripts/admin.ts).",
    );
}

/**
 * This month against the monthly quotas (TEMPRA-232). Storage is the libraries' recorded bytes in
 * D1. The quota's own counts live in the account's AccountFeeds object, which no script reaches,
 * so writes and requests are read from Analytics Engine's metering (remote only): it counts the
 * app's own requests and writes too, so it reads a little above what the quota counts.
 */
async function printMonth(
  handle: string,
  storageBytes: number,
  libraries: number,
  limits: Limits,
): Promise<void> {
  const month = monthOf(Date.now());
  const resets = monthResets(month).toISOString().slice(0, 10);
  const mb = (b: number) => (b / 1048576).toFixed(1);
  console.log(`This month (${month}, resets ${resets} UTC):`);
  console.log(
    `  storage: ${mb(storageBytes)} MB of ${limits.storage_mb} MB, across ${libraries} libraries (as last recorded)`,
  );
  if (!values.remote) {
    console.log(
      "  writes and requests: no metering locally; the Account page shows the quota's count.",
    );
    return;
  }
  try {
    const counts = await meteredThisMonth(handle, month);
    console.log(
      `  writes: ${counts.write ?? 0} of ${limits.writes_monthly}; requests: ${counts.request ?? 0} of ${limits.requests_monthly} (metered, the app's included)`,
    );
  } catch (e) {
    console.log(`  writes and requests: Analytics Engine unavailable (${String(e)}).`);
  }
}

/** The month's metered requests and writes for an account, from Analytics Engine's SQL API. */
async function meteredThisMonth(handle: string, month: string): Promise<Record<string, number>> {
  const account = process.env.CLOUDFLARE_ACCOUNT_ID;
  const token = process.env.CLOUDFLARE_API_TOKEN;
  if (!account || !token) throw new Error("CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN unset");
  const dataset = deploymentFor(MODE).usage ?? "tempra_usage";
  if (!/^[a-z_]+$/.test(dataset)) throw new Error(`odd dataset name ${dataset}`);
  // usagePoint's layout (usage.ts): blob1 the kind, index1 the account. Only `request` and
  // `write` points count; `cost` points (TEMPRA-228, the op in blob4) are left out.
  const sql = `SELECT blob1 AS kind, SUM(_sample_interval) AS n FROM ${dataset}
    WHERE index1 = ${q(handle.slice(0, 96))} AND blob1 IN ('request', 'write')
      AND timestamp >= toDateTime(${q(`${month}-01 00:00:00`)})
    GROUP BY kind FORMAT JSON`;
  const res = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${account}/analytics_engine/sql`,
    { method: "POST", headers: { Authorization: `Bearer ${token}` }, body: sql },
  );
  if (!res.ok) throw new Error(`${res.status} ${(await res.text()).slice(0, 200)}`);
  const body = (await res.json()) as { data?: { kind: string; n: number | string }[] };
  return Object.fromEntries((body.data ?? []).map((r) => [r.kind, Number(r.n)]));
}
