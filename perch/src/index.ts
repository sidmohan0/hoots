import { assertConfig, config } from "./config.js";
import { buildServer } from "./server.js";
import { startScheduler } from "./scheduler.js";
import { startTelegramHerald } from "./herald-telegram.js";
import { reconcileTurns, drainAllQueues } from "./turns.js";

assertConfig();

// Reconcile first: crash-orphaned turns are closed out before anything can
// fire new ones (herald or scheduler), so no thread starts busy.
const stuck = reconcileTurns();
if (stuck > 0) console.log(`[perch] reconciled ${stuck} orphaned in-progress turn(s)`);
drainAllQueues().catch(() => {});

const app = buildServer();
app.listen({ port: config.port, host: "127.0.0.1" }).then((addr) => {
  console.log(`[perch] listening on ${addr}`);
});

let stopHerald: (() => void) | null = null;
if (config.telegramToken) {
  stopHerald = startTelegramHerald(config.telegramToken);
  console.log("[perch] herald-telegram started (long polling)");
} else {
  console.log("[perch] TELEGRAM_BOT_TOKEN not set — herald disabled");
}

startScheduler();
console.log("[perch] scheduler armed");

for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, () => {
    stopHerald?.();
    app.close().then(() => process.exit(0));
  });
}
