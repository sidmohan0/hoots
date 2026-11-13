import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { db, now, uuid } from "../src/db.js";
import { check, pathClass, limitPerMinute, reset } from "../src/ratelimit.js";
import { runMigrations, MIGRATIONS } from "../src/migrate.js";
import { buildServer } from "../src/server.js";

// Ops surface: rate limiting, the migration ledger, and the auth-free schema
// document. No model calls are involved.

const TOKEN = "test-token";
const auth = { authorization: `Bearer ${TOKEN}` };

describe("rate limit", () => {
  afterEach(() => {
    delete process.env.PERCH_RATE_LIMIT;
    reset();
  });

  it("refuses past the bucket and reports a retry-after", () => {
    expect(check("k", 2, 1_000).ok).toBe(true);
    expect(check("k", 2, 1_000).ok).toBe(true);
    const third = check("k", 2, 1_000);
    expect(third.ok).toBe(false);
    if (!third.ok) expect(third.retryAfter).toBeGreaterThanOrEqual(1);
  });

  it("refills over the window", () => {
    check("k", 2, 0);
    check("k", 2, 0);
    expect(check("k", 2, 60_000).ok).toBe(true);
  });

  it("is disabled by PERCH_RATE_LIMIT=0", () => {
    process.env.PERCH_RATE_LIMIT = "0";
    expect(limitPerMinute()).toBe(0);
    for (let i = 0; i < 50; i++) expect(check("k").ok).toBe(true);
  });

  it("classes paths without ids", () => {
    expect(pathClass("/v1/hoots/8c1f0f7e-1111-2222-3333-444455556666/automations")).toBe("hoots/automations");
    expect(pathClass("/v1/settings")).toBe("settings");
  });
});

describe("migrations", () => {
  it("applies once and records the ids", () => {
    const applied = (db.prepare("SELECT id FROM schema_migrations").all() as { id: string }[]).map((r) => r.id);
    expect(applied).toEqual(MIGRATIONS.map((m) => m.id));
    expect(runMigrations(db)).toEqual([]);
  });
});

describe("server ops routes", () => {
  let app: ReturnType<typeof buildServer>;

  beforeEach(async () => {
    app = buildServer();
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
    delete process.env.PERCH_RATE_LIMIT;
    reset();
  });

  it("serves the OpenAPI document without auth", async () => {
    const res = await app.inject({ method: "GET", url: "/v1/openapi.json" });
    expect(res.statusCode).toBe(200);
    expect(res.json().openapi).toBe("3.1.0");
    expect(res.json().paths["/v1/settings"]).toBeTruthy();
  });

  it("keeps /v1/settings behind auth and validates the webhook URL", async () => {
    expect((await app.inject({ method: "GET", url: "/v1/settings" })).statusCode).toBe(401);

    const bad = await app.inject({ method: "PATCH", url: "/v1/settings", headers: auth, payload: { webhook_url: "ftp://x" } });
    expect(bad.statusCode).toBe(400);

    const ok = await app.inject({
      method: "PATCH", url: "/v1/settings", headers: auth, payload: { webhook_url: "http://127.0.0.1:9/hook" },
    });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().webhook_url).toBe("http://127.0.0.1:9/hook");

    const cleared = await app.inject({ method: "PATCH", url: "/v1/settings", headers: auth, payload: { webhook_url: null } });
    expect(cleared.json().webhook_url).toBeNull();
  });

  it("returns 429 with Retry-After once a POST burst passes the limit", async () => {
    process.env.PERCH_RATE_LIMIT = "3";
    reset();
    const body = { name: `burst-${uuid()}`, model_name: "test-model" };
    const codes: number[] = [];
    for (let i = 0; i < 4; i++) {
      const res = await app.inject({ method: "POST", url: "/v1/hoots", headers: auth, payload: body });
      codes.push(res.statusCode);
      if (res.statusCode === 429) expect(res.headers["retry-after"]).toBeTruthy();
    }
    expect(codes.slice(0, 3)).toEqual([200, 200, 200]);
    expect(codes[3]).toBe(429);
  });
});

// Keep the ledger tidy for later files in the same run.
process.on("exit", () => db.prepare("DELETE FROM hoots WHERE name LIKE 'burst-%'").run());
void now;
