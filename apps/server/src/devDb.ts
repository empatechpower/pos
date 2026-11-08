/**
 * A real PostgreSQL for local development, with no install: the data lives in apps/server/data/pg and
 * survives restarts. Leave it running in its own terminal.   npm run dev:db
 */
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import EmbeddedPostgres from "embedded-postgres";

const dir = fileURLToPath(new URL("../data/pg", import.meta.url));
const port = Number(process.env.PGPORT ?? 54329);
const pg = new EmbeddedPostgres({ databaseDir: dir, user: "pos", password: "pos", port, persistent: true, onLog: () => {}, onError: (e) => console.error(String(e)) });

if (!existsSync(`${dir}/PG_VERSION`)) await pg.initialise();
await pg.start();
try {
  await pg.createDatabase("pos");
} catch {
  /* already exists */
}
console.log(`PostgreSQL is running.\nDATABASE_URL=postgres://pos:pos@localhost:${port}/pos\nPress Ctrl+C to stop (your data is kept).`);

const stop = async () => {
  await pg.stop();
  process.exit(0);
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
