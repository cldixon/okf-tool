export type SqlValue = string | number | null | ArrayBuffer | Uint8Array;
export type Row = Record<string, SqlValue>;

/**
 * The plain SQLite handle the store is written against. The Library DO adapts
 * `ctx.storage.sql`; tests adapt `bun:sqlite`. Everything is synchronous so a write runs as one
 * transaction with no awaits inside it.
 */
export interface SqlHandle {
  /** Runs one statement and returns its rows. */
  all<T = Row>(query: string, ...params: SqlValue[]): T[];
  /** Runs one statement, ignoring rows. */
  run(query: string, ...params: SqlValue[]): void;
  /** Runs a script of several statements with no parameters (DDL). */
  script(sql: string): void;
  /** Runs `fn` in a transaction; a throw rolls everything back. */
  transaction<T>(fn: () => T): T;
}

/** Adapts a Durable Object's `ctx.storage` to SqlHandle. */
export function doSqlHandle(storage: DurableObjectStorage): SqlHandle {
  const sql = storage.sql;
  return {
    all: <T>(query: string, ...params: SqlValue[]) =>
      sql.exec(query, ...params).toArray() as unknown as T[],
    run: (query, ...params) => {
      sql.exec(query, ...params).toArray();
    },
    script: (s) => {
      sql.exec(s);
    },
    transaction: (fn) => storage.transactionSync(fn),
  };
}
