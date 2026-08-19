import closeWithGrace from "close-with-grace";
import { buildApp } from "./app.js";
import { config } from "./config.js";
import { db } from "./db/kysely.js";
import { redis } from "./redis.js";
import { startSweeper } from "./sweeper.js";
import { startTripwire } from "./tripwire.js";

const app = buildApp();

const sweeper = startSweeper(db, config.sweeperIntervalMs, app.log);
const tripwire = startTripwire(db, config.tripwireIntervalMs, app.log);

app.listen({ port: config.port, host: "0.0.0.0" }).catch((err: unknown) => {
  app.log.error(err);
  process.exit(1);
});

// Ordered shutdown, each step waiting on the previous:
//   1. Flip readiness to failing FIRST -- the load balancer stops sending
//      new traffic while liveness (and therefore the process itself) stays
//      up, so nothing kills the pod mid-drain.
//   2. app.close() drains in-flight requests instead of dropping them.
//   3. Stop the sweeper's interval and await its in-flight tick, if any --
//      it's a second writer against the same database, and closing the pool
//      out from under a running UPDATE would be exactly the kind of bug this
//      whole exercise exists to avoid.
//   4. db.destroy() only after both of the above have stopped issuing
//      queries.
// close-with-grace supplies the SIGTERM/SIGINT listener and the hard-timeout
// fallback (delay below) so one stuck connection can't hang a deploy.
closeWithGrace({ delay: 10_000 }, async ({ err }) => {
  if (err) app.log.error(err, "closeWithGrace triggered by an unhandled error");

  app.isShuttingDown = true;
  await new Promise((resolve) => setTimeout(resolve, 250)); // let one more readiness poll observe the flip

  await app.close();
  await sweeper.stop();
  await tripwire.stop();
  await db.destroy();
  redis.disconnect();
});
