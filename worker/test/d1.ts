import { Database, type SQLQueryBindings } from "bun:sqlite";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Enough of D1 over bun:sqlite for the account layer, with the real migrations applied, so tests
 * run the same SQL production does.
 */
export function bunD1(): { d1: D1Database; db: Database } {
  const db = new Database(":memory:");
  db.run("PRAGMA foreign_keys = ON");
  const dir = join(import.meta.dir, "../migrations");
  for (const file of readdirSync(dir)
    .filter((f) => f.endsWith(".sql"))
    .sort()) {
    // As D1 does: one migration is one transaction (its PRAGMA defer_foreign_keys needs that).
    const statements = readFileSync(join(dir, file), "utf8")
      .replace(/--.*$/gm, "")
      .split(";")
      .map((s) => s.trim())
      .filter(Boolean);
    db.transaction(() => {
      for (const s of statements) db.run(s);
    })();
  }

  const statement = (sql: string, params: unknown[] = []) => {
    const q = () => db.query(sql);
    const args = params as SQLQueryBindings[];
    const stmt = {
      bind: (...p: unknown[]) => statement(sql, p),
      async first<T>(col?: string) {
        const row = (q().get(...args) as Record<string, unknown> | null) ?? null;
        if (row && col) return row[col] as T;
        return row as T | null;
      },
      async all<T>() {
        return { results: q().all(...args) as T[], success: true, meta: {} };
      },
      async run() {
        const r = q().run(...args);
        return { results: [], success: true, meta: { changes: r.changes } };
      },
      async raw<T>() {
        return q().values(...args) as T[];
      },
      sync() {
        return q().run(...args);
      },
    };
    return stmt;
  };

  const d1 = {
    prepare: (sql: string) => statement(sql),
    async batch(stmts: ReturnType<typeof statement>[]) {
      return db.transaction(() =>
        stmts.map((s) => {
          s.sync();
          return { results: [], success: true, meta: {} };
        }),
      )();
    },
    async exec(sql: string) {
      db.run(sql);
      return { count: 1, duration: 0 };
    },
  };
  return { d1: d1 as unknown as D1Database, db };
}
