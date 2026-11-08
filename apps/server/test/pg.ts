import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { createServer } from "node:net";
import { join } from "node:path";
import EmbeddedPostgres from "embedded-postgres";
import { createPool, migrate, type Db } from "../src/db/pool.js";

/** A throwaway real Postgres for tests: own data dir, random port, removed afterwards. */
export async function startTestDb(): Promise<{ db: Db; stop: () => Promise<void> }> {
  const dir = mkdtempSync(join(tmpdir(), "pos-pg-"));
  const port = await freePort();
  const pgServer = new EmbeddedPostgres({ databaseDir: dir, user: "pos", password: "pos", port, persistent: false, onLog: () => {}, onError: () => {} });
  await pgServer.initialise();
  await pgServer.start();
  await pgServer.createDatabase("pos");
  const db = createPool(`postgres://pos:pos@localhost:${port}/pos`);
  await migrate(db);
  return {
    db,
    stop: async () => {
      await db.end();
      await pgServer.stop();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

/** Asks the OS for an unused port, so parallel test runs can never collide. */
const freePort = () =>
  new Promise<number>((resolve, reject) => {
    const srv = createServer();
    srv.once("error", reject);
    srv.listen(0, () => {
      const { port } = srv.address() as { port: number };
      srv.close(() => resolve(port));
    });
  });
