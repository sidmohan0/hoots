// Hand-written OpenAPI 3.1 description of the perch's HTTP surface. Served at
// GET /v1/openapi.json (auth-free, like /v1/health) so a local tool, the UI, or
// a contributor can discover routes without reading server.ts.
//
// This is documentation, not a validator: it is checked in beside the handlers
// and drifts if a route changes without a matching entry here. Keep summaries
// one line and bodies shallow.

const ERROR = {
  description: "Error",
  content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } },
};

const json = (description: string, schema: Record<string, unknown> = { type: "object" }) => ({
  description,
  content: { "application/json": { schema } },
});

const idParam = (name = "id") => ({
  name,
  in: "path",
  required: true,
  schema: { type: "string" },
});

export const openapi = {
  openapi: "3.1.0",
  info: {
    title: "perch",
    version: "0.0.1",
    description:
      "Loopback-bound daemon for Hoots. Bearer auth on every route except /v1/health, /v1/openapi.json, the UI bundle, and the SSE stream. POST routes are rate limited (429 + Retry-After) unless PERCH_RATE_LIMIT=0.",
  },
  servers: [{ url: "http://127.0.0.1:7420" }],
  security: [{ bearer: [] }],
  tags: [
    { name: "system", description: "health, schema, settings" },
    { name: "hoots", description: "agents and their configuration" },
    { name: "turns", description: "model invocation cycles and the composer queue" },
    { name: "items", description: "bough entries, read-only apart from turns" },
    { name: "automations", description: "promises on an RFC 5545 schedule" },
    { name: "memory", description: "facts, pellet, day digests" },
    { name: "presence", description: "one-line daemon/hoot state" },
    { name: "outbound", description: "what left the machine today" },
    { name: "channels", description: "herald bindings" },
    { name: "ui", description: "same-origin Parliament bundle" },
  ],
  paths: {
    "/v1/health": {
      get: {
        tags: ["system"],
        summary: "Liveness probe; auth-free.",
        security: [],
        responses: { 200: json("Daemon is up.", { type: "object", properties: { ok: { type: "boolean" }, version: { type: "string" } } }) },
      },
    },
    "/v1/openapi.json": {
      get: {
        tags: ["system"],
        summary: "This document; auth-free.",
        security: [],
        responses: { 200: json("OpenAPI 3.1 document.", { type: "object" }) },
      },
    },
    "/v1/settings": {
      get: { tags: ["system"], summary: "Read daemon settings (webhook URL).", responses: { 200: json("Current settings."), 401: ERROR } },
      patch: {
        tags: ["system"],
        summary: "Update settings; null clears the webhook.",
        requestBody: { required: true, content: { "application/json": { schema: { $ref: "#/components/schemas/SettingsPatch" } } } },
        responses: { 200: json("Updated settings."), 400: ERROR, 401: ERROR },
      },
    },
    "/v1/hoots": {
      get: { tags: ["hoots"], summary: "List hoots.", responses: { 200: json("Hoots."), 401: ERROR } },
      post: {
        tags: ["hoots"],
        summary: "Create a hoot and its bough.",
        requestBody: { required: true, content: { "application/json": { schema: { $ref: "#/components/schemas/HootCreate" } } } },
        responses: { 200: json("Created hoot."), 400: ERROR, 401: ERROR, 429: ERROR },
      },
    },
    "/v1/hoots/{id}": {
      get: { tags: ["hoots"], summary: "Read one hoot.", parameters: [idParam()], responses: { 200: json("Hoot."), 401: ERROR, 404: ERROR } },
      patch: {
        tags: ["hoots"],
        summary: "Update hoot configuration.",
        parameters: [idParam()],
        requestBody: { required: true, content: { "application/json": { schema: { $ref: "#/components/schemas/HootPatch" } } } },
        responses: { 200: json("Updated hoot."), 400: ERROR, 401: ERROR, 404: ERROR, 429: ERROR },
      },
    },
    "/v1/hoots/{id}/threads": {
      get: { tags: ["hoots"], summary: "List a hoot's threads.", parameters: [idParam()], responses: { 200: json("Threads."), 401: ERROR } },
    },
    "/v1/threads/{id}/turns": {
      post: {
        tags: ["turns"],
        summary: "Start a turn, or queue it if the thread is busy.",
        parameters: [idParam()],
        requestBody: { required: false, content: { "application/json": { schema: { $ref: "#/components/schemas/TurnCreate" } } } },
        responses: { 202: json("Turn id, or queue id when queued."), 400: ERROR, 401: ERROR, 404: ERROR, 409: ERROR, 429: ERROR },
      },
    },
    "/v1/hoots/{id}/queued": {
      get: { tags: ["turns"], summary: "Queued turns for a hoot.", parameters: [idParam()], responses: { 200: json("Queued turns."), 401: ERROR } },
    },
    "/v1/queued/{id}": {
      delete: { tags: ["turns"], summary: "Drop a queued turn.", parameters: [idParam()], responses: { 200: json("Deleted."), 401: ERROR, 404: ERROR } },
    },
    "/v1/turns/{id}/retry": {
      post: {
        tags: ["turns"],
        summary: "Re-run the last user message of an interrupted turn.",
        parameters: [idParam()],
        responses: { 202: json("Turn id, or queue id when queued."), 401: ERROR, 404: ERROR, 409: ERROR, 429: ERROR },
      },
    },
    "/v1/items/{id}": {
      get: { tags: ["items"], summary: "Read one item.", parameters: [idParam()], responses: { 200: json("Item."), 401: ERROR, 404: ERROR } },
    },
    "/v1/threads/{id}/items": {
      get: { tags: ["items"], summary: "Read a thread's items in order.", parameters: [idParam()], responses: { 200: json("Items."), 401: ERROR } },
    },
    "/v1/turns/{id}/items": {
      get: { tags: ["items"], summary: "Read one turn's items.", parameters: [idParam()], responses: { 200: json("Items."), 401: ERROR } },
    },
    "/v1/hoots/{id}/automations": {
      get: { tags: ["automations"], summary: "List a hoot's promises.", parameters: [idParam()], responses: { 200: json("Automations."), 401: ERROR } },
      post: {
        tags: ["automations"],
        summary: "Create a promise from an RRULE.",
        parameters: [idParam()],
        requestBody: { required: true, content: { "application/json": { schema: { $ref: "#/components/schemas/AutomationCreate" } } } },
        responses: { 200: json("Created automation."), 400: ERROR, 401: ERROR, 429: ERROR },
      },
    },
    "/v1/automations/{id}": {
      patch: {
        tags: ["automations"],
        summary: "Enable, disable, or retitle a promise.",
        parameters: [idParam()],
        requestBody: { required: true, content: { "application/json": { schema: { type: "object", properties: { enabled: { type: "boolean" }, title: { type: "string" }, prompt: { type: "string" } } } } } },
        responses: { 200: json("Updated automation."), 401: ERROR, 404: ERROR, 429: ERROR },
      },
      delete: { tags: ["automations"], summary: "Delete a promise.", parameters: [idParam()], responses: { 200: json("Deleted."), 401: ERROR, 404: ERROR } },
    },
    "/v1/hoots/{id}/promise-runs": {
      get: {
        tags: ["automations"],
        summary: "Promise history for one local day.",
        parameters: [idParam(), { name: "date", in: "query", required: false, schema: { type: "string", pattern: "^\\d{4}-\\d{2}-\\d{2}$" } }],
        responses: { 200: json("Runs."), 400: ERROR, 401: ERROR },
      },
    },
    "/v1/hoots/{id}/propose-promise": {
      post: {
        tags: ["automations"],
        summary: "Draft a promise from a sentence (one model call).",
        parameters: [idParam()],
        requestBody: { required: true, content: { "application/json": { schema: { type: "object", required: ["text"], properties: { text: { type: "string" } } } } } },
        responses: { 200: json("Draft."), 400: ERROR, 401: ERROR, 404: ERROR, 429: ERROR, 502: ERROR },
      },
    },
    "/v1/hoots/{id}/presence": {
      get: { tags: ["presence"], summary: "One-line daemon/hoot state.", parameters: [idParam()], responses: { 200: json("Presence."), 401: ERROR } },
    },
    "/v1/hoots/{id}/read": {
      get: { tags: ["presence"], summary: "Per-surface read marks.", parameters: [idParam()], responses: { 200: json("Read state."), 401: ERROR } },
      post: {
        tags: ["presence"],
        summary: "Mark a surface read now.",
        parameters: [idParam()],
        requestBody: { required: false, content: { "application/json": { schema: { type: "object", properties: { surface: { type: "string" } } } } } },
        responses: { 200: json("Marked."), 401: ERROR, 429: ERROR },
      },
    },
    "/v1/hoots/{id}/digest/{date}": {
      get: {
        tags: ["memory"],
        summary: "Lazy digest of a past local day.",
        parameters: [idParam(), { name: "date", in: "path", required: true, schema: { type: "string", pattern: "^\\d{4}-\\d{2}-\\d{2}$" } }],
        responses: { 200: json("Digest."), 401: ERROR },
      },
    },
    "/v1/hoots/{id}/facts": {
      get: { tags: ["memory"], summary: "Live facts for a hoot.", parameters: [idParam()], responses: { 200: json("Facts."), 401: ERROR } },
    },
    "/v1/facts/{id}": {
      patch: {
        tags: ["memory"],
        summary: "Edit a fact.",
        parameters: [idParam()],
        requestBody: { required: true, content: { "application/json": { schema: { type: "object", properties: { text: { type: "string" }, confidence: { type: "string" } } } } } },
        responses: { 200: json("Updated fact."), 401: ERROR, 404: ERROR, 429: ERROR },
      },
      delete: { tags: ["memory"], summary: "Forget a fact.", parameters: [idParam()], responses: { 200: json("Forgotten."), 401: ERROR } },
    },
    "/v1/hoots/{id}/pellet": {
      get: { tags: ["memory"], summary: "Read the pellet.", parameters: [idParam()], responses: { 200: json("Pellet."), 401: ERROR } },
    },
    "/v1/hoots/{id}/pellet/regenerate": {
      post: { tags: ["memory"], summary: "Regenerate the pellet now.", parameters: [idParam()], responses: { 200: json("Pellet."), 401: ERROR, 429: ERROR } },
    },
    "/v1/outbound/today": {
      get: { tags: ["outbound"], summary: "Today's outbound count, bytes, and recent rows.", responses: { 200: json("Ledger summary."), 401: ERROR } },
    },
    "/v1/hoots/{id}/channels/telegram/{chatId}": {
      post: {
        tags: ["channels"],
        summary: "Bind a Telegram chat to a hoot.",
        parameters: [idParam(), { name: "chatId", in: "path", required: true, schema: { type: "string" } }],
        responses: { 200: json("Bound."), 401: ERROR, 429: ERROR },
      },
    },
    "/v1/channels/telegram/{chatId}": {
      get: {
        tags: ["channels"],
        summary: "Which hoot a chat is bound to.",
        parameters: [{ name: "chatId", in: "path", required: true, schema: { type: "string" } }],
        responses: { 200: json("Binding or null."), 401: ERROR },
      },
    },
    "/v1/stream": {
      get: {
        tags: ["ui"],
        summary: "SSE event stream (auth-free); replays from Last-Event-ID.",
        security: [],
        parameters: [{ name: "since", in: "query", required: false, schema: { type: "integer" } }],
        responses: { 200: { description: "text/event-stream of bus events." } },
      },
    },
    "/": {
      get: { tags: ["ui"], summary: "Parliament shell, token injected.", security: [], responses: { 200: { description: "HTML." }, 503: { description: "UI not built." } } },
    },
    "/appicon.png": {
      get: { tags: ["ui"], summary: "App icon.", security: [], responses: { 200: { description: "PNG." }, 404: { description: "Missing." } } },
    },
    "/assets/{*path}": {
      get: {
        tags: ["ui"],
        summary: "Static UI assets.",
        security: [],
        parameters: [{ name: "path", in: "path", required: true, schema: { type: "string" } }],
        responses: { 200: { description: "Asset bytes." }, 404: { description: "Missing." } },
      },
    },
  },
  components: {
    securitySchemes: { bearer: { type: "http", scheme: "bearer" } },
    schemas: {
      Error: { type: "object", properties: { error: { type: "string" } } },
      HootCreate: {
        type: "object",
        required: ["name", "model_name"],
        properties: {
          name: { type: "string" },
          model_name: { type: "string" },
          model_base_url: { type: "string" },
          system_prompt: { type: "string" },
          avatar: { type: ["string", "null"] },
          model_params: { type: ["object", "null"] },
        },
      },
      HootPatch: {
        type: "object",
        properties: {
          name: { type: "string" },
          system_prompt: { type: "string" },
          model_name: { type: "string" },
          model_params: { type: "object" },
          status: { type: "string" },
          api_key_env: { type: "string" },
          model_base_url: { type: "string" },
        },
      },
      TurnCreate: {
        type: "object",
        properties: {
          message: { type: "string", maxLength: 32768 },
          surface: { type: "string", enum: ["web", "telegram", "system", "silent"] },
        },
      },
      AutomationCreate: {
        type: "object",
        required: ["title", "prompt", "rrule"],
        properties: {
          title: { type: "string" },
          prompt: { type: "string" },
          rrule: { type: "string" },
          timezone: { type: "string" },
          thread_kind: { type: "string", enum: ["bough", "hunt"] },
          deliver: { type: "boolean" },
        },
      },
      SettingsPatch: {
        type: "object",
        properties: { webhook_url: { type: ["string", "null"], format: "uri" } },
      },
    },
  },
} as const;
