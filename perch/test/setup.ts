// Point every test run at an isolated data dir BEFORE config.ts/db.ts load.
// Without this, `npm test` wipes the developer's live ~/.hoots database.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.PERCH_DATA_DIR = mkdtempSync(join(tmpdir(), "hoots-test-"));
process.env.PERCH_AUTH_TOKEN = "test-token";
process.env.OPENAI_API_KEY = "";
