import { DurableObject } from "cloudflare:workers";
import type { AccountFeeds } from "./account-feeds";
import { d1BlobRefs } from "./blobrefs";
import { type CallResult, callStore, type LibraryMethod, r2BlobStore } from "./client";
import {
  broadcast,
  broadcastPresence,
  type Caller,
  FEED_FULL,
  FEED_SOCKETS_PER_LIBRARY,
  type FeedMessage,
  type FeedSocket,
  feedEvent,
  feedPrefix,
  isPersonActor,
  Presence,
  type PresenceMessage,
  readingOf,
  WRITE_METHODS,
} from "./feed";
import { ensureHealthRow, reportHealth } from "./library-health";
import { DEFAULT_STORAGE_MB } from "./limits";
import {
  DEFAULT_RETENTION_DAYS,
  type MaintenanceResult,
  MaintenanceSchedule,
  runMaintenance,
} from "./maintain";
import { recordStorage, StorageReport } from "./quota";
import { prepareRestore, type RestoreOutcome, type RestoreTarget } from "./recovery";
import {
  addCost,
  doSqlHandle,
  FTS_TABLES,
  READ_FLUSH_TABLES,
  type RowCost,
  RowTally,
  rowsTo,
} from "./store/sql";
import { LibraryStore } from "./store/store";
import { callLine, worthLogging } from "./timing";
import { usagePoint } from "./usage";

/** How long reads counted in memory wait before they are written to `access_log`. */
const READ_FLUSH_MS = 5000;

/** One library: its blobs, ledger and derived indexes in the object's SQLite. */
export class Library extends DurableObject<Env> {
  private opened: LibraryStore | null = null;
  private alarmChecked = false;
  /** Writes the reads counted in memory a few seconds after the first of them (TEMPRA-87). */
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  /** The library's storage in D1, for the account's quota across libraries (TEMPRA-232). */
  private readonly storage = new StorageReport((bytes) =>
    recordStorage(this.env.DB, this.libraryId(), bytes),
  );
  private readonly schedule = new MaintenanceSchedule(
    {
      getAlarm: () => this.ctx.storage.getAlarm(),
      setAlarm: (at) => this.ctx.storage.setAlarm(at),
    },
    {
      maintenanceDue: (now) => this.store.maintenanceDue(now),
      setMaintenance: (v) => this.store.setMaintenance(v),
    },
    () => this.libraryId(),
  );
  /** Set once a restore is armed: the object refuses work until it restarts into the restore. */
  private restarting = false;
  /** When the object started, and how many calls it has served: the first is the cold one. */
  private readonly started = Date.now();
  private calls = 0;
  /** Agents' presence on the feed (TEMPRA-219): only its throttle, in memory. */
  private readonly presence = new Presence();
  /** Every statement's rows, so each call returns what it cost (TEMPRA-228). */
  private readonly rows = new RowTally();

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    // Keepalive pings are answered without waking a hibernated object.
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair("ping", "pong"));
  }

  /**
   * The store, opened on first use: a library that cannot be opened (stored in an older format)
   * can still be deleted.
   */
  private get store(): LibraryStore {
    this.opened ??= new LibraryStore(doSqlHandle(this.ctx.storage, this.rows), {
      size: () => this.ctx.storage.sql.databaseSize,
    });
    return this.opened;
  }

  /**
   * The single RPC entry point: runs a store method and returns its result or error as data.
   * `caller` is the agent making it, when it is one: its reads are presence on the feed
   * (TEMPRA-219).
   */
  async call(method: LibraryMethod, args: unknown[], caller?: Caller | null): Promise<CallResult> {
    if (this.restarting) return RESTARTING;
    // Where the time goes (TEMPRA-190): the first call after a start, and any slow one, is logged.
    const t0 = Date.now();
    const cold = this.calls++ === 0;
    if (!this.alarmChecked) await this.ensureAlarm();
    const t1 = Date.now();
    const result = await this.run(method, args, caller ?? null);
    // After the call, never inside a write's transaction; a failure here never fails the read.
    if (caller && result.ok) {
      try {
        this.sendPresence(caller, method, result.value);
      } catch (e) {
        console.error("presence not sent", e);
      }
    }
    const t2 = Date.now();
    if (worthLogging(cold, t2 - t0)) {
      try {
        const timing = {
          library: this.libraryId(),
          method,
          cold,
          sinceStartMs: t0 - this.started,
          alarmMs: t1 - t0,
          callMs: t2 - t1,
          totalMs: t2 - t0,
        };
        const size = { files: this.store.fileCount(), dbBytes: this.ctx.storage.sql.databaseSize };
        console.log(callLine(timing, size));
      } catch (e) {
        console.error("call timing not logged", e);
      }
    }
    return result;
  }

  /** Runs a store method for `call`: the write's feed and maintenance, the reads' counting. */
  private async run(
    method: LibraryMethod,
    args: unknown[],
    caller: Caller | null,
  ): Promise<CallResult> {
    const writes = WRITE_METHODS.has(method);
    const before = writes ? this.store.headSeq() : 0;
    const result = await callStore(this.store, r2BlobStore(this.env.BLOBS), method, args, {
      storageLimitBytes: this.storageLimitBytes(),
      references: (hashes) =>
        d1BlobRefs(this.env.DB).reference(this.libraryId(), hashes, new Date()),
      // Reads counted as their surface and reader kind (TEMPRA-220).
      reading: caller ? readingOf(caller) : null,
      rows: this.rows,
    });
    // The write has committed (the store's transaction is synchronous): tell the feed, and wake
    // the maintainers for the export it calls for. A failure here must not turn a committed
    // write into an error (a client would retry it).
    if (writes && result.ok) {
      const mark = this.rows.mark();
      try {
        this.publish(before);
      } catch (e) {
        console.error("feed publish failed", e);
      }
      // The feed's read of the new events is the write's cost too.
      if (result.cost) result.cost = addCost(result.cost, this.rows.since(mark));
      try {
        if (this.store.headSeq() > before) await this.schedule.wake();
      } catch (e) {
        console.error("maintenance alarm failed", e);
      }
      if (this.store.headSeq() > before) this.storage.changed(() => this.store.storageBytes());
    }
    if (this.store.pendingReads() > 0) this.flushSoon();
    return result;
  }

  /**
   * Reads are counted in memory (TEMPRA-87); a timer in the object writes them a few seconds
   * after the first, one transaction for however many came in. A write or the 100th read writes
   * them sooner. No storage call schedules it, and the timer keeps the object awake until then.
   */
  private flushSoon() {
    if (this.flushTimer) return;
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      if (this.restarting) return;
      try {
        const { cost } = this.rows.measure(() => this.store.flushReads());
        this.meterFlush(cost);
      } catch (e) {
        console.error("read counts not written", e);
      }
    }, READ_FLUSH_MS);
  }

  /**
   * The timer's flush belongs to no request, so the object meters it itself, as `read_flush`
   * under the library (TEMPRA-228); a flush a write makes first is in that write's cost.
   */
  private meterFlush(cost: RowCost) {
    try {
      this.env.USAGE?.writeDataPoint(
        usagePoint({
          kind: "cost",
          account: "",
          library: this.libraryId(),
          op: "read_flush",
          cost: {
            calls: 1,
            rowsRead: cost.rowsRead,
            rowsWritten: cost.rowsWritten,
            ftsRowsWritten: rowsTo(cost, FTS_TABLES),
            readFlushRowsWritten: rowsTo(cost, READ_FLUSH_TABLES),
            ms: 0,
          },
        }),
      );
    } catch {}
  }

  // ---------------------------------------------------------------- the change feed

  /**
   * The feed's WebSocket (tempra-dev: app/live). The Worker has already authorized the caller,
   * counted the connection and leased it a place under the account's cap; this accepts the
   * socket with the hibernation API, so an idle library costs nothing while browsers stay
   * connected, and says where the ledger stands. Past the library's cap, counted from
   * `getWebSockets()` (which survives hibernation), the socket is refused (TEMPRA-80).
   */
  override async fetch(request: Request): Promise<Response> {
    if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
      return new Response("Expected a WebSocket.", { status: 426 });
    }
    if (this.restarting) return new Response("Restarting.", { status: 503 });
    if (this.ctx.getWebSockets().length >= FEED_SOCKETS_PER_LIBRARY) {
      return refuseFeed("This library has too many live connections; polling instead.");
    }
    const params = new URL(request.url).searchParams;
    const pair = new WebSocketPair();
    const [client, server] = [pair[0], pair[1]];
    this.ctx.acceptWebSocket(server);
    server.serializeAttachment({
      prefix: feedPrefix(params.get("prefix")),
      opened: Date.now(),
      lease: params.get("lease"),
      account: params.get("account"),
    });
    const hello: FeedMessage = { type: "hello", head: this.store.headSeq() };
    server.send(JSON.stringify(hello));
    return new Response(null, { status: 101, webSocket: client });
  }

  /** Sends the events after `before` to every open feed socket. */
  private publish(before: number) {
    const sockets = this.ctx.getWebSockets();
    if (sockets.length === 0) return;
    const head = this.store.headSeq();
    if (head <= before) return;
    const { events } = this.store.events({ since: before, limit: 1000 });
    broadcast(this.feedSockets(sockets), head, events.map(feedEvent));
  }

  /**
   * An agent's read, as presence to every open feed socket (TEMPRA-219): throttled in memory per
   * agent and file, filtered by each socket's prefix, never stored. A search sends none.
   */
  private sendPresence(caller: Caller, method: LibraryMethod, value: unknown) {
    const sockets = this.ctx.getWebSockets();
    if (sockets.length === 0) return;
    const message = this.presence.message(caller, method, value);
    if (message) broadcastPresence(this.feedSockets(sockets), message);
  }

  /** The feed's view of the object's sockets: each one's prefix and age, from its attachment. */
  private feedSockets(sockets: WebSocket[]): FeedSocket[] {
    return sockets.map((ws) => {
      const a = ws.deserializeAttachment() as { prefix?: string; opened?: number } | null;
      return {
        prefix: a?.prefix ?? "",
        // Sockets from before `opened` was recorded count as old: they reconnect once.
        opened: a?.opened ?? 0,
        send: (m) => ws.send(m),
        close: (code, reason) => ws.close(code, reason),
      };
    });
  }

  /** The account leases of the open feed sockets, for the per-account cap (feed-leases.ts). */
  async feedLeases(): Promise<string[]> {
    return this.ctx.getWebSockets().flatMap((ws) => {
      const a = ws.deserializeAttachment() as { lease?: string | null } | null;
      return a?.lease ? [a.lease] : [];
    });
  }

  /** The feed is one-way; anything a client sends (other than ping) is ignored. */
  override async webSocketMessage(): Promise<void> {}

  override async webSocketClose(ws: WebSocket, code: number): Promise<void> {
    try {
      ws.close(code === 1005 ? 1000 : code, "closed");
    } catch {
      // Already closed.
    }
    this.releaseLease(ws);
  }

  override async webSocketError(ws: WebSocket): Promise<void> {
    this.releaseLease(ws);
  }

  /**
   * Gives a closed socket's place under its account's cap back at once (feed-leases.ts), so a
   * page reloaded again and again never counts its old sockets. Off the close's path; a release
   * that fails is caught up by the account's check at the cap.
   */
  private releaseLease(ws: WebSocket) {
    const a = ws.deserializeAttachment() as { lease?: string | null; account?: string | null };
    if (!a?.lease || !a.account) return;
    const ns = this.env.ACCOUNT_FEEDS as DurableObjectNamespace<AccountFeeds>;
    this.ctx.waitUntil(
      ns
        .get(ns.idFromName(a.account))
        .release(a.lease)
        .catch(() => {}),
    );
  }

  /** For a blob sweep recount (TEMPRA-81): every attachment hash this library references. */
  async blobRefs(): Promise<string[]> {
    if (this.restarting) throw new Error("The library is restarting.");
    return this.store.blobHashes();
  }

  /**
   * The managed agent is working on a reply (TEMPRA-222): a `replying` presence message to every
   * open feed socket, by its prefix; nothing is stored.
   */
  async announce(message: PresenceMessage): Promise<number> {
    // The managed agent's: "replying" on a thread, and "reading" for the pages a turn works from
    // (the thread's page it is given, the pages it cites; TEMPRA-224). Never a person's.
    if (message.type !== "presence" || isPersonActor(message.actor)) return 0;
    const sockets = this.ctx.getWebSockets();
    if (sockets.length === 0) return 0;
    return broadcastPresence(this.feedSockets(sockets), message);
  }

  /** For /healthz: proves the namespace answers without touching any library's state. */
  async ping(): Promise<string> {
    return "ok";
  }

  /**
   * The maintainers run from one alarm (spec: Tier 3), set on the library's first use for its
   * next slot, then for the earliest slot with work (TEMPRA-82).
   */
  private async ensureAlarm() {
    this.alarmChecked = true;
    // The object's name is its library id; alarms may not see it, so keep a copy.
    const name = this.ctx.id.name;
    if (name && this.store.maintenance().library_id !== name) {
      this.store.setMaintenance({ library_id: name });
    }
    await this.schedule.ensure();
    // Once per library: a health row with its next pass, so an alarm that never fires is found
    // (TEMPRA-92). Off the call's path; the first pass writes it in full anyway.
    if (!this.store.maintenance().health_row) {
      const next = this.store.maintenance().next_run ?? null;
      this.ctx.waitUntil(
        ensureHealthRow(this.env.DB, this.libraryId(), next, new Date())
          .then(() => this.store.setMaintenance({ health_row: "1" }))
          .catch((e) => console.error(JSON.stringify({ health_row: String(e) }))),
      );
    }
  }

  /** The storage cap per library, from the deployment's LIBRARY_STORAGE_MB. */
  private storageLimitBytes(): number {
    return (Number(this.env.LIBRARY_STORAGE_MB) || DEFAULT_STORAGE_MB) * 1048576;
  }

  /**
   * After a pass: the library's health row in D1 (TEMPRA-92), written only when it changed, and
   * its storage for the account's quota (TEMPRA-232). Never throws: a row not written is caught
   * by the digest as an overdue pass.
   */
  private async reportHealth(failure: string | null) {
    try {
      await reportHealth(this.env.DB, this.libraryId(), this.store, {
        limitBytes: this.storageLimitBytes(),
        failure,
        now: new Date(),
      });
      if (!this.store.maintenance().health_row) this.store.setMaintenance({ health_row: "1" });
    } catch (e) {
      console.error(JSON.stringify({ health_row: this.libraryId(), error: String(e) }));
    }
  }

  private libraryId(): string {
    return this.store.maintenance().library_id ?? this.ctx.id.name ?? this.ctx.id.toString();
  }

  /**
   * Runs the maintainers now ("Export now" in the UI), then reports the library's health; the
   * alarm keeps its schedule.
   */
  async maintain(): Promise<MaintenanceResult> {
    let failure: string | null = null;
    try {
      return await this.pass();
    } catch (e) {
      failure = e instanceof Error ? e.message : String(e);
      throw e;
    } finally {
      if (!this.restarting) await this.reportHealth(failure);
    }
  }

  /** One maintenance pass (maintain.ts runMaintenance). */
  private async pass(): Promise<MaintenanceResult> {
    if (this.restarting) throw new Error("The library is restarting after a restore.");
    if (!this.alarmChecked) await this.ensureAlarm();
    return runMaintenance({
      store: this.store,
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
    let failure: string | null = null;
    try {
      const result = await this.pass();
      console.log(JSON.stringify({ maintenance: this.libraryId(), ...result }));
    } catch (e) {
      // Logged, not rethrown: the next slot exports whatever this one missed. Its health row
      // tells the operator.
      failure = e instanceof Error ? e.message : String(e);
      console.error(JSON.stringify({ maintenance: this.libraryId(), error: String(e) }));
    }
    try {
      await this.schedule.afterPass();
    } finally {
      // After the next pass is set, so the row carries when it is due (TEMPRA-92).
      if (!this.restarting) await this.reportHealth(failure);
    }
  }
}

/**
 * A feed connection refused over a cap: opened and closed at once with FEED_FULL, which a
 * browser can read (it cannot read an HTTP refusal of a WebSocket). Not hibernatable, so it is
 * never counted among the library's sockets.
 */
export function refuseFeed(reason: string): Response {
  const pair = new WebSocketPair();
  const [client, server] = [pair[0], pair[1]];
  server.accept();
  server.close(FEED_FULL, reason);
  return new Response(null, { status: 101, webSocket: client });
}

const RESTARTING = {
  ok: false,
  status: 503,
  code: "restarting",
  message: "The library is restarting after a point-in-time restore; try again in a moment.",
  extra: {},
} satisfies CallResult;
