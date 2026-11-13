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
  dbPath: path.join(
    (process.env.PERCH_DATA_DIR ?? "~/.hoots").replace(/^~(?=$|\/)/, os.homedir()),
    "perch.db"
  ),
};

export function assertConfig(): void {
  if (!config.openaiApiKey) throw new Error("missing env OPENAI_API_KEY");
  // telegram is optional (herald disabled without token)
}
