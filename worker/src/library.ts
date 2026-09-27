import { DurableObject } from "cloudflare:workers";

/** One OKF library: its blobs, ledger and derived indexes in the object's SQLite. */
export class Library extends DurableObject<Env> {}
