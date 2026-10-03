import { blobKey } from "./client";

/**
 * The daily sweep and operator digest (v2 spec: A3). Attachment bytes live in R2 by hash and are
 * shared across libraries, so deleting a library cannot delete them. Each day this asks every
 * library which hashes it references, records blobs nobody references in blob_orphans, and deletes
 * those unreferenced for GRACE_DAYS in a row: longer than the 30-day point-in-time window, so an
 * undone restore never finds an attachment gone. If any library fails to answer, nothing is
 * deleted that day. Free of Worker APIs.
 */

export const GRACE_DAYS = 31;
const DAY_MS = 86_400_000;

export interface Inventory {
  hashes: string[];
  bytes: number;
  stats: {
    seq: number;
    maintainers: { export: { lag: number; last_run: string | null } };
    next_run: string | null;
  };
}

export interface SweepDeps {
  /** Every library: its id (the Durable Object name) and path, for the digest. */
  libraries(): Promise<{ id: string; path: string }[]>;
  inventory(libraryId: string): Promise<Inventory>;
  bucket: {
    list(opts: { prefix: string; cursor?: string }): Promise<{
      objects: { key: string }[];
      truncated: boolean;
      cursor?: string;
    }>;
    delete(keys: string[]): Promise<void>;
  };
  /** blob_orphans in D1. */
  orphans: {
    all(): Promise<Map<string, string>>;
    mark(hashes: string[], since: string): Promise<void>;
    clear(hashes: string[]): Promise<void>;
  };
  storageLimitBytes: number;
  now: Date;
}

export interface SweepResult {
  libraries: number;
  stored: number;
  referenced: number;
  orphaned: number;
  deleted: number;
  /** Why nothing was deleted, when it was not. */
  skipped?: string;
  /** Things the operator should look at. */
  attention: string[];
}

export async function sweep(d: SweepDeps): Promise<SweepResult> {
  const libs = await d.libraries();
  const referenced = new Set<string>();
  const attention: string[] = [];
  let failed = 0;
  for (const lib of libs) {
    let inv: Inventory;
    try {
      inv = await d.inventory(lib.id);
    } catch (e) {
      failed++;
      attention.push(`${lib.path}: did not answer (${e instanceof Error ? e.message : String(e)})`);
      continue;
    }
    for (const h of inv.hashes) referenced.add(h);
    attention.push(...libraryProblems(lib.path, inv, d.storageLimitBytes, d.now));
  }

  const stored: string[] = [];
  let cursor: string | undefined;
  do {
    const page = await d.bucket.list({ prefix: "blobs/", cursor });
    for (const o of page.objects) stored.push(o.key.slice("blobs/".length));
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);

  const result: SweepResult = {
    libraries: libs.length,
    stored: stored.length,
    referenced: referenced.size,
    orphaned: 0,
    deleted: 0,
    attention,
  };
  if (failed > 0) {
    result.skipped = `${failed} of ${libs.length} libraries did not answer`;
    attention.push(`Blob sweep skipped: ${result.skipped}.`);
    return result;
  }

  const known = await d.orphans.all();
  const storedSet = new Set(stored);
  const unreferenced = stored.filter((h) => !referenced.has(h));
  // Referenced again (an undo, a re-upload), or already gone from R2.
  const back = [...known.keys()].filter((h) => referenced.has(h) || !storedSet.has(h));
  if (back.length) await d.orphans.clear(back);
  const fresh = unreferenced.filter((h) => !known.has(h));
  if (fresh.length) await d.orphans.mark(fresh, d.now.toISOString());
  const cutoff = d.now.getTime() - GRACE_DAYS * DAY_MS;
  const expired = unreferenced.filter((h) => {
    const since = known.get(h);
    return since !== undefined && Date.parse(since) <= cutoff;
  });
  for (let i = 0; i < expired.length; i += 1000) {
    await d.bucket.delete(expired.slice(i, i + 1000).map(blobKey));
  }
  if (expired.length) await d.orphans.clear(expired);
  result.orphaned = unreferenced.length - expired.length;
  result.deleted = expired.length;
  return result;
}

/** A library's export falling behind, its daily alarm not running, or its storage nearly full. */
export function libraryProblems(
  path: string,
  inv: Inventory,
  limitBytes: number,
  now: Date,
): string[] {
  const out: string[] = [];
  const exp = inv.stats.maintainers.export;
  const twoDays = now.getTime() - 2 * DAY_MS;
  if (exp.lag > 0 && exp.last_run && Date.parse(exp.last_run) < twoDays) {
    out.push(`${path}: last export ${exp.last_run}, ${exp.lag} events behind`);
  }
  if (inv.stats.next_run && Date.parse(inv.stats.next_run) < now.getTime() - DAY_MS) {
    out.push(`${path}: daily maintenance overdue since ${inv.stats.next_run}`);
  }
  if (inv.bytes >= 0.8 * limitBytes) {
    out.push(
      `${path}: ${Math.round(inv.bytes / 1048576)} MB of ${Math.round(limitBytes / 1048576)} MB`,
    );
  }
  return out;
}

export function digestText(r: SweepResult): string {
  return [
    "OKF daily digest",
    "",
    ...r.attention.map((a) => `- ${a}`),
    "",
    `Libraries ${r.libraries}. Blobs stored ${r.stored}, referenced ${r.referenced}, waiting ${r.orphaned}, deleted ${r.deleted}.`,
    "",
  ].join("\n");
}

/** blob_orphans in D1. */
export function d1Orphans(db: D1Database): SweepDeps["orphans"] {
  return {
    async all() {
      const r = await db.prepare("SELECT hash, since FROM blob_orphans").all<{
        hash: string;
        since: string;
      }>();
      return new Map(r.results.map((o) => [o.hash, o.since]));
    },
    async mark(hashes, since) {
      for (let i = 0; i < hashes.length; i += 50) {
        await db.batch(
          hashes
            .slice(i, i + 50)
            .map((h) =>
              db
                .prepare("INSERT OR IGNORE INTO blob_orphans (hash, since) VALUES (?, ?)")
                .bind(h, since),
            ),
        );
      }
    },
    async clear(hashes) {
      for (let i = 0; i < hashes.length; i += 50) {
        await db.batch(
          hashes
            .slice(i, i + 50)
            .map((h) => db.prepare("DELETE FROM blob_orphans WHERE hash = ?").bind(h)),
        );
      }
    },
  };
}
