/**
 * The last 30 days from the app's metering (TEMPRA-278): Analytics Engine's SQL API over the
 * deployment's dataset (worker/src/usage.ts: one point per request an agent's token or app makes,
 * and per write, with the account as blob2). Each day: how many accounts had agents at work, their
 * requests and their writes. People's own browsing is not metered there; the page's D1 numbers
 * count people. Needs ANALYTICS_TOKEN (Account Analytics Read). Free of Worker APIs.
 */

export interface Day {
  /** YYYY-MM-DD (UTC). */
  day: string;
  /** Accounts whose agents made at least one request. */
  accounts: number;
  requests: number;
  writes: number;
}

export const DAYS = 30;

/** The query: one row per day, kind and account (counting distinct accounts here, not in SQL). */
export function dailySql(dataset: string): string {
  if (!/^[a-z0-9_]+$/.test(dataset)) throw new Error(`Not a dataset name: ${dataset}`);
  return `SELECT toStartOfDay(timestamp) AS day, blob1 AS kind, blob2 AS account, SUM(_sample_interval) AS n
FROM ${dataset}
WHERE timestamp > NOW() - INTERVAL '${DAYS}' DAY AND blob1 IN ('request', 'write')
GROUP BY day, kind, account`;
}

interface Row {
  day: string;
  kind: string;
  account: string;
  n: number | string;
}

/** The days, oldest first, every one of the last 30 there (zeros where nothing happened). */
export function dailyFrom(rows: Row[], now = new Date()): Day[] {
  const days = new Map<string, { accounts: Set<string>; requests: number; writes: number }>();
  const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  for (let i = DAYS - 1; i >= 0; i--) {
    const key = new Date(today - i * 86_400_000).toISOString().slice(0, 10);
    days.set(key, { accounts: new Set(), requests: 0, writes: 0 });
  }
  for (const r of rows) {
    const d = days.get(String(r.day).slice(0, 10));
    if (!d) continue;
    const n = Number(r.n) || 0;
    if (r.kind === "request") {
      d.requests += n;
      if (r.account) d.accounts.add(r.account);
    } else if (r.kind === "write") {
      d.writes += n;
    }
  }
  return [...days].map(([day, d]) => ({
    day,
    accounts: d.accounts.size,
    requests: Math.round(d.requests),
    writes: Math.round(d.writes),
  }));
}

/** Asks the SQL API; null when there is no token, or it failed (logged). */
export async function dailyActivity(
  cfg: { accountId: string; token?: string; dataset: string },
  fetcher: typeof fetch = fetch,
  now = new Date(),
): Promise<Day[] | null> {
  if (!cfg.token || !cfg.accountId) return null;
  try {
    const r = await fetcher(
      `https://api.cloudflare.com/client/v4/accounts/${cfg.accountId}/analytics_engine/sql`,
      {
        method: "POST",
        headers: { Authorization: `Bearer ${cfg.token}` },
        body: dailySql(cfg.dataset),
      },
    );
    if (!r.ok) {
      console.error(
        JSON.stringify({ analytics_failed: r.status, body: (await r.text()).slice(0, 300) }),
      );
      return null;
    }
    const body = (await r.json()) as { data?: Row[] };
    return dailyFrom(body.data ?? [], now);
  } catch (e) {
    console.error(JSON.stringify({ analytics_failed: String(e) }));
    return null;
  }
}
