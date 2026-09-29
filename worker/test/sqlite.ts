import { Database } from "bun:sqlite";
import type { SqlHandle, SqlValue } from "../src/store/sql";

/** bun:sqlite standing in for the Durable Object's SQLite handle. */
export function bunSqlHandle(db = new Database(":memory:")): SqlHandle {
  const bind = (params: SqlValue[]) => params as (string | number | null | Uint8Array)[];
  return {
    all: <T>(query: string, ...params: SqlValue[]) => db.query(query).all(...bind(params)) as T[],
    run: (query, ...params) => {
      db.query(query).run(...bind(params));
    },
    script: (sql) => {
      db.run(sql);
    },
    transaction: (fn) => db.transaction(fn)(),
  };
}
