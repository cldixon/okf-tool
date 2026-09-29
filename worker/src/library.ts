import { DurableObject } from "cloudflare:workers";
import { type CallResult, callStore, type LibraryMethod, r2BlobStore } from "./client";
import { doSqlHandle } from "./store/sql";
import { LibraryStore } from "./store/store";

/** One OKF library: its blobs, ledger and derived indexes in the object's SQLite. */
export class Library extends DurableObject<Env> {
  private readonly store: LibraryStore;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.store = new LibraryStore(doSqlHandle(ctx.storage));
  }

  /** The single RPC entry point: runs a store method and returns its result or error as data. */
  async call(method: LibraryMethod, args: unknown[]): Promise<CallResult> {
    return callStore(this.store, r2BlobStore(this.env.BLOBS), method, args);
  }
}
