import { assertConfig, config } from "./config.js";
import { buildServer } from "./server.js";
import { startScheduler } from "./scheduler.js";
import { registerHerald, startHeralds, stopHeralds } from "./herald.js";
import { telegramHerald } from "./herald-telegram.js";
import { imessageHerald } from "./herald-imessage.js";
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

// Heralds are started from config; each is opt-in and independent.
if (config.telegramToken) {
  registerHerald(telegramHerald(config.telegramToken));
} else {
  console.log("[perch] TELEGRAM_BOT_TOKEN not set — herald-telegram disabled");
}
if (config.imessage && config.imessageBuddies) {
  registerHerald(imessageHerald(config.imessageBuddies));
} else if (config.imessage) {
  console.log("[perch] PERCH_IMESSAGE set but PERCH_IMESSAGE_BUDDY empty — herald-imessage disabled");
}
startHeralds();
const started = config.telegramToken ? ["telegram"] : [];
if (config.imessage && config.imessageBuddies) started.push("imessage");
if (started.length) console.log(`[perch] heralds started: ${started.join(", ")}`);

startScheduler();
console.log("[perch] scheduler armed");
if (config.nightFlight) console.log("[perch] night flight armed (03:00 local, active hoots only)");

for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, () => {
    stopHeralds();
    app.close().then(() => process.exit(0));
  });
}
