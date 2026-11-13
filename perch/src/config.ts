import "dotenv/config";
import os from "node:os";
import path from "node:path";

function req(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`missing env ${name}`);
  return v;
}

export const config = {
  port: Number(process.env.PERCH_PORT ?? 7420),
  dataDir: (process.env.PERCH_DATA_DIR ?? "~/.hoots").replace(/^~(?=$|\/)/, os.homedir()),
  authToken: process.env.PERCH_AUTH_TOKEN ?? "dev-token",
  openaiBaseUrl: process.env.OPENAI_BASE_URL ?? "https://api.openai.com/v1",
  openaiApiKey: process.env.OPENAI_API_KEY ?? "",
  telegramToken: process.env.TELEGRAM_BOT_TOKEN ?? "",
  // iMessage bridge is macOS-only and opt-in; both flags must be present.
  imessage: process.env.PERCH_IMESSAGE === "true",
  imessageBuddies: process.env.PERCH_IMESSAGE_BUDDY ?? "",
  // Nightly autonomous pass over every active hoot at 03:00 local. Off by default.
  nightFlight: process.env.PERCH_NIGHT_FLIGHT === "true",
  dbPath: path.join(
    (process.env.PERCH_DATA_DIR ?? "~/.hoots").replace(/^~(?=$|\/)/, os.homedir()),
    "perch.db"
  ),
};

export function assertConfig(): void {
  if (!config.openaiApiKey) throw new Error("missing env OPENAI_API_KEY");
  // Telegram, iMessage and night flight are all optional.
}
