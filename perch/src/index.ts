import { assertConfig, config } from "./config.js";
import { buildServer } from "./server.js";
import { startScheduler } from "./scheduler.js";
import { registerHerald, startHeralds, stopHeralds } from "./herald.js";
import { telegramHerald } from "./herald-telegram.js";
import { imessageHerald } from "./herald-imessage.js";
import { reconcileTurns, drainAllQueues } from "./turns.js";
import { logger } from "./log.js";
import { limitPerMinute, sweep } from "./ratelimit.js";

assertConfig();

// Reconcile first: crash-orphaned turns are closed out before anything can
// fire new ones (herald or scheduler), so no thread starts busy.
const stuck = reconcileTurns();
if (stuck > 0) logger.warn("reconciled orphaned in-progress turns", { count: stuck });
drainAllQueues().catch((err) => logger.warn("queue drain failed", { error: err }));

const app = buildServer();
app.listen({ port: config.port, host: "127.0.0.1" }).then((addr) => {
  logger.info("perch listening", { addr, data_dir: config.dataDir, rate_limit_per_min: limitPerMinute() });
});

// Keep the rate-limit bucket map from growing without bound.
const sweepTimer = setInterval(() => sweep(), 5 * 60_000);
sweepTimer.unref();

// Heralds are started from config; each is opt-in and independent.
if (config.telegramToken) {
  registerHerald(telegramHerald(config.telegramToken));
  logger.info("herald-telegram registered", { transport: "long-polling" });
} else {
  logger.info("herald-telegram disabled", { reason: "TELEGRAM_BOT_TOKEN unset" });
}
if (config.imessage && config.imessageBuddies) {
  registerHerald(imessageHerald(config.imessageBuddies));
} else if (config.imessage) {
  logger.info("herald-imessage disabled", { reason: "PERCH_IMESSAGE_BUDDY empty" });
}
startHeralds();
const started = config.telegramToken ? ["telegram"] : [];
if (config.imessage && config.imessageBuddies) started.push("imessage");
if (started.length) logger.info("heralds started", { heralds: started });

startScheduler();
logger.info("scheduler armed");
if (config.nightFlight) logger.info("night flight armed", { at: "03:00 local" });

for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, () => {
    logger.info("shutting down", { signal: sig });
    stopHeralds();
    app.close().then(() => process.exit(0));
  });
}
