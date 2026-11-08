import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

export type Db = pg.Pool;

export const createPool = (connectionString: string): Db => new pg.Pool({ connectionString, max: 10 });

/** Runs every NNN_*.sql in this folder in order. Statements are written to be re-runnable. */
export async function migrate(db: Db): Promise<void> {
  const dir = dirname(fileURLToPath(import.meta.url));
  const files = readdirSync(dir).filter((f) => /^\d+_.*\.sql$/.test(f)).sort();
  for (const f of files) await db.query(readFileSync(join(dir, f), "utf8"));
}
