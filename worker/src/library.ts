import { DurableObject } from "cloudflare:workers";
import { type CallResult, callStore, type LibraryMethod, r2BlobStore } from "./client";
import {
  DEFAULT_RETENTION_DAYS,
  type MaintenanceResult,
  nextRun,
  runMaintenance,
} from "./maintain";
import { doSqlHandle } from "./store/sql";
import { LibraryStore } from "./store/store";

/** One OKF library: its blobs, ledger and derived indexes in the object's SQLite. */
export class Library extends DurableObject<Env> {
  private readonly store: LibraryStore;
  private alarmChecked = false;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.store = new LibraryStore(doSqlHandle(ctx.storage), {
      size: () => ctx.storage.sql.databaseSize,
    });
  }

  /** The single RPC entry point: runs a store method and returns its result or error as data. */
  async call(method: LibraryMethod, args: unknown[]): Promise<CallResult> {
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

  override async alarm() {
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
