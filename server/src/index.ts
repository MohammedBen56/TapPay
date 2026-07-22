import { buildApp } from "./app.js";
import { config } from "./config.js";
import { db } from "./db/kysely.js";
import { startSweeper } from "./sweeper.js";

const app = buildApp();

startSweeper(db, config.sweeperIntervalMs);

app.listen({ port: config.port, host: "0.0.0.0" }).catch((err: unknown) => {
  app.log.error(err);
  process.exit(1);
});
