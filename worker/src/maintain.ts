import { type BlobStore, bundleTar } from "./client";

/**
 * The daily maintainers (spec: Tier 3): the nightly export to R2 and the usage rollup. Free of
 * Worker APIs, so the Library Durable Object's alarm and bun tests run the same code.
 */

/** The part of an R2 bucket the export maintainer uses. */
export interface ExportBucket {
  put(
    key: string,
    body: Uint8Array | string,
    opts?: { httpMetadata?: { contentType?: string } },
  ): Promise<unknown>;
  list(opts: { prefix: string; delimiter?: string; cursor?: string }): Promise<{
    objects: { key: string }[];
    delimitedPrefixes: string[];
    truncated: boolean;
    cursor?: string;
  }>;
  delete(keys: string | string[]): Promise<unknown>;
}

/** The store methods the maintainers call; the Library DO passes its LibraryStore. */
export interface MaintainedStore {
  headSeq(): number;
  exportBundle(at?: number): unknown;
  dump(): string;
  pruneUsage(): number;
  maintenance(): Record<string, string>;
  setMaintenance(values: Record<string, string>): void;
}

export interface MaintenanceResult {
  export: { key: string; seq: number; files: number } | { skipped: "unchanged" };
  deleted: string[];
  pruned: number;
}

export const DEFAULT_RETENTION_DAYS = 30;

export const exportsPrefix = (libraryId: string) => `exports/${libraryId}/`;

const day = (d: Date) => d.toISOString().slice(0, 10);

/** Runs every daily maintainer once. Idempotent: running it twice in a row exports once. */
export async function runMaintenance(opts: {
  store: MaintainedStore;
  blobs: BlobStore;
  bucket: ExportBucket;
  libraryId: string;
  now: Date;
  retentionDays?: number;
}): Promise<MaintenanceResult> {
  const { store, bucket, now } = opts;
  const stamp = now.toISOString().replace(/\.\d{3}Z$/, "Z");
  const state = store.maintenance();
  const seq = store.headSeq();

  // Export: only when the ledger moved since the last one (its cursor).
  let exported: MaintenanceResult["export"] = { skipped: "unchanged" };
  if (seq > 0 && seq !== Number(state.export_seq ?? -1)) {
    const folder = `${exportsPrefix(opts.libraryId)}${day(now)}/`;
    const tar = await bundleTar(store, opts.blobs, seq);
    await bucket.put(`${folder}bundle.tar`, tar.bytes, {
      httpMetadata: { contentType: "application/x-tar" },
    });
    await bucket.put(`${folder}ledger.jsonl`, store.dump(), {
      httpMetadata: { contentType: "application/x-ndjson" },
    });
    const manifest = { library_id: opts.libraryId, seq, created: stamp, files: tar.files };
    await bucket.put(`${folder}manifest.json`, JSON.stringify(manifest, null, 2), {
      httpMetadata: { contentType: "application/json" },
    });
    store.setMaintenance({ export_seq: String(seq), export_at: stamp, export_key: folder });
    exported = { key: folder, seq, files: tar.files };
  }

  const deleted = await pruneExports(
    bucket,
    opts.libraryId,
    now,
    opts.retentionDays ?? DEFAULT_RETENTION_DAYS,
  );
  const pruned = store.pruneUsage();
  store.setMaintenance({ usage_at: stamp });
  return { export: exported, deleted, pruned };
}

/** Export folders for a library, oldest first. */
export async function listExports(bucket: ExportBucket, libraryId: string): Promise<string[]> {
  const prefix = exportsPrefix(libraryId);
  const folders: string[] = [];
  let cursor: string | undefined;
  do {
    const page = await bucket.list({ prefix, delimiter: "/", cursor });
    folders.push(...page.delimitedPrefixes);
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
  return folders.sort();
}

/** Deletes export folders older than the retention window; the newest one is always kept. */
async function pruneExports(
  bucket: ExportBucket,
  libraryId: string,
  now: Date,
  retentionDays: number,
): Promise<string[]> {
  const folders = await listExports(bucket, libraryId);
  const cutoff = day(new Date(now.getTime() - retentionDays * 86_400_000));
  const prefix = exportsPrefix(libraryId);
  const old = folders
    .slice(0, -1)
    .filter((f) => f.slice(prefix.length, prefix.length + 10) < cutoff);
  for (const folder of old) {
    const page = await bucket.list({ prefix: folder });
    const keys = page.objects.map((o) => o.key);
    if (keys.length) await bucket.delete(keys);
  }
  return old;
}

/** The next daily run: 03:00 UTC plus a few minutes per library, strictly after `now`. */
export function nextRun(now: Date, libraryId: string): Date {
  let spread = 0;
  for (const ch of libraryId) spread = (spread * 31 + ch.charCodeAt(0)) % 60;
  const next = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 3, spread),
  );
  if (next.getTime() <= now.getTime()) next.setUTCDate(next.getUTCDate() + 1);
  return next;
}
