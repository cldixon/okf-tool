/**
 * Monthly quotas per account (TEMPRA-232, tempra-dev: v2/limits, Monthly quotas), beside the
 * per-minute rate limits: writes a UTC calendar month (refusing writes), requests a month
 * (refusing every request from the account's tokens and app connections, reads too: a ceiling
 * sized for parallel agents), and storage across the libraries an account owns (refusing what
 * adds). Counted without a D1 write per request: each isolate keeps a tally per account in memory
 * and adds it to the account's AccountFeeds object at most every few seconds, one call that
 * answers the month's totals; checks read the last totals plus the isolate's own tally, so most
 * requests cost no I/O at all. Being a little over is fine. Counts are kept by user id, so a
 * changed handle keeps its month. Free of Worker APIs; tests run it on bun:sqlite.
 */
import type { TokenInfo } from "./auth";
import { grows, type LibraryClient, type LibraryMethod } from "./client";
import { WRITE_METHODS } from "./feed";
import { type Limits, limitsFrom } from "./limits";
import type { Outbox } from "./mail-queue";
import { renderMail } from "./mail-template";
import type { NewItem } from "./notify";
import { StoreError } from "./store/errors";
import type { SqlHandle } from "./store/sql";
import { tokenAdmission } from "./usage";

/** How often an isolate adds its tally to the account's object, at most. */
export const FLUSH_MS = 5_000;
/** How long an isolate keeps an account's limits and an owner's storage before reading again. */
export const REFRESH_MS = 60_000;
/** The person is told once a month at each of these, in percent of a quota. */
export const NOTICE_AT = [80, 100] as const;
/** How often a library records its storage in D1, at most. */
export const STORAGE_REPORT_MS = 60_000;

const MB = 1048576;

export type QuotaKind = "writes" | "requests" | "storage";

export interface Counts {
  writes: number;
  requests: number;
}

const zero = (): Counts => ({ writes: 0, requests: 0 });

/** The UTC calendar month a time falls in, as `YYYY-MM`. */
export const monthOf = (now: number): string => new Date(now).toISOString().slice(0, 7);

/** When a month's counts start again: the first of the next month, 00:00 UTC. */
export function monthResets(month: string): Date {
  const [y, m] = month.split("-").map(Number) as [number, number];
  return new Date(Date.UTC(y, m, 1));
}

/** "1 December 2026": how people read when a quota resets. */
export const resetDay = (month: string): string =>
  monthResets(month).toLocaleDateString("en-GB", {
    day: "numeric",
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  });

/** The name of the account's object that keeps its counts: by user id, beside the feed leases. */
export const counterName = (userId: string) => `quota:${userId}`;

// ---------------------------------------------------------------- the account's object

/**
 * The month's counts and the notices sent, in the account's AccountFeeds object's SQLite. Months
 * before the last are dropped as a new one starts.
 */
export class QuotaCounter {
  constructor(private readonly sql: SqlHandle) {
    sql.script(
      `CREATE TABLE IF NOT EXISTS quota_months (month TEXT PRIMARY KEY, writes INTEGER NOT NULL, requests INTEGER NOT NULL);
       CREATE TABLE IF NOT EXISTS quota_notices (month TEXT NOT NULL, key TEXT NOT NULL, PRIMARY KEY (month, key));`,
    );
  }

  /** Adds a tally to the month and answers its totals. */
  add(month: string, add: Counts): Counts {
    const writes = Math.max(0, Math.floor(add.writes));
    const requests = Math.max(0, Math.floor(add.requests));
    if (writes || requests) {
      if (this.sql.all("SELECT 1 FROM quota_months WHERE month = ?", month).length === 0) {
        // A new month: the one before it stays for the Account page's sake, older ones go.
        this.sql.run("DELETE FROM quota_months WHERE month < ?", previousMonth(month));
        this.sql.run("DELETE FROM quota_notices WHERE month < ?", month);
      }
      this.sql.run(
        `INSERT INTO quota_months (month, writes, requests) VALUES (?, ?, ?)
         ON CONFLICT (month) DO UPDATE SET writes = writes + excluded.writes,
                                           requests = requests + excluded.requests`,
        month,
        writes,
        requests,
      );
    }
    return this.get(month);
  }

  get(month: string): Counts {
    const row = this.sql.all<Counts>(
      "SELECT writes, requests FROM quota_months WHERE month = ?",
      month,
    )[0];
    return row ? { writes: row.writes, requests: row.requests } : zero();
  }

  /** Records notices as sent; answers those not sent before, so each goes once a month. */
  mark(month: string, keys: string[]): string[] {
    const fresh: string[] = [];
    for (const key of new Set(keys)) {
      if (
        this.sql.all("SELECT 1 FROM quota_notices WHERE month = ? AND key = ?", month, key).length
      )
        continue;
      this.sql.run("INSERT INTO quota_notices (month, key) VALUES (?, ?)", month, key);
      fresh.push(key);
    }
    return fresh;
  }
}

function previousMonth(month: string): string {
  const [y, m] = month.split("-").map(Number) as [number, number];
  return monthOf(Date.UTC(y, m - 2, 1));
}

// ---------------------------------------------------------------- the Worker's side

/** An account as the quotas see it. */
export interface QuotaAccount {
  /** The user id: what its counts and notices are kept by. */
  id: string;
  handle: string;
  email: string;
  limits: Limits;
  /** The sum of its libraries' recorded storage. */
  storageBytes: number;
}

/** A notice for the bell, as quota.ts makes it (notify.ts adds it as a `quota` item). */
export interface QuotaNotice {
  quota: QuotaKind;
  pct: number;
  title: string;
  excerpt: string;
}

/** What the quotas need: the account's object, D1, the bell and mail. */
export interface QuotaBackend {
  /** Adds a tally to the account's month (in its object, by user id); answers the totals. */
  add(userId: string, month: string, add: Counts): Promise<Counts>;
  /** Records notices as sent (in the account's object); answers those not sent before. */
  mark(userId: string, month: string, keys: string[]): Promise<string[]>;
  /** The account by handle; null for none (a token from before handles: no quotas). */
  account(handle: string): Promise<QuotaAccount | null>;
  /** The account by user id. */
  accountById(userId: string): Promise<QuotaAccount | null>;
  /** The account that owns a library. */
  owner(libraryId: string): Promise<QuotaAccount | null>;
  /** Queues the notice's mail (TEMPRA-89); `key` makes a repeat of the same notice one mail. */
  mail(msg: {
    key: string;
    account: string;
    to: string;
    subject: string;
    text: string;
    html?: string;
  }): Promise<void>;
  /** Puts a notice in the person's bell. */
  notice(userId: string, n: QuotaNotice): Promise<void>;
}

interface Tally {
  month: string;
  /** Counted here since the last flush. */
  pending: Counts;
  /** The month's totals as the account's object last answered. */
  totals: Counts;
  account: QuotaAccount | null;
  loadedAt: number;
  flushedAt: number;
  /** Notices this isolate knows were sent this month. */
  marked: Set<string>;
  busy: Promise<void> | null;
}

/** This month's usage against the quotas, for the Account page and the admin script. */
export interface QuotaUsage {
  month: string;
  /** When the month's counts start again (ISO). */
  resets: string;
  writes: { used: number; limit: number };
  requests: { used: number; limit: number };
  storage: { used: number; limit: number };
}

export class Quota {
  /** By handle, as admissions name the account; what is durable is kept by its user id. */
  private readonly tallies = new Map<string, Tally>();
  private readonly owners = new Map<
    string,
    { at: number; owner: QuotaAccount | null; busy?: Promise<void> }
  >();
  private readonly now: () => number;
  private readonly flushMs: number;
  private readonly refreshMs: number;
  /** The app's origin, for links to the Account page. */
  private readonly origin: string;

  constructor(
    private readonly b: QuotaBackend,
    opts: { origin?: string; now?: () => number; flushMs?: number; refreshMs?: number } = {},
  ) {
    this.now = opts.now ?? Date.now;
    this.flushMs = opts.flushMs ?? FLUSH_MS;
    this.refreshMs = opts.refreshMs ?? REFRESH_MS;
    this.origin = opts.origin ?? "";
  }

  private tally(handle: string): Tally {
    const month = monthOf(this.now());
    let t = this.tallies.get(handle);
    if (!t) {
      t = {
        month,
        pending: zero(),
        totals: zero(),
        account: null,
        loadedAt: 0,
        flushedAt: 0,
        marked: new Set(),
        busy: null,
      };
      this.tallies.set(handle, t);
    } else if (t.month !== month) {
      // A new month: what this isolate held of the last one (a few seconds) is let go.
      t.month = month;
      t.pending = zero();
      t.totals = zero();
      t.marked = new Set();
      t.flushedAt = 0;
    }
    return t;
  }

  /**
   * Counts a request from the account's tokens or app connections, and refuses it (403
   * `quota_reached`) once the month's requests are past the ceiling: reads included. A count is
   * in memory, added to the account's object when the last flush is older than FLUSH_MS.
   */
  async admitRequest(handle: string): Promise<void> {
    const t = this.tally(handle);
    t.pending.requests++;
    if (!t.loadedAt || this.now() - t.flushedAt >= this.flushMs) await this.flush(handle, t);
    const a = t.account;
    if (a && this.used(t, "requests") > a.limits.requests_monthly) {
      throw this.reached("requests", a.limits.requests_monthly, this.used(t, "requests"), t.month);
    }
  }

  /** 403 `quota_reached` when the account's writes this month are at the limit. */
  async checkWrite(handle: string): Promise<void> {
    const t = this.tally(handle);
    if (!t.loadedAt) await this.flush(handle, t);
    const a = t.account;
    if (a && this.used(t, "writes") >= a.limits.writes_monthly) {
      throw this.reached("writes", a.limits.writes_monthly, this.used(t, "writes"), t.month);
    }
  }

  /** Counts a write that went through (a refused one is never counted). */
  async countWrite(handle: string): Promise<void> {
    const t = this.tally(handle);
    t.pending.writes++;
    if (this.now() - t.flushedAt >= this.flushMs) await this.flush(handle, t);
  }

  private flush(handle: string, t: Tally): Promise<void> {
    if (t.busy) return t.busy;
    const run = async () => {
      const now = this.now();
      t.flushedAt = now;
      if (!t.loadedAt || now - t.loadedAt >= this.refreshMs) {
        t.account = await this.b.account(handle);
        t.loadedAt = now;
      }
      // No such account (a token from before handles): no quotas, and no object for it.
      const a = t.account;
      if (!a) {
        t.pending = zero();
        return;
      }
      const month = t.month;
      const add = t.pending;
      t.pending = zero();
      try {
        const totals = await this.b.add(a.id, month, add);
        if (t.month === month) t.totals = totals;
      } catch (e) {
        // Kept for the next flush; the checks go on from what they knew.
        if (t.month === month) {
          t.pending.writes += add.writes;
          t.pending.requests += add.requests;
        }
        throw e;
      }
      await this.notify(a, month, t.marked, {
        writes: this.used(t, "writes"),
        requests: this.used(t, "requests"),
      });
    };
    t.busy = run()
      .catch((e) => console.error(JSON.stringify({ quota_flush_failed: handle, error: String(e) })))
      .finally(() => {
        t.busy = null;
      });
    return t.busy;
  }

  private used(t: Tally, kind: "writes" | "requests"): number {
    return t.totals[kind] + t.pending[kind];
  }

  /** 403 `quota_reached` when the library's owner is at their storage across libraries. */
  async checkStorage(libraryId: string): Promise<void> {
    let o = this.owners.get(libraryId);
    if (!o || this.now() - o.at >= this.refreshMs) {
      const entry = o ?? { at: 0, owner: null };
      this.owners.set(libraryId, entry);
      entry.busy ??= (async () => {
        try {
          entry.owner = await this.b.owner(libraryId);
          entry.at = this.now();
          const owner = entry.owner;
          if (owner) {
            const month = monthOf(this.now());
            await this.notify(owner, month, this.tally(owner.handle).marked, {
              storage: owner.storageBytes,
            });
          }
        } catch (e) {
          console.error(JSON.stringify({ quota_storage_failed: libraryId, error: String(e) }));
        } finally {
          entry.busy = undefined;
        }
      })();
      await entry.busy;
      o = entry;
    }
    const owner = o.owner;
    if (owner && owner.storageBytes >= owner.limits.storage_mb * MB) {
      throw this.reached(
        "storage",
        owner.limits.storage_mb,
        owner.storageBytes,
        monthOf(this.now()),
      );
    }
  }

  /** This month's usage against the quotas, read fresh; null for no such account. */
  async usage(userId: string): Promise<QuotaUsage | null> {
    const a = await this.b.accountById(userId);
    if (!a) return null;
    const month = monthOf(this.now());
    const totals = await this.b.add(a.id, month, zero());
    return {
      month,
      resets: monthResets(month).toISOString(),
      writes: { used: totals.writes, limit: a.limits.writes_monthly },
      requests: { used: totals.requests, limit: a.limits.requests_monthly },
      storage: { used: a.storageBytes, limit: a.limits.storage_mb * MB },
    };
  }

  private reached(kind: QuotaKind, limit: number, used: number, month: string): StoreError {
    return quotaReached(kind, limit, used, month, this.origin);
  }

  /**
   * Tells the account's person once a month at 80% and at 100% of a quota, in the bell and by
   * mail (tempra-dev: v2/limits, Telling the person; decisions/notifications-from-zero, addendum
   * 2026-10-31). The object records what was sent, so each notice goes once however many isolates
   * see the line crossed; only the highest one crossed goes.
   */
  private async notify(
    a: QuotaAccount,
    month: string,
    marked: Set<string>,
    used: Partial<Record<QuotaKind, number>>,
  ): Promise<void> {
    const due: { kind: QuotaKind; pct: number; key: string }[] = [];
    for (const kind of Object.keys(used) as QuotaKind[]) {
      const limit = limitOf(a.limits, kind);
      const n = used[kind] ?? 0;
      for (const pct of NOTICE_AT) {
        const key = `${kind}:${pct}`;
        if (!marked.has(key) && limit > 0 && n * 100 >= limit * pct) due.push({ kind, pct, key });
      }
    }
    if (due.length === 0) return;
    const fresh = new Set(
      await this.b.mark(
        a.id,
        month,
        due.map((d) => d.key),
      ),
    );
    for (const d of due) marked.add(d.key);
    for (const kind of new Set(due.map((d) => d.kind))) {
      const top = due.filter((d) => d.kind === kind && fresh.has(d.key)).at(-1);
      if (!top) continue;
      const limit = limitOf(a.limits, kind);
      const n = used[kind] ?? 0;
      const said = (e: unknown) =>
        console.error(JSON.stringify({ quota_notice_failed: a.id, error: String(e) }));
      await this.b.notice(a.id, quotaNotice(kind, top.pct, limit, n, month)).catch(said);
      const msg = quotaMail(kind, top.pct, limit, n, month, this.origin);
      const key = `quota:${a.id}:${month}:${kind}:${top.pct}`;
      await this.b.mail({ key, account: a.handle, to: a.email, ...msg }).catch(said);
    }
  }
}

/** A quota's limit in its own units: writes, requests, or bytes of storage. */
function limitOf(limits: Limits, kind: QuotaKind): number {
  if (kind === "writes") return limits.writes_monthly;
  if (kind === "requests") return limits.requests_monthly;
  return limits.storage_mb * MB;
}

const num = (n: number) => n.toLocaleString("en-US");
const mb = (bytes: number) => num(Math.round(bytes / MB));

/** What each quota is called where people read it. */
const NAMES: Record<QuotaKind, string> = {
  writes: "writes",
  requests: "tool calls and API requests",
  storage: "storage",
};

/** "100,000 writes", "1,024 MB of storage": a limit as people read it. */
function limitText(kind: QuotaKind, limit: number): string {
  return kind === "storage" ? `${num(limit)} MB of storage` : `${num(limit)} ${NAMES[kind]}`;
}

/**
 * The refusal: which limit, the count, what still works, when it resets (storage: delete or
 * move content), and where the usage shows. `limit` is in MB for storage, `used` in bytes.
 */
export function quotaReached(
  kind: QuotaKind,
  limit: number,
  used: number,
  month: string,
  origin = "",
): StoreError {
  const usage = `${origin}/account#usage`;
  const resets = monthResets(month).toISOString();
  const day = `${resetDay(month)} (UTC)`;
  const message =
    kind === "storage"
      ? `This account has reached its limit of ${limitText(kind, limit)}: ${mb(used)} MB is used across its libraries. Reads still work; delete or move content to write again. Usage: ${usage}`
      : kind === "writes"
        ? `This account has reached its monthly limit of ${limitText(kind, limit)}: ${num(used)} this month. Reads still work; writes start again on ${day}. Usage: ${usage}`
        : `This account has reached its monthly limit of ${limitText(kind, limit)}: ${num(used)} this month. Nothing more is answered for its agents and apps, reads included, until ${day}; the person's own browser keeps working. Usage: ${usage}`;
  return new StoreError(
    403,
    "quota_reached",
    message,
    kind === "storage"
      ? { quota: kind, limit, used, usage }
      : { quota: kind, limit, used, resets, usage },
  );
}

/** What a quota is called in the bell, as the item's title. */
const TITLES: Record<QuotaKind, string> = {
  writes: "Writes this month",
  requests: "Tool calls and API requests this month",
  storage: "Storage",
};

/** The bell's item at 80% or 100% of a quota: its title and a detail line. */
export function quotaNotice(
  kind: QuotaKind,
  pct: number,
  limit: number,
  used: number,
  month: string,
): QuotaNotice {
  const of =
    kind === "storage" ? `${mb(used)} MB of ${mb(limit)} MB` : `${num(used)} of ${num(limit)}`;
  const after =
    kind === "storage"
      ? "delete or move content to write again"
      : kind === "writes"
        ? `writes start again on ${resetDay(month)}`
        : `agents get no answers until ${resetDay(month)}`;
  return {
    quota: kind,
    pct,
    title: TITLES[kind],
    excerpt: pct >= 100 ? `Limit reached: ${of}; ${after}` : `${pct}% used: ${of}`,
  };
}

/** The mail at 80% or 100% of a quota. `limit` and `used` in the quota's units (bytes). */
export function quotaMail(
  kind: QuotaKind,
  pct: number,
  limit: number,
  used: number,
  month: string,
  origin: string,
): { subject: string; text: string; html: string } {
  const what = kind === "storage" ? "storage" : `monthly ${NAMES[kind]}`;
  const subject =
    pct >= 100
      ? `Your Tempra account has reached its ${what} limit`
      : `Your Tempra account has used ${pct}% of its ${what}`;
  const of =
    kind === "storage"
      ? `${mb(used)} MB of ${limitText(kind, limit / MB)}`
      : `${num(used)} of ${limitText(kind, limit)} this month`;
  const atLimit =
    kind === "storage"
      ? "your agents can still read, but writes that add are refused until content is deleted or moved."
      : kind === "writes"
        ? `your agents can still read, but their writes are refused until ${resetDay(month)} (UTC).`
        : `nothing more is answered for your agents and apps, reads included, until ${resetDay(month)} (UTC). Tempra in your browser keeps working.`;
  const mail = renderMail({
    headline:
      pct >= 100 ? `You've reached your ${what} limit` : `You've used ${pct}% of your ${what}`,
    line:
      pct >= 100
        ? `Your account has used ${of}. Now ${atLimit}`
        : `Your account has used ${of}. At the limit, ${atLimit}`,
    button: { label: "See this month's usage", href: `${origin}/account#usage` },
    foot: "If one of your agents is stuck in a loop, stop it.",
  });
  return { subject, ...mail };
}

/**
 * The library's client with the quotas in front of its writes: an agent's write is refused when
 * the account it acts for is at its monthly writes, and counted only when it went through; any
 * write that adds is refused when the library's owner is at their storage. A person in the app is
 * not held to the monthly counts (as with the per-minute limits), only to storage. Reads pass
 * straight through (the request ceiling refuses them earlier, in `admit`).
 */
export function quotaGuarded(
  quota: Quota | undefined,
  token: TokenInfo,
  lib: LibraryClient,
): LibraryClient {
  if (!quota) return lib;
  const agent = !token.id.startsWith("session:");
  const { account } = tokenAdmission(token);
  const out = { ...lib };
  for (const m of WRITE_METHODS as Set<LibraryMethod>) {
    const call = lib[m] as unknown as (...a: unknown[]) => Promise<unknown>;
    (out as Record<string, unknown>)[m] = async (...args: unknown[]) => {
      if (agent) await quota.checkWrite(account);
      // The store's methods take the request context first, then the method's own arguments.
      if (grows(m, args)) await quota.checkStorage(token.library.id);
      const result = await call(...args);
      if (agent) await quota.countWrite(account);
      return result;
    };
  }
  return out;
}

// ---------------------------------------------------------------- D1

/** The account's quota facts from D1: its id, limits, email and its libraries' storage. */
export function d1QuotaAccounts(db: D1Database) {
  const pick = async (where: string, value: string): Promise<QuotaAccount | null> => {
    const row = await db
      .prepare(
        `SELECT u.id, u.handle, u.email, u.limits,
                (SELECT COALESCE(SUM(storage_bytes), 0) FROM libraries WHERE owner = u.id) AS storage
           FROM users u WHERE ${where}`,
      )
      .bind(value)
      .first<{
        id: string;
        handle: string;
        email: string;
        limits: string | null;
        storage: number;
      }>();
    if (!row?.id || !row.handle) return null;
    return {
      id: row.id,
      handle: row.handle,
      email: row.email,
      limits: limitsFrom(row.limits),
      storageBytes: row.storage ?? 0,
    };
  };
  return {
    account: (handle: string) => pick("u.handle = ?", handle),
    accountById: (userId: string) => pick("u.id = ?", userId),
    owner: (libraryId: string) =>
      pick("u.id = (SELECT owner FROM libraries WHERE id = ?)", libraryId),
  };
}

/** The account's object as the quotas call it (AccountFeeds, or a QuotaCounter in tests). */
export interface QuotaCounterStub {
  quotaAdd(month: string, add: Counts): Promise<Counts>;
  quotaMark(month: string, keys: string[]): Promise<string[]>;
}

/**
 * The backend from D1, the account's object (by user id), the notifications (the bell) and the
 * outbox (mail-queue.ts; none: no mail).
 */
export function quotaBackend(
  db: D1Database,
  counter: (userId: string) => QuotaCounterStub,
  outbox: Outbox | null,
  notifications: { add(items: NewItem[]): Promise<void> } | null,
): QuotaBackend {
  const accounts = d1QuotaAccounts(db);
  return {
    add: (userId, month, add) => counter(userId).quotaAdd(month, add),
    mark: (userId, month, keys) => counter(userId).quotaMark(month, keys),
    account: accounts.account,
    accountById: accounts.accountById,
    owner: accounts.owner,
    mail: async (msg) => {
      await outbox?.send({ kind: "quota", ...msg });
    },
    notice: async (userId, n) => {
      // On no library; mailed at once above, never in the batched mail.
      await notifications?.add([
        {
          user: userId,
          library: null,
          kind: "quota",
          place: "",
          actor: "tempra",
          title: n.title,
          excerpt: n.excerpt,
          mail: false,
        },
      ]);
    },
  };
}

/** A library's storage, recorded by its object and by the daily cron. */
export async function recordStorage(db: D1Database, doId: string, bytes: number): Promise<void> {
  await db
    .prepare("UPDATE libraries SET storage_bytes = ? WHERE do_id = ?")
    .bind(Math.max(0, Math.round(bytes)), doId)
    .run();
}

/**
 * Throttles a library's storage reports: the first write's at once, then at most one a
 * STORAGE_REPORT_MS, the last always sent, so D1 sees a write a minute at most from a busy library.
 */
export class StorageReport {
  private at = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly record: (bytes: number) => Promise<void>,
    private readonly now: () => number = Date.now,
  ) {}

  changed(bytes: () => number): void {
    if (this.timer) return;
    const wait = Math.max(0, this.at + STORAGE_REPORT_MS - this.now());
    this.timer = setTimeout(() => {
      this.timer = null;
      this.at = this.now();
      try {
        this.record(bytes()).catch((e) => console.error("storage not recorded", e));
      } catch (e) {
        console.error("storage not recorded", e);
      }
    }, wait);
  }
}
