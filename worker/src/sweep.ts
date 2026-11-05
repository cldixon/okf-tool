import type { BlobRefs } from "./blobrefs";
import { blobKey } from "./client";
import { DIGEST_HEALTH_LIBRARIES, type HealthCounts, type HealthDigest } from "./library-health";
import { MAIL_SENT_RETENTION_DAYS } from "./mail-queue";

/**
 * The daily sweep and operator digest (v2 spec: A3; TEMPRA-81, TEMPRA-91; tempra-dev:
 * v2/blob-sweep). Attachment bytes live in R2 by hash and are shared across libraries, so deleting
 * a library cannot delete them. Which blobs are stored and which libraries reference them is kept
 * in D1 as it changes (blobrefs.ts); the daily run deletes blobs unreferenced for GRACE_DAYS:
 * longer than the 30-day point-in-time window, so an undone restore never finds an attachment
 * gone. It lists no bucket and calls no library for the sweep: recounts, the one-time listing and
 * the drift scan are messages on SWEEP_QUEUE, a page or a library each. Deletion waits while any
 * library has not been counted once or has a restore's recount pending. The digest calls no
 * library either: it reads the health rows each library writes from its own pass (TEMPRA-92,
 * library-health.ts). Free of Worker APIs.
 */

export const GRACE_DAYS = 31;
const DAY_MS = 86_400_000;

/** How often every library is recounted, as a safety net against drift. */
export const FULL_RECOUNT_DAYS = 7;
/** Libraries per dispatch message; recounts are sent 100 to a batch (the Queues limit). */
export const DISPATCH_PAGE = 500;
/** Orphans per delete page (R2 deletes at most 1,000 keys a call), and pages per day. */
export const DELETE_PAGE = 1000;
export const DELETE_PAGES = 50;
/** Keys per listing page and stored blobs per scan page. */
export const LIST_PAGE = 1000;
/** A listing or scan chain that has not moved in this long is started again from where it was. */
const STALLED_MS = 6 * 3_600_000;

/** What travels on SWEEP_QUEUE. Every kind is safe to run twice. */
export type SweepMessage =
  | { kind: "dispatch"; all: boolean; after: string }
  | { kind: "recount"; library: string; token?: string }
  | { kind: "list"; cursor?: string }
  | { kind: "scan"; after: string };

export interface SweepQueue {
  send(message: SweepMessage): Promise<void>;
  sendBatch(messages: SweepMessage[]): Promise<void>;
}

export interface SweepDeps {
  refs: BlobRefs;
  queue: SweepQueue;
  bucket: { delete(keys: string[]): Promise<void> };
  /**
   * The libraries' own health rows (TEMPRA-92, library-health.ts healthDigest): their problems,
   * overdue passes and open work, read from D1 without calling any library.
   */
  health(now: Date): Promise<HealthDigest>;
  /** The account D1's daily prune (pruneAccounts); its counts go in the digest. */
  prune?: () => Promise<PruneResult>;
  now: Date;
}

export interface SweepResult {
  libraries: number;
  stored: number;
  referenced: number;
  orphaned: number;
  deleted: number;
  /** Which libraries were sent to be recounted: all of them, or those uncounted or pending. */
  recount: "all" | "open";
  /** Why nothing was deleted, when deletion was held. */
  held?: string;
  /** Things the operator should look at. */
  attention: string[];
  /** Libraries with open work, from their health rows, the most first (DIGEST_HEALTH_LIBRARIES). */
  health: { path: string; counts: HealthCounts }[];
  /** How many libraries have open work; absent means as many as `health` lists. */
  healthTotal?: number;
  /** Rows the account prune deleted; absent when it did not run. */
  pruned?: PruneResult;
  /** @tempra's spend this month (costs.ts agentSpendThisMonth); the Worker adds it after sweep(). */
  agentSpend?: { usd: number; projected: number; turns: number; accounts: number };
}

export async function sweep(d: SweepDeps): Promise<SweepResult> {
  const attention: string[] = [];
  const recount = await dispatch(d, attention);
  const { deleted, held, more } = await deleteExpired(d);
  if (held) attention.push(`Blob sweep held: ${held}.`);
  if (more) attention.push("Blob sweep: more expired blobs than a day deletes; the rest wait.");

  const report = await d.health(d.now);
  attention.push(...report.attention);

  let pruned: PruneResult | undefined;
  if (d.prune) {
    try {
      pruned = await d.prune();
    } catch (e) {
      attention.push(`Account prune failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  const counts = await d.refs.counts();
  return {
    libraries: report.libraries,
    stored: counts.stored,
    referenced: counts.referenced,
    orphaned: counts.waiting,
    deleted,
    recount,
    ...(held ? { held } : {}),
    attention,
    health: report.health,
    healthTotal: report.healthTotal,
    ...(pruned ? { pruned } : {}),
  };
}

/**
 * Starts the day's fan-out with one message: every library on a full day (the first run, then
 * every FULL_RECOUNT_DAYS), otherwise only those uncounted or pending. Also starts, or restarts
 * where it stalled, the one-time listing of the bucket, and on a full day the drift scan.
 */
async function dispatch(d: SweepDeps, attention: string[]): Promise<"all" | "open"> {
  const stalled = (s: { updated: string } | null) =>
    !s || Date.parse(s.updated) <= d.now.getTime() - STALLED_MS;
  const fullAt = await d.refs.state("full_at");
  const all = !fullAt || Date.parse(fullAt.value) <= d.now.getTime() - FULL_RECOUNT_DAYS * DAY_MS;
  await d.queue.send({ kind: "dispatch", all, after: "" });
  if (all) {
    await d.refs.setState("full_at", d.now.toISOString(), d.now);
    await d.refs.setState("full_dispatch", "", d.now);
  } else {
    // A full pass whose paging stopped (a message that ran out of retries) goes on from there.
    const full = await d.refs.state("full_dispatch");
    if (full && full.value !== "done" && stalled(full)) {
      await d.queue.send({ kind: "dispatch", all: true, after: full.value });
      await d.refs.setState("full_dispatch", full.value, d.now);
      attention.push("Blob recount dispatch stalled; started again.");
    }
  }

  const listing = await d.refs.state("listing");
  if (listing?.value !== "done" && stalled(listing)) {
    await d.queue.send({ kind: "list", ...(listing?.value ? { cursor: listing.value } : {}) });
    await d.refs.setState("listing", listing?.value ?? "", d.now);
    if (listing) attention.push("Blob listing (one-time backfill) stalled; started again.");
  }
  const scan = await d.refs.state("scan");
  if (all || (scan && scan.value !== "done" && stalled(scan))) {
    const after = all ? "" : (scan?.value ?? "");
    await d.queue.send({ kind: "scan", after });
    await d.refs.setState("scan", after, d.now);
  }
  return all ? "all" : "open";
}

/**
 * The delete step: orphans unreferenced for GRACE_DAYS, a page at a time. Each page is claimed in
 * D1 first (a blob uploaded or referenced again in between is not claimed), then its bytes go,
 * then its stored rows. Held while any library is uncounted or pending.
 */
async function deleteExpired(
  d: SweepDeps,
): Promise<{ deleted: number; held?: string; more: boolean }> {
  // Until one full pass has paged through every library, a library from before may have no
  // count-state row at all, and may reference anything.
  if ((await d.refs.state("ensured"))?.value !== "done") {
    return {
      deleted: 0,
      held: "the first count of every library has not finished",
      more: false,
    };
  }
  const holding = await d.refs.held(5);
  if (holding.count > 0) {
    const more =
      holding.count > holding.paths.length
        ? `, and ${holding.count - holding.paths.length} more`
        : "";
    return {
      deleted: 0,
      held: `${holding.count} ${holding.count === 1 ? "library" : "libraries"} not counted yet or with a restore's recount pending (${holding.paths.join(", ")}${more})`,
      more: false,
    };
  }
  const cutoff = new Date(d.now.getTime() - GRACE_DAYS * DAY_MS).toISOString();
  let deleted = 0;
  for (let page = 0; page < DELETE_PAGES; page++) {
    const due = await d.refs.expired(cutoff, DELETE_PAGE);
    if (due.length === 0) return { deleted, more: false };
    const claimed = await d.refs.claim(due, cutoff);
    if (claimed.length > 0) {
      try {
        await d.bucket.delete(claimed.map((c) => blobKey(c.hash)));
      } catch (e) {
        await d.refs.unclaim(claimed);
        throw e;
      }
      await d.refs.dropStored(claimed.map((c) => c.hash));
      deleted += claimed.length;
    }
    if (due.length < DELETE_PAGE) return { deleted, more: false };
  }
  return { deleted, more: true };
}

export interface SweepConsumerDeps {
  refs: BlobRefs;
  queue: SweepQueue;
  /** The attachment hashes a library references (its DO's blobRefs()). */
  libraryHashes(library: string): Promise<string[]>;
  bucket: {
    list(opts: { prefix: string; cursor?: string; limit: number }): Promise<{
      objects: { key: string; uploaded: Date }[];
      truncated: boolean;
      cursor?: string;
    }>;
  };
  now: () => Date;
}

/** What one message did, for the log. */
export type SweepOutcome =
  | { kind: "dispatch"; sent: number; next: boolean }
  | { kind: "recount"; library: string; added: number; removed: number }
  | { kind: "recount"; library: string; forgotten: number }
  | { kind: "list"; stored: number; next: boolean }
  | { kind: "scan"; marked: number; next: boolean };

/** Handles one SWEEP_QUEUE message; throws to have it retried. */
export async function handleSweepMessage(
  m: SweepMessage,
  d: SweepConsumerDeps,
): Promise<SweepOutcome> {
  switch (m.kind) {
    case "dispatch": {
      const page = m.all
        ? await d.refs.libraryPage(m.after, DISPATCH_PAGE)
        : await d.refs.openPage(m.after, DISPATCH_PAGE);
      // Every library has a row before it is counted, so an uncounted one holds deletion.
      if (m.all) await d.refs.ensure(page.map((r) => r.library));
      // A pending restore's token rides along: the cron runs long after the restore's restart.
      const recounts: SweepMessage[] = page.map((r) => ({
        kind: "recount",
        library: r.library,
        ...(r.pending ? { token: r.pending } : {}),
      }));
      const last = page[page.length - 1]?.library;
      const full = page.length === DISPATCH_PAGE;
      for (let i = 0; i < recounts.length; i += 100) {
        await d.queue.sendBatch(recounts.slice(i, i + 100));
      }
      const next = full && last !== undefined;
      if (next) await d.queue.send({ kind: "dispatch", all: m.all, after: last as string });
      if (m.all) {
        const now = d.now();
        await d.refs.setState("full_dispatch", next ? (last as string) : "done", now);
        if (!next) await d.refs.setState("ensured", "done", now);
      }
      return { kind: "dispatch", sent: recounts.length, next };
    }
    case "recount": {
      if (!(await d.refs.exists(m.library))) {
        return {
          kind: "recount",
          library: m.library,
          forgotten: await d.refs.forget(m.library, d.now()),
        };
      }
      const takenAt = d.now();
      const hashes = await d.libraryHashes(m.library);
      const r = await d.refs.replace(m.library, hashes, takenAt, m.token);
      return { kind: "recount", library: m.library, ...r };
    }
    case "list": {
      const page = await d.bucket.list({ prefix: "blobs/", cursor: m.cursor, limit: LIST_PAGE });
      const now = d.now();
      await d.refs.storedFromListing(
        page.objects.map((o) => ({
          hash: o.key.slice("blobs/".length),
          created: o.uploaded.toISOString(),
        })),
        now,
      );
      const next = page.truncated && page.cursor ? page.cursor : undefined;
      await d.refs.setState("listing", next ?? "done", now);
      if (next) await d.queue.send({ kind: "list", cursor: next });
      return { kind: "list", stored: page.objects.length, next: next !== undefined };
    }
    case "scan": {
      const now = d.now();
      const r = await d.refs.scan(m.after, LIST_PAGE, now);
      await d.refs.setState("scan", r.last ?? "done", now);
      if (r.last) await d.queue.send({ kind: "scan", after: r.last });
      return { kind: "scan", marked: r.marked, next: r.last !== null };
    }
  }
}

/** Something on SWEEP_QUEUE that is not a SweepMessage (acked and logged, never retried). */
export function isSweepMessage(m: unknown): m is SweepMessage {
  if (!m || typeof m !== "object") return false;
  const k = (m as { kind?: unknown }).kind;
  return k === "dispatch" || k === "recount" || k === "list" || k === "scan";
}

/** One library's open work for the digest: "owner/slug: stale 2 · lint 1". */
export function healthLine(path: string, c: HealthCounts): string {
  const parts: [string, number][] = [
    ["stale", c.stale],
    ["stale soon", c.stale_soon],
    ["broken links", c.broken_link],
    ["lint", c.lint],
    ["hotlinked images", c.external_image ?? 0],
    ["structure", c.structure],
    ["open comments", c.comment],
  ];
  return `${path}: ${parts
    .filter(([, n]) => n > 0)
    .map(([k, n]) => `${k} ${n}`)
    .join(" · ")}`;
}

export function digestText(r: SweepResult): string {
  const shown = r.health.slice(0, DIGEST_HEALTH_LIBRARIES);
  return [
    "Tempra daily digest",
    "",
    ...r.attention.map((a) => `- ${a}`),
    "",
    ...(shown.length > 0
      ? [
          "Library health (open work):",
          ...shown.map((h) => `- ${healthLine(h.path, h.counts)}`),
          ...((r.healthTotal ?? r.health.length) > shown.length
            ? [`- and ${(r.healthTotal ?? r.health.length) - shown.length} more libraries`]
            : []),
          "",
        ]
      : []),
    `Libraries ${r.libraries}. Blobs stored ${r.stored}, referenced ${r.referenced}, waiting ${r.orphaned}, deleted ${r.deleted}${r.held ? " (deletion held)" : ""}. Recounted ${r.recount === "all" ? "every library" : "libraries not yet counted or restored"}.`,
    ...(r.pruned
      ? [
          `Pruned sessions ${r.pruned.sessions}, sign-in links ${r.pruned.sign_in_links}, invitations ${r.pruned.invitations}, sent mail keys ${r.pruned.mail_sent}.`,
        ]
      : []),
    ...(r.agentSpend ? [agentSpendLine(r.agentSpend)] : []),
    "",
  ].join("\n");
}

/**
 * The digest's cost line (TEMPRA-233): @tempra's spend at list price this month. Cloudflare's own
 * usage needs the Analytics API and a token the Worker does not hold; `bun run costs` reports it (TEMPRA-236).
 */
export function agentSpendLine(a: NonNullable<SweepResult["agentSpend"]>): string {
  const d = (v: number) => `$${v.toFixed(2)}`;
  return `@tempra this month: ${d(a.usd)} so far, about ${d(a.projected)} projected (${a.turns} turns, ${a.accounts} accounts).`;
}

/** How long a sign-in link row is kept: past its expiry, it only counts toward rate limits. */
export const LINK_RETENTION_DAYS = 1;
/** How long a declined, revoked or expired invitation is kept (a day's limit counts by created). */
export const INVITATION_RETENTION_DAYS = 30;
/** Rows deleted per statement, so the prune never holds D1 for long. */
const PRUNE_BATCH = 1000;
/** Statements per table per day; what is left waits for tomorrow. */
const PRUNE_ROUNDS = 50;

export interface PruneResult {
  sessions: number;
  sign_in_links: number;
  invitations: number;
  /** Outgoing mail's dedupe keys past MAIL_SENT_RETENTION_DAYS (TEMPRA-89). */
  mail_sent: number;
}

/**
 * The account D1's daily prune (TEMPRA-79): expired sessions (idle_expires is never later than
 * expires, so it covers both limits), sign-in links older than a day, and invitations declined,
 * revoked or expired a month ago. Accepted invitations, deleted_accounts, handle_holds, invites
 * and the waitlist are kept: guards and records, growing with people rather than events.
 */
export async function pruneAccounts(db: D1Database, now: Date): Promise<PruneResult> {
  const t = now.getTime();
  const iso = (ms: number) => new Date(ms).toISOString();
  const nowIso = iso(t);
  const invitationsBefore = iso(t - INVITATION_RETENTION_DAYS * DAY_MS);
  return {
    sessions: await pruneBatches(db, "sessions", "idle_expires <= ?1", [nowIso]),
    // An invitation's link (TEMPRA-287) is kept until 30 days past its expiry, so a dead one can
    // still fill its address in at /sign-in.
    sign_in_links: await pruneBatches(
      db,
      "sign_in_links",
      "created < ?1 AND (purpose <> 'invitation' OR expires < ?2)",
      [iso(t - LINK_RETENTION_DAYS * DAY_MS), iso(t - INVITATION_RETENTION_DAYS * DAY_MS)],
    ),
    invitations: await pruneBatches(
      db,
      "library_invitations",
      "(status IN ('declined', 'revoked') AND decided < ?1) OR (status = 'pending' AND expires < ?1)",
      [invitationsBefore],
    ),
    mail_sent: await pruneBatches(db, "mail_sent", "claimed_at < ?1", [
      iso(t - MAIL_SENT_RETENTION_DAYS * DAY_MS),
    ]),
  };
}

async function pruneBatches(
  db: D1Database,
  table: string,
  where: string,
  params: unknown[],
): Promise<number> {
  let total = 0;
  for (let i = 0; i < PRUNE_ROUNDS; i++) {
    const r = await db
      .prepare(
        `DELETE FROM ${table} WHERE rowid IN (SELECT rowid FROM ${table} WHERE ${where} LIMIT ${PRUNE_BATCH})`,
      )
      .bind(...params)
      .run();
    const n = r.meta.changes ?? 0;
    total += n;
    if (n < PRUNE_BATCH) break;
  }
  return total;
}
