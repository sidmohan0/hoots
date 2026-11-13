import Fastify from "fastify";
import { config } from "./config.js";
import { db, now, uuid } from "./db.js";
import { startTurn } from "./turns.js";
import { getPellet, regeneratePellet } from "./pellet.js";
import { createAutomation, computeNextFire } from "./scheduler.js";
import { bus } from "./stream.js";
import { bindChannel, channelForChat } from "./herald-telegram.js";

type Post = { body: any; params: any; query: any };
type Reply = { code: (c: number) => { send: (x: unknown) => unknown } };

export function buildServer() {
  const app = Fastify({ logger: false });

  app.addHook("onRequest", async (req, reply) => {
    if (req.url === "/v1/health") return;
    const auth = req.headers.authorization;
    if (auth !== `Bearer ${config.authToken}`) {
      return reply.code(401).send({ error: "unauthorized" });
    }
  });

  app.get("/v1/health", async () => ({ ok: true, version: "0.0.1" }));

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
    const { name, system_prompt, model_name, model_params, status } = req.body ?? {};
    db.prepare(
      `UPDATE hoots SET name=?, system_prompt=?, model_name=?, model_params=?, status=? WHERE id=?`
    ).run(
      name ?? h.name, system_prompt ?? h.system_prompt, model_name ?? h.model_name,
      model_params ? JSON.stringify(model_params) : h.model_params, status ?? h.status, h.id
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
    try {
      const turnId = await startTurn({ threadId: thread.id, trigger: message ? "user" : "tool", message: message ?? null });
      return reply.code(202).send({ turn_id: turnId });
    } catch (err: any) {
      return reply.code(409).send({ error: String(err?.message ?? err) });
    }
  });

  app.get("/v1/threads/:id/items", async (req: Post) =>
    db.prepare("SELECT * FROM items WHERE thread_id = ? ORDER BY created_at, seq").all(req.params.id));
  app.get("/v1/turns/:id/items", async (req: Post) =>
    db.prepare("SELECT * FROM items WHERE turn_id = ? ORDER BY seq").all(req.params.id));

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
    db.prepare(`UPDATE automations SET enabled=?, title=?, prompt=? WHERE id=?`).run(
      newEnabled, title ?? a.title, prompt ?? a.prompt, a.id);
    if (newEnabled) db.prepare(`UPDATE automations SET next_fire_at=? WHERE id=?`).run(computeNextFire(a.rrule, a.timezone), a.id);
    return db.prepare("SELECT * FROM automations WHERE id = ?").get(a.id);
  });

  // --- pellet ---
  app.get("/v1/hoots/:id/pellet", async (req: Post) => getPellet(req.params.id));
  app.post("/v1/hoots/:id/pellet/regenerate", async (req: Post) => regeneratePellet(req.params.id));

  // --- channels (dev convenience) ---
  app.post("/v1/hoots/:id/channels/telegram/:chatId", async (req: Post) => {
    bindChannel(req.params.id, req.params.chatId);
    return { ok: true };
  });
  app.get("/v1/channels/telegram/:chatId", async (req: Post) => channelForChat(req.params.chatId) ?? null);

  // --- SSE stream ---
  app.get("/v1/stream", async (req: any, reply: any) => {
    reply.raw.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
    });
    const listener = (ev: any) => reply.raw.write(`event: ${ev.event}\ndata: ${JSON.stringify(ev.data)}\n\n`);
    bus.on("event", listener);
    const ping = setInterval(() => reply.raw.write(`: ping\n\n`), 15000);
    req.raw.on("close", () => {
      clearInterval(ping);
      bus.off("event", listener);
    });
  });

  return app;
}
