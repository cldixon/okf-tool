import { DurableObject } from "cloudflare:workers";
import { type CallResult, callStore, type LibraryMethod, r2BlobStore } from "./client";
import {
  DEFAULT_RETENTION_DAYS,
  type MaintenanceResult,
  nextRun,
  runMaintenance,
} from "./maintain";
import { prepareRestore, type RestoreOutcome, type RestoreTarget } from "./recovery";
import { doSqlHandle } from "./store/sql";
import { LibraryStore } from "./store/store";

/** One OKF library: its blobs, ledger and derived indexes in the object's SQLite. */
export class Library extends DurableObject<Env> {
  private readonly store: LibraryStore;
  private alarmChecked = false;
  /** Set once a restore is armed: the object refuses work until it restarts into the restore. */
  private restarting = false;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.store = new LibraryStore(doSqlHandle(ctx.storage), {
      size: () => ctx.storage.sql.databaseSize,
    });
  }

  /** The single RPC entry point: runs a store method and returns its result or error as data. */
  async call(method: LibraryMethod, args: unknown[]): Promise<CallResult> {
    if (this.restarting) return RESTARTING;
    if (!this.alarmChecked) await this.ensureAlarm();
    return callStore(this.store, r2BlobStore(this.env.BLOBS), method, args);
  }

  /** For /healthz: proves the namespace answers without touching any library's state. */
  async ping(): Promise<string> {
    return "ok";
  }

  /** The daily maintainers run from one alarm (spec: Tier 3), set on the library's first use. */
  private async ensureAlarm() {
    this.alarmChecked = true;
    // The object's name is its library id; alarms may not see it, so keep a copy.
    const name = this.ctx.id.name;
    if (name && this.store.maintenance().library_id !== name) {
      this.store.setMaintenance({ library_id: name });
    }
    if ((await this.ctx.storage.getAlarm()) === null) await this.schedule();
  }

  private async schedule() {
    const at = nextRun(new Date(), this.libraryId());
    await this.ctx.storage.setAlarm(at);
    this.store.setMaintenance({ next_run: at.toISOString().replace(/\.\d{3}Z$/, "Z") });
  }

  private libraryId(): string {
    return this.store.maintenance().library_id ?? this.ctx.id.name ?? this.ctx.id.toString();
  }

  /** Runs the daily maintainers now ("Export now" in the UI); the alarm keeps its schedule. */
  async maintain(): Promise<MaintenanceResult> {
    if (this.restarting) throw new Error("The library is restarting after a restore.");
    if (!this.alarmChecked) await this.ensureAlarm();
    return runMaintenance({
      store: this.store,
      blobs: r2BlobStore(this.env.BLOBS),
      bucket: this.env.BLOBS,
      libraryId: this.libraryId(),
      now: new Date(),
      retentionDays: Number(this.env.EXPORT_RETENTION_DAYS) || DEFAULT_RETENTION_DAYS,
    });
  }

  /**
   * Arms a point-in-time restore (spec: Backups and recovery). Nothing else runs while it
   * prepares, so the pre-restore export holds every write the restore discards. The caller then
   * calls restart(), and the next request sees the restored library.
   */
  async prepareRestore(target: RestoreTarget, actor: string): Promise<RestoreOutcome> {
    if (this.restarting) return RESTARTING;
    return this.ctx.blockConcurrencyWhile(async () => {
      const outcome = await prepareRestore({
        store: this.store,
        blobs: r2BlobStore(this.env.BLOBS),
        bucket: this.env.BLOBS,
        recovery: {
          bookmarkForTime: (t) => this.ctx.storage.getBookmarkForTime(t),
          currentBookmark: () => this.ctx.storage.getCurrentBookmark(),
          restoreOnNextSession: (b) => this.ctx.storage.onNextSessionRestoreBookmark(b),
        },
        libraryId: this.libraryId(),
        target,
        actor,
        now: new Date(),
      });
      if (outcome.ok) this.restarting = true;
      return outcome;
    });
  }

  /**
   * Deletes everything this library stores (v2 spec: A2, delete a library or account). The
   * caller has already removed its D1 row, so nothing routes here again; the restart drops this
   * instance, so the call itself fails, as restart() does.
   */
  async destroy(): Promise<void> {
    this.restarting = true;
    await this.ctx.storage.deleteAlarm();
    await this.ctx.storage.deleteAll();
    this.ctx.abort("Library deleted.");
  }

  /** Restarts the object so an armed restore takes effect; the call itself always fails. */
  async restart(): Promise<void> {
    this.ctx.abort("Restarting into a point-in-time restore.");
  }

  override async alarm() {
    if (this.restarting) return;
    try {
      const result = await this.maintain();
      console.log(JSON.stringify({ maintenance: this.libraryId(), ...result }));
    } catch (e) {
      // Logged, not rethrown: tomorrow's run exports whatever this one missed.
      console.error(JSON.stringify({ maintenance: this.libraryId(), error: String(e) }));
    }
    await this.schedule();
  }
}

const RESTARTING = {
  ok: false,
  status: 503,
  code: "restarting",
  message: "The library is restarting after a point-in-time restore; try again in a moment.",
  extra: {},
} satisfies CallResult;
