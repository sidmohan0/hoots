import Fastify from "fastify";
import { readFileSync, existsSync, statSync } from "node:fs";
import path from "node:path";
import { config } from "./config.js";
import { db, now, uuid, recordAutomationRun, localDate, localDayBounds, getMeta, setMeta } from "./db.js";
import { logger } from "./log.js";
import { check, clientKey, limitPerMinute } from "./ratelimit.js";
import { openapi } from "./openapi.js";
import { startTurn, busyState } from "./turns.js";
import { getPellet, regeneratePellet } from "./pellet.js";
import { ensureDigest } from "./digests.js";
import { outboundToday } from "./outbound.js";
import { createAutomation, computeNextFire } from "./scheduler.js";
import { proposePromise } from "./promise.js";
import { bus } from "./stream.js";
import { bindChannel, channelForChat } from "./herald-telegram.js";
import { bindSurface, channelFor } from "./herald.js";
import { deriveTopics } from "./topics.js";
import { modelStatus, pullModel, speak, transcribeBuffer, ttsStatus, pullTtsModel } from "./voice.js";
import { decide } from "./computer/session.js";
import { available as computerAvailable } from "./computer/platform.js";
import { notes as computerNotes } from "./computer/darwin.js";

type Post = { body: any; params: any; query: any };

// Composer guard: empty turns are a no-op and runaway pastes blow the context.
const MAX_MESSAGE_CHARS = 32 * 1024;
type Reply = { code: (c: number) => { send: (x: unknown) => unknown }; type: (t: string) => { send: (x: unknown) => unknown } };

export function buildServer() {
  const app = Fastify({ logger: false });

  const startedAt = new WeakMap<object, number>();

  app.addHook("onRequest", async (req, reply) => {
    startedAt.set(req, performance.now());
    if (req.url === "/v1/health" || req.url === "/v1/openapi.json") return;
    if (
      req.url === "/" ||
      req.url.startsWith("/assets/") || req.url.startsWith("/shots/") ||
      req.url.startsWith("/v1/stream") ||
      ["/appicon.png", "/manifest.webmanifest", "/sw.js", "/icon-192.png", "/icon-512.png", "/icon-maskable-512.png", "/apple-touch-icon.png"].includes(req.url.split("?")[0])
    )
      return; // UI is same-origin local
    const auth = req.headers.authorization;
    if (auth !== `Bearer ${config.authToken}`) {
      return reply.code(401).send({ error: "unauthorized" });
    }
  });

  // POSTs only: a turn start or a model call is the expensive thing, plain
  // reads are not. Bucket is per client IP + path family.
  app.addHook("preHandler", async (req, reply) => {
    if (req.method !== "POST") return;
    const pathname = req.url.split("?")[0];
    const verdict = check(clientKey(req.ip, pathname));
    if (!verdict.ok) {
      logger.warn("rate limited", { ip: req.ip, path: pathname, limit: verdict.limit, retry_after: verdict.retryAfter });
      reply.header("retry-after", String(verdict.retryAfter));
      return reply.code(429).send({ error: "too many requests", retry_after: verdict.retryAfter });
    }
  });

  app.addHook("onResponse", async (req, reply) => {
    logger.info("request", {
      method: req.method,
      path: req.url.split("?")[0],
      status: reply.statusCode,
      duration_ms: Math.round(performance.now() - (startedAt.get(req) ?? performance.now())),
    });
  });

  app.get("/v1/health", async () => ({ ok: true, version: "0.0.1" }));

  // Machine-readable route list; auth-free like /v1/health so it is greppable
  // from a browser on the loopback.
  app.get("/v1/openapi.json", async () => openapi);

  // --- settings ---
  const readWebhookUrl = () => getMeta("webhook_url") || null;
  app.get("/v1/settings", async () => ({ webhook_url: readWebhookUrl(), rate_limit_per_min: limitPerMinute() }));
  app.patch("/v1/settings", async (req: Post, reply: Reply) => {
    const { webhook_url } = req.body ?? {};
    if (webhook_url !== undefined && webhook_url !== null && webhook_url !== "") {
      if (typeof webhook_url !== "string" || !/^https?:\/\/\S+$/.test(webhook_url)) {
        return reply.code(400).send({ error: "webhook_url must be an http(s) URL" });
      }
    }
    setMeta("webhook_url", typeof webhook_url === "string" ? webhook_url : "");
    return { webhook_url: readWebhookUrl() };
  });

  // --- hoots ---
  app.post("/v1/hoots", async (req: Post, reply: Reply) => {
    const { name, system_prompt = "", model_base_url, model_name, model_params = null, avatar = null } = req.body ?? {};
    if (!name || !model_name) return reply.code(400).send({ error: "name and model_name required" });
    const id = uuid();
    db.prepare(
      `INSERT INTO hoots (id, name, avatar, status, model_base_url, model_name, model_params, system_prompt, created_at)
       VALUES (?, ?, ?, 'active', ?, ?, ?, ?, ?)`
    ).run(id, name, avatar, model_base_url ?? config.openaiBaseUrl, model_name, JSON.stringify(model_params), system_prompt, now());
    // create the bough
    db.prepare(`INSERT INTO threads (id, hoot_id, kind, title, status, created_at, updated_at)
                VALUES (?, ?, 'bough', NULL, 'open', ?, ?)`).run(uuid(), id, now(), now());
    return db.prepare("SELECT * FROM hoots WHERE id = ?").get(id);
  });

  app.get("/v1/hoots", async () => db.prepare("SELECT * FROM hoots").all());
  app.get("/v1/hoots/:id", async (req: Post, reply: Reply) => {
    const row = db.prepare("SELECT * FROM hoots WHERE id = ?").get(req.params.id);
    if (!row) return reply.code(404).send({ error: "not found" });
    return row;
  });
  app.patch("/v1/hoots/:id", async (req: Post, reply: Reply) => {
    const h = db.prepare("SELECT * FROM hoots WHERE id = ?").get(req.params.id) as any;
    if (!h) return reply.code(404).send({ error: "not found" });
    const { name, system_prompt, model_name, model_params, status, api_key_env, model_base_url, computer_mode } = req.body ?? {};
    if (api_key_env && !process.env[api_key_env]) {
      return reply.code(400).send({ error: `env ${api_key_env} is not set on the perch` });
    }
    db.prepare(
      `UPDATE hoots SET name=?, system_prompt=?, model_name=?, model_params=?, status=?, api_key_env=?, model_base_url=?, computer_mode=? WHERE id=?`
    ).run(
      name ?? h.name, system_prompt ?? h.system_prompt, model_name ?? h.model_name,
      model_params ? JSON.stringify(model_params) : h.model_params, status ?? h.status,
      api_key_env ?? h.api_key_env, model_base_url ?? h.model_base_url, computer_mode ?? h.computer_mode, h.id
    );
    bus.publish({ event: "hoot.updated", data: { hoot_id: h.id } });
    return db.prepare("SELECT * FROM hoots WHERE id = ?").get(h.id);
  });

  // --- threads & turns ---
  app.get("/v1/hoots/:id/threads", async (req: Post) =>
    db.prepare("SELECT * FROM threads WHERE hoot_id = ? ORDER BY created_at").all(req.params.id));

  app.post("/v1/threads/:id/turns", async (req: Post, reply: Reply) => {
    const thread = db.prepare("SELECT * FROM threads WHERE id = ?").get(req.params.id) as any;
    if (!thread) return reply.code(404).send({ error: "not found" });
    const message: string | undefined = req.body?.message;
    if (message !== undefined) {
      if (typeof message !== "string" || !message.trim()) {
        return reply.code(400).send({ error: "message must not be empty" });
      }
      if (message.length > MAX_MESSAGE_CHARS) {
        return reply.code(400).send({ error: `message over ${MAX_MESSAGE_CHARS} characters` });
      }
    }
    const surface: "web" | "telegram" | "imessage" | "system" | "silent" = (req.body?.surface as any) ?? "web";
    try {
      const { turnId, queued, queueId } = await startTurn({
        threadId: thread.id, trigger: message ? "user" : "tool", message: message ?? null, surface,
      });
      return reply.code(202).send({ turn_id: turnId, queued, queue_id: queueId ?? null });
    } catch (err: any) {
      return reply.code(409).send({ error: String(err?.message ?? err) });
    }
  });

  // Queue visibility: what the composer queued for this hoot (never hidden).
  app.get("/v1/hoots/:id/queued", async (req: Post) =>
    db.prepare(
      `SELECT q.id, q.thread_id, q.message, q.surface, q.created_at
       FROM queued_turns q JOIN threads t ON t.id = q.thread_id
       WHERE t.hoot_id = ? ORDER BY q.created_at`
    ).all(req.params.id));

  app.delete("/v1/queued/:id", async (req: Post, reply: Reply) => {
    const row = db.prepare(`SELECT id FROM queued_turns WHERE id = ?`).get(req.params.id);
    if (!row) return reply.code(404).send({ error: "not found" });
    db.prepare(`DELETE FROM queued_turns WHERE id = ?`).run(req.params.id);
    return { ok: true };
  });

  app.get("/v1/items/:id", async (req: Post, reply: Reply) => {
    const item = db.prepare("SELECT * FROM items WHERE id = ?").get(req.params.id);
    if (!item) return reply.code(404).send({ error: "not found" });
    return item;
  });

  app.get("/v1/threads/:id/items", async (req: Post) =>
    db.prepare("SELECT * FROM items WHERE thread_id = ? ORDER BY created_at, seq").all(req.params.id));

  // --- topics (⌘K) ---
  // Recurring keywords in the hoot's messages. `?q=` narrows; `/v1/topics` is
  // the flat alias the palette uses so it can search across hoots.
  app.get("/v1/hoots/:id/topics", async (req: Post) => deriveTopics(req.params.id, (req.query as any).q));
  app.get("/v1/topics", async (req: Post, reply: Reply) => {
    const hoot: string | undefined = (req.query as any).hoot;
    if (!hoot) return reply.code(400).send({ error: "hoot required" });
    return deriveTopics(hoot, (req.query as any).q);
  });
  app.get("/v1/turns/:id/items", async (req: Post) =>
    db.prepare("SELECT * FROM items WHERE turn_id = ? ORDER BY seq").all(req.params.id));

  // Retry = a fresh turn re-running the same user message, on the same surface.
  app.post("/v1/turns/:id/retry", async (req: Post, reply: Reply) => {
    const turn = db.prepare(`SELECT * FROM turns WHERE id = ?`).get(req.params.id) as any;
    if (!turn) return reply.code(404).send({ error: "not found" });
    if (turn.status !== "interrupted") return reply.code(409).send({ error: "turn is not interrupted" });
    const lastUser = db
      .prepare(`SELECT content FROM items WHERE turn_id = ? AND role = 'user' ORDER BY seq DESC LIMIT 1`)
      .get(turn.id) as any;
    if (!lastUser) return reply.code(409).send({ error: "no user message to retry" });
    const text = String(JSON.parse(lastUser.content)?.text ?? "");
    try {
      const { turnId, queued, queueId } = await startTurn({
        threadId: turn.thread_id,
        trigger: turn.trigger,
        message: text,
        surface: turn.origin_surface,
      });
      return reply.code(202).send({ turn_id: turnId, queued, queue_id: queueId ?? null });
    } catch (err: any) {
      return reply.code(409).send({ error: String(err?.message ?? err) });
    }
  });

  // --- automations ---
  app.post("/v1/hoots/:id/automations", async (req: Post, reply: Reply) => {
    const { title, prompt, rrule, timezone, thread_kind, deliver } = req.body ?? {};
    if (!title || !prompt || !rrule) return reply.code(400).send({ error: "title, prompt, rrule required" });
    const next = computeNextFire(rrule, timezone ?? "UTC");
    if (next == null) return reply.code(400).send({ error: "invalid rrule" });
    return createAutomation({ hoot_id: req.params.id, title, prompt, rrule, timezone, thread_kind, deliver });
  });
  app.get("/v1/hoots/:id/automations", async (req: Post) =>
    db.prepare("SELECT * FROM automations WHERE hoot_id = ?").all(req.params.id));
  app.patch("/v1/automations/:id", async (req: Post, reply: Reply) => {
    const a = db.prepare("SELECT * FROM automations WHERE id = ?").get(req.params.id) as any;
    if (!a) return reply.code(404).send({ error: "not found" });
    const { enabled, title, prompt } = req.body ?? {};
    const newEnabled = enabled === undefined ? a.enabled : (enabled ? 1 : 0);
    // Disabling drops the pending promise: log it so the drawer tells the truth.
    if (a.enabled && !newEnabled && a.next_fire_at != null) {
      recordAutomationRun({
        automationId: a.id, hootId: a.hoot_id, scheduledAt: a.next_fire_at, firedAt: null, outcome: "missed",
      });
    }
    db.prepare(`UPDATE automations SET enabled=?, title=?, prompt=? WHERE id=?`).run(
      newEnabled, title ?? a.title, prompt ?? a.prompt, a.id);
    if (newEnabled) db.prepare(`UPDATE automations SET next_fire_at=? WHERE id=?`).run(computeNextFire(a.rrule, a.timezone), a.id);
    return db.prepare("SELECT * FROM automations WHERE id = ?").get(a.id);
  });
  app.delete("/v1/automations/:id", async (req: Post, reply: Reply) => {
    const a = db.prepare("SELECT * FROM automations WHERE id = ?").get(req.params.id);
    if (!a) return reply.code(404).send({ error: "not found" });
    db.prepare("DELETE FROM automations WHERE id = ?").run(req.params.id);
    return { ok: true };
  });

  // Draft a promise from a sentence (model call; never writes the db).
  app.post("/v1/hoots/:id/propose-promise", async (req: Post, reply: Reply) => {
    const hoot = db.prepare("SELECT id FROM hoots WHERE id = ?").get(req.params.id);
    if (!hoot) return reply.code(404).send({ error: "not found" });
    const text: string = req.body?.text;
    if (typeof text !== "string" || !text.trim()) return reply.code(400).send({ error: "text required" });
    try {
      return await proposePromise(req.params.id, text);
    } catch (err: any) {
      return reply.code(err?.status ?? 502).send({ error: String(err?.message ?? err) });
    }
  });

  // Promise history for one local day (drawer + today-strip).
  app.get("/v1/hoots/:id/promise-runs", async (req: Post, reply: Reply) => {
    const date: string = (req.query as any).date ?? localDate();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return reply.code(400).send({ error: "date must be YYYY-MM-DD" });
    const { start, end } = localDayBounds(date);
    return db
      .prepare(
        `SELECT r.id, r.automation_id, r.scheduled_at, r.fired_at, r.outcome, a.title
         FROM automation_runs r JOIN automations a ON a.id = r.automation_id
         WHERE r.hoot_id = ? AND r.scheduled_at >= ? AND r.scheduled_at < ?
         ORDER BY r.scheduled_at`
      )
      .all(req.params.id, start, end);
  });

  // --- screech v1: local speech in (Parakeet via sherpa-onnx) ---
  app.addContentTypeParser(
    /^audio\/.*/,
    { parseAs: "buffer", bodyLimit: 25 * 1024 * 1024 },
    (_req, body, done) => done(null, body)
  );
  app.addContentTypeParser(
    "application/octet-stream",
    { parseAs: "buffer", bodyLimit: 25 * 1024 * 1024 },
    (_req, body, done) => done(null, body)
  );

  app.get("/v1/voice/status", async () => ({ stt: modelStatus(), tts: ttsStatus() }));
  app.post("/v1/voice/model/pull", async (_req, reply) => {
    pullModel().catch((err) => bus.publish({ event: "turn.status", data: { voice_pull_error: String(err) } }));
    return reply.code(202).send({ ...modelStatus(), pulling: true });
  });
  app.post("/v1/voice/model/pull-tts", async (_req, reply: Reply) => {
    pullTtsModel().catch((err) => logger.warn("voice out pull failed", { error: err }));
    return reply.code(202).send({ ...ttsStatus(), pulling: true });
  });
  // Speech out: text in, WAV out. The client decides when to play.
  app.post("/v1/voice/speak", async (req: Post, reply: Reply) => {
    const text = String(req.body?.text ?? "").trim().slice(0, 1200);
    if (!text) return reply.code(400).send({ error: "text required" });
    if (!ttsStatus().present) return reply.code(409).send({ error: "voice model missing", needsModel: true });
    try {
      const wav = await speak(text, Number(req.body?.speed ?? 1) || 1);
      return reply.type("audio/wav").send(wav);
    } catch (err: any) {
      return reply.code(500).send({ error: `speech failed: ${err?.message ?? err}` });
    }
  });

  app.post("/v1/voice/transcribe", async (req: any, reply: Reply) => {
    if (!modelStatus().present) return reply.code(409).send({ error: "voice model missing", needsModel: true });
    const body = Buffer.isBuffer(req.body) ? req.body : Buffer.from([]);
    if (!body.length) return reply.code(400).send({ error: "empty audio" });
    try {
      const text = await transcribeBuffer(body, req.headers["content-type"] ?? "");
      return { text };
    } catch (err: any) {
      return reply.code(422).send({ error: `transcription failed: ${err?.message ?? err}` });
    }
  });
  // Voice in → normal turn. Same ledger, same surface rules.
  app.post("/v1/hoots/:id/voice/turn", async (req: any, reply: Reply) => {
    if (!modelStatus().present) return reply.code(409).send({ error: "voice model missing", needsModel: true });
    const thread = db
      .prepare(`SELECT id FROM threads WHERE hoot_id = ? AND kind = 'bough'`)
      .get(req.params.id) as any;
    if (!thread) return reply.code(404).send({ error: "no bough" });
    const body = Buffer.isBuffer(req.body) ? req.body : Buffer.from([]);
    if (!body.length) return reply.code(400).send({ error: "empty audio" });
    let text: string;
    try {
      text = await transcribeBuffer(body, req.headers["content-type"] ?? "");
    } catch (err: any) {
      return reply.code(422).send({ error: `transcription failed: ${err?.message ?? err}` });
    }
    if (!text) return reply.code(422).send({ error: "heard nothing" });
    const { turnId, queued } = await startTurn({ threadId: thread.id, trigger: "user", message: text, surface: "web" });
    return reply.code(202).send({ turn_id: turnId, queued, transcript: text });
  });

  // --- computer use ---
  app.get("/v1/computer/status", async () => ({
    platform: process.platform,
    available: computerAvailable(),
    permissions: computerNotes,
    maxSteps: Number(process.env.PERCH_COMPUTER_MAX_STEPS ?? 60),
  }));
  app.get("/v1/approvals", async () =>
    db
      .prepare(`SELECT * FROM approvals WHERE status = 'pending' ORDER BY created_at LIMIT 20`)
      .all());
  app.post("/v1/approvals/:id", async (req: Post, reply: Reply) => {
    const decision = req.body?.decision === "deny" ? "denied" : "approved";
    return decide(req.params.id, decision) ? { ok: true } : reply.code(404).send({ error: "not pending" });
  });
  // Screenshots are receipts: served like the UI, auth-free same-origin.
  app.get("/shots/*", async (req: any, reply: Reply) => {
    const rel = (req.params as any)["*"];
    const file = path.join(config.dataDir, "shots", rel);
    if (!existsSync(file)) return reply.code(404).send({ error: "not found" });
    reply.type("image/jpeg").send(readFileSync(file));
  });

  // --- presence (board 04B: one line, third person) ---
  app.get("/v1/hoots/:id/presence", async (req: Post) => {
    const hoot = db.prepare("SELECT * FROM hoots WHERE id = ?").get(req.params.id) as any;
    if (!hoot) return { error: "not found" };
    const lastHeard = db
      .prepare(
        `SELECT i.created_at, COALESCE(i.surface, t.origin_surface) AS surface FROM items i
         JOIN turns t ON t.id = i.turn_id JOIN threads th ON th.id = i.thread_id
         WHERE th.hoot_id = ? AND i.kind = 'message' AND i.role = 'user'
         ORDER BY i.created_at DESC LIMIT 1`
      )
      .get(req.params.id) as any;
    const nextFire = db
      .prepare(`SELECT MIN(next_fire_at) AS n FROM automations WHERE hoot_id = ? AND enabled = 1`)
      .get(req.params.id) as any;
    const lastTurn = db
      .prepare(
        `SELECT t.status AS status FROM turns t JOIN threads th ON th.id = t.thread_id
         WHERE th.hoot_id = ? ORDER BY t.started_at DESC LIMIT 1`
      )
      .get(req.params.id) as any;
    const failing = lastTurn?.status === "interrupted";
    // A turn in flight beats every other read: the hoot is thinking right now.
    const threadIds = new Set(
      (db.prepare(`SELECT id FROM threads WHERE hoot_id = ?`).all(req.params.id) as any[]).map((t) => t.id)
    );
    const live = busyState().find((b) => threadIds.has(b.threadId));
    const inFlight = live
      ? { started_at: live.startedAt }
      : (db
          .prepare(
            `SELECT t.started_at FROM turns t JOIN threads th ON th.id = t.thread_id
             WHERE th.hoot_id = ? AND t.status = 'in_progress' ORDER BY t.started_at DESC LIMIT 1`
          )
          .get(req.params.id) as any);
    const status = inFlight ? "thinking" : !config.openaiApiKey || failing ? "quiet" : "awake";
    return {
      status,
      busySince: inFlight ? inFlight.started_at : null,
      lastHeard: lastHeard ? { at: lastHeard.created_at, surface: lastHeard.surface } : null,
      nextPromise: nextFire?.n ?? null,
    };
  });

  // --- per-surface read state (away divider, board 07) ---
  app.get("/v1/hoots/:id/read", async (req: Post) =>
    db.prepare(`SELECT surface, last_read_at FROM read_state WHERE hoot_id = ?`).all(req.params.id));
  app.post("/v1/hoots/:id/read", async (req: Post) => {
    const { surface = "web" } = req.body ?? {};
    db.prepare(
      `INSERT INTO read_state (hoot_id, surface, last_read_at) VALUES (?, ?, ?)
       ON CONFLICT(hoot_id, surface) DO UPDATE SET last_read_at = excluded.last_read_at`
    ).run(req.params.id, surface, now());
    return { ok: true };
  });

  // --- day digests (lazy; DECISIONS.md #9) ---
  app.get("/v1/hoots/:id/digest/:date", async (req: Post) => {
    const text = await ensureDigest(req.params.id, req.params.date);
    return { date: req.params.date, digest: text };
  });

  // --- facts (memory drawer; board 04B right panel) ---
  app.get("/v1/hoots/:id/facts", async (req: Post) =>
    db.prepare(
      `SELECT f.*, i.thread_id AS source_thread_id
       FROM facts f LEFT JOIN items i ON i.id = f.source_item_id
       WHERE f.hoot_id = ? AND f.forgotten_at IS NULL ORDER BY f.created_at DESC`
    ).all(req.params.id));
  app.patch("/v1/facts/:id", async (req: Post, reply: Reply) => {
    const f = db.prepare(`SELECT * FROM facts WHERE id = ?`).get(req.params.id) as any;
    if (!f) return reply.code(404).send({ error: "not found" });
    const { text, confidence, scope } = req.body ?? {};
    // Promotion to global is always explicit (DECISIONS.md #13).
    if (scope !== undefined && scope !== "global" && scope !== "hoot") {
      return reply.code(400).send({ error: "scope must be 'global' or 'hoot'" });
    }
    db.prepare(
      `UPDATE facts SET text = COALESCE(?, text), confidence = COALESCE(?, confidence), scope = COALESCE(?, scope) WHERE id = ?`
    ).run(text ?? null, confidence ?? null, scope ?? null, f.id);
    bus.publish({ event: "fact.changed", data: { fact_id: f.id, hoot_id: f.hoot_id } });
    return db.prepare(`SELECT * FROM facts WHERE id = ?`).get(f.id);
  });

  // Facts shared with every hoot ("everywhere" in the memory drawer).
  app.get("/v1/facts", async (req: Post, reply: Reply) => {
    const scope = (req.query as any).scope;
    if (scope === "global") {
      return db
        .prepare(
          `SELECT f.*, h.name AS hoot_name FROM facts f JOIN hoots h ON h.id = f.hoot_id
           WHERE f.scope = 'global' AND f.forgotten_at IS NULL ORDER BY f.created_at DESC`
        )
        .all();
    }
    if (scope !== undefined && scope !== "hoot") return reply.code(400).send({ error: "scope must be 'global' or 'hoot'" });
    return db
      .prepare(`SELECT f.*, h.name AS hoot_name FROM facts f JOIN hoots h ON h.id = f.hoot_id WHERE f.forgotten_at IS NULL ORDER BY f.created_at DESC`)
      .all();
  });
  app.delete("/v1/facts/:id", async (req: Post) => {
    const f = db.prepare(`SELECT * FROM facts WHERE id = ?`).get(req.params.id) as any;
    db.prepare(`UPDATE facts SET forgotten_at = ? WHERE id = ?`).run(now(), req.params.id);
    // Keep the ledger honest: the note item that taught this fact is undone too,
    // so a later pellet refresh doesn't re-pin it.
    if (f?.source_item_id) {
      const item = db.prepare(`SELECT content FROM items WHERE id = ?`).get(f.source_item_id) as any;
      if (item) {
        const note = JSON.parse(item.content);
        if (typeof note?.fact === "string")
          db.prepare(`UPDATE items SET content = ? WHERE id = ?`)
            .run(JSON.stringify({ fact: note.fact, undone: true }), f.source_item_id);
      }
    }
    bus.publish({ event: "fact.changed", data: { fact_id: req.params.id } });
    return { ok: true };
  });

  // --- outbound ledger (DECISIONS.md #5) ---
  app.get("/v1/outbound/today", async () => ({ ...outboundToday(), rows: db
    .prepare(`SELECT ts, dest, purpose, bytes FROM outbound_log ORDER BY ts DESC LIMIT 50`).all() }));

  // --- pellet ---
  app.get("/v1/hoots/:id/pellet", async (req: Post) => getPellet(req.params.id));
  app.post("/v1/hoots/:id/pellet/regenerate", async (req: Post) => regeneratePellet(req.params.id));

  // --- channels (dev convenience) ---
  app.post("/v1/hoots/:id/channels/telegram/:chatId", async (req: Post) => {
    bindChannel(req.params.id, req.params.chatId);
    return { ok: true };
  });
  app.get("/v1/channels/telegram/:chatId", async (req: Post) => channelForChat(req.params.chatId) ?? null);
  app.post("/v1/hoots/:id/channels/imessage/:handle", async (req: Post) => {
    bindSurface(req.params.id, "imessage", req.params.handle);
    return { ok: true };
  });
  app.get("/v1/channels/imessage/:handle", async (req: Post) => channelFor("imessage", req.params.handle) ?? null);

  // --- Parliament (built UI), served same-origin ---
  const uiDir = path.join(import.meta.dirname ?? ".", "..", "..", "parliament", "dist");
  app.get("/", async (req, reply) => {
    const file = path.join(uiDir, "index.html");
    if (existsSync(file)) {
      const html = readFileSync(file, "utf8").replace("__HOOT_TOKEN__", config.authToken);
      reply.type("text/html").send(html);
    } else {
      reply.code(503).send("Parliament not built — run `npm run build -w parliament`");
    }
  });
  app.get("/appicon.png", async (_req, reply) => {
    const file = path.join(uiDir, "appicon.png");
    if (!existsSync(file)) return reply.code(404).send();
    reply.type("image/png").send(readFileSync(file));
  });
  const staticRoots: Record<string, string> = {
    "/manifest.webmanifest": "manifest.webmanifest",
    "/sw.js": "sw.js",
    "/icon-192.png": "icon-192.png",
    "/icon-512.png": "icon-512.png",
    "/icon-maskable-512.png": "icon-maskable-512.png",
    "/apple-touch-icon.png": "apple-touch-icon.png",
  };
  for (const [route, file] of Object.entries(staticRoots)) {
    app.get(route, async (_req, reply) => {
      const full = path.join(uiDir, file);
      if (!existsSync(full)) return reply.code(404).send();
      const type = file.endsWith(".webmanifest") ? "application/manifest+json"
        : file.endsWith(".js") ? "text/javascript" : "image/png";
      reply.type(type).send(readFileSync(full));
    });
  }
  app.get("/assets/*", async (req, reply) => {
    const rel = (req.params as any)["*"];
    const file = path.join(uiDir, "assets", rel);
    if (!existsSync(file) || !statSync(file).isFile()) return reply.code(404).send();
    const ext = path.extname(file);
    const types: Record<string, string> = { ".js": "text/javascript", ".css": "text/css", ".ttf": "font/ttf", ".svg": "image/svg+xml", ".png": "image/png", ".html": "text/html" };
    reply.type(types[ext] ?? "application/octet-stream").send(readFileSync(file));
  });

  // --- SSE stream ---
  app.get("/v1/stream", async (req: any, reply: any) => {
    reply.raw.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
    });
    const lastId = Number((req.headers["last-event-id"] as string) ?? 0);
    const since = Number(req.query.since ?? 0) || lastId;
    for (const ev of bus.since(since)) {
      reply.raw.write(`id: ${ev.id}\nevent: ${ev.event}\ndata: ${JSON.stringify(ev.data)}\n\n`);
    }
    const listener = (ev: any) =>
      reply.raw.write(`id: ${ev.id}\nevent: ${ev.event}\ndata: ${JSON.stringify(ev.data)}\n\n`);
    bus.on("event", listener);
    const ping = setInterval(() => reply.raw.write(`: ping\n\n`), 15000);
    req.raw.on("close", () => {
      clearInterval(ping);
      bus.off("event", listener);
    });
  });

  return app;
}
