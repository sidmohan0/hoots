import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";

// Every test file gets its own throwaway data directory, and no model key, so
// importing perk's db/config never touches the real ~/.hoots ledger and nothing
// can accidentally reach a model endpoint.
process.env.PERCH_DATA_DIR = mkdtempSync(path.join(os.tmpdir(), "perch-test-"));
process.env.PERCH_AUTH_TOKEN = "test-token";
// Pin the host zone: rrule's own tzid handling reads it, so scheduler
// expectations must not move when the suite runs somewhere else.
process.env.TZ = "America/Los_Angeles";
delete process.env.OPENAI_API_KEY;
delete process.env.TELEGRAM_BOT_TOKEN;
