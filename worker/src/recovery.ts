import type { BlobStore } from "./client";
import { type ExportBucket, exportsPrefix, type MaintainedStore, writeExport } from "./maintain";

/**
 * Point-in-time restore (spec: Backups and recovery): "restore this library to <time>". Durable
 * Object storage keeps about 30 days of history per object; a restore rewinds the whole library,
 * ledger included, so it first writes a pre-restore export to R2 and records itself there, since
 * the rewound ledger cannot. Free of Worker APIs: the Library DO passes its storage as `Recovery`.
 */

/** The storage calls a restore needs; the DO passes ctx.storage's PITR methods. */
export interface Recovery {
  /** A bookmark for a moment in the past; throws where the backend has no PITR (wrangler dev). */
  bookmarkForTime(t: Date): Promise<string>;
  /** The object's state now: with nothing else running, the bookmark that undoes a restore. */
  currentBookmark(): Promise<string>;
  /** Arms a restore for the object's next session. */
  restoreOnNextSession(bookmark: string): Promise<unknown>;
}

/** How far back Durable Object point-in-time recovery reaches. */
export const PITR_WINDOW_DAYS = 30;

export interface RestoreRecord {
  id: string;
  library_id: string;
  kind: "restore" | "undo";
  /** The moment restored to (for an undo, the moment the undone restore was requested). */
  to: string;
  requested_at: string;
  actor: string;
  /** The ledger head before the restore, as kept in the pre-restore export. */
  seq_before: number;
  /** The R2 folder holding the pre-restore export. */
  export: string;
  /** For an undo: the restore it undoes. */
  undoes?: string;
  bookmark: string;
  undo_bookmark: string;
}

export type RestoreTarget = { to: string } | { undo: RestoreRecord };

export type RestoreOutcome =
  | { ok: true; record: RestoreRecord }
  | { ok: false; status: number; code: string; message: string };

export const restoresPrefix = (libraryId: string) => `restores/${libraryId}/`;

const iso = (d: Date) => d.toISOString().replace(/\.\d{3}Z$/, "Z");

/** Checks a requested restore time: a real instant, in the past, inside the PITR window. */
export function checkRestoreTime(to: string, now: Date): Date | string {
  const t = new Date(to);
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/.test(to)) {
    return "Give the time as a full ISO 8601 datetime with an offset, such as 2026-09-30T18:00:00Z.";
  }
  if (Number.isNaN(t.getTime())) return "That is not a valid time.";
  if (t.getTime() >= now.getTime()) return "The time must be in the past.";
  if (t.getTime() < now.getTime() - PITR_WINDOW_DAYS * 86_400_000) {
    return `Point-in-time recovery reaches back ${PITR_WINDOW_DAYS} days; pick a later time.`;
  }
  return t;
}

/**
 * Prepares a restore: resolves the bookmark (failing before any side effect where PITR is not
 * available), writes the pre-restore export, arms the restore and records it in R2. The caller
 * must restart the object for the restore to take effect.
 */
export async function prepareRestore(opts: {
  store: MaintainedStore;
  blobs: BlobStore;
  bucket: ExportBucket;
  recovery: Recovery;
  libraryId: string;
  target: RestoreTarget;
  actor: string;
  now: Date;
}): Promise<RestoreOutcome> {
  const { now, target } = opts;
  let bookmark: string;
  let to: string;
  if ("to" in target) {
    const t = checkRestoreTime(target.to, now);
    if (typeof t === "string") return { ok: false, status: 400, code: "bad_time", message: t };
    to = iso(t);
    try {
      bookmark = await opts.recovery.bookmarkForTime(t);
    } catch (e) {
      return {
        ok: false,
        status: 501,
        code: "no_pitr",
        message: `Point-in-time recovery is not available here: ${e instanceof Error ? e.message : String(e)}`,
      };
    }
  } else {
    if (target.undo.library_id !== opts.libraryId) {
      return { ok: false, status: 404, code: "not_found", message: "No such restore." };
    }
    bookmark = target.undo.undo_bookmark;
    to = target.undo.requested_at;
  }

  const stamp = iso(now);
  // Millisecond ids, so a restore and a quick undo never share a record or an export folder.
  const ms = now.toISOString();
  const id = ms.replace(/[-:.]/g, "");
  const folder = `${exportsPrefix(opts.libraryId)}${ms.slice(0, 10)}-pre-restore-${ms.slice(11, 23).replace(/[:.]/g, "")}/`;
  const seqBefore = opts.store.headSeq();
  await writeExport({ ...opts, folder, stamp, kind: "pre-restore" });

  const record: RestoreRecord = {
    id,
    library_id: opts.libraryId,
    kind: "to" in target ? "restore" : "undo",
    to,
    requested_at: stamp,
    actor: opts.actor,
    seq_before: seqBefore,
    export: folder,
    ...("undo" in target ? { undoes: target.undo.id } : {}),
    bookmark,
    undo_bookmark: await opts.recovery.currentBookmark(),
  };
  // Recorded before it is armed, so an armed restore always has its record and its undo.
  const key = `${restoresPrefix(opts.libraryId)}${id}.json`;
  await opts.bucket.put(key, JSON.stringify(record, null, 2), {
    httpMetadata: { contentType: "application/json" },
  });
  try {
    await opts.recovery.restoreOnNextSession(bookmark);
  } catch (e) {
    await opts.bucket.delete(key);
    throw e;
  }
  return { ok: true, record };
}

/** Restore records are named by their request time to the millisecond, e.g. 20260930T180211042Z. */
export const RESTORE_ID = /^\d{8}T\d{9}Z$/;

/** A library's restores, newest first; `read` returns an R2 object's text or null. */
export async function listRestores(
  bucket: Pick<ExportBucket, "list">,
  read: (key: string) => Promise<string | null>,
  libraryId: string,
): Promise<RestoreRecord[]> {
  const prefix = restoresPrefix(libraryId);
  const keys: string[] = [];
  let cursor: string | undefined;
  do {
    const page = await bucket.list({ prefix, cursor });
    keys.push(...page.objects.map((o) => o.key));
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
  const records = await Promise.all(
    keys
      .sort()
      .reverse()
      .map(async (k) => {
        const text = await read(k);
        return text ? (JSON.parse(text) as RestoreRecord) : null;
      }),
  );
  return records.filter((r): r is RestoreRecord => r !== null);
}
