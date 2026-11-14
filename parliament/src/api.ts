// Typed API client for the perch. Same-origin; token injected into index.html.

function token(): string {
  const meta = document.querySelector('meta[name="hoot-token"]');
  return meta?.getAttribute("content") ?? "";
}

async function req<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    ...init,
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${token()}`,
      ...init?.headers,
    },
  });
  if (!res.ok) throw new Error(`${init?.method ?? "GET"} ${path} → ${res.status}`);
  return res.json() as Promise<T>;
}

export const api = {
  hoots: () => req<any[]>("/v1/hoots"),
  hoot: (id: string) => req<any>(`/v1/hoots/${id}`),
  createHoot: (body: any) => req<any>("/v1/hoots", { method: "POST", body: JSON.stringify(body) }),
  patchHoot: (id: string, body: any) => req<any>(`/v1/hoots/${id}`, { method: "PATCH", body: JSON.stringify(body) }),
  threads: (hootId: string) => req<any[]>(`/v1/hoots/${hootId}/threads`),
  items: (threadId: string) => req<any[]>(`/v1/threads/${threadId}/items`),
  item: (id: string) => req<any>(`/v1/items/${id}`),
  send: (threadId: string, message: string, surface = "web") =>
    req<{ turn_id: string; queued: boolean }>(`/v1/threads/${threadId}/turns`, {
      method: "POST",
      body: JSON.stringify({ message, surface }),
    }),
  presence: (hootId: string) => req<any>(`/v1/hoots/${hootId}/presence`),
  read: (hootId: string, surface = "web") =>
    req<{ ok: boolean }>(`/v1/hoots/${hootId}/read`, { method: "POST", body: JSON.stringify({ surface }) }),
  readState: (hootId: string) => req<{ surface: string; last_read_at: number }[]>(`/v1/hoots/${hootId}/read`),
  digest: (hootId: string, date: string) =>
    req<{ date: string; digest: string | null }>(`/v1/hoots/${hootId}/digest/${date}`),
  facts: (hootId: string) => req<any[]>(`/v1/hoots/${hootId}/facts`),
  globalFacts: () => req<any[]>(`/v1/facts?scope=global`),
  confirmFact: (id: string) => req<any>(`/v1/facts/${id}`, { method: "PATCH", body: JSON.stringify({ confidence: "confirmed" }) }),
  editFact: (id: string, text: string) => req<any>(`/v1/facts/${id}`, { method: "PATCH", body: JSON.stringify({ text }) }),
  patchFactScope: (id: string, scope: "global" | "hoot") =>
    req<any>(`/v1/facts/${id}`, { method: "PATCH", body: JSON.stringify({ scope }) }),
  forgetFact: (id: string) => req<{ ok: boolean }>(`/v1/facts/${id}`, { method: "DELETE" }),
  automations: (hootId: string) => req<any[]>(`/v1/hoots/${hootId}/automations`),
  propose: (hootId: string, text: string) =>
    req<any>(`/v1/hoots/${hootId}/propose-promise`, { method: "POST", body: JSON.stringify({ text }) }),
  createAutomation: (hootId: string, body: any) =>
    req<any>(`/v1/hoots/${hootId}/automations`, { method: "POST", body: JSON.stringify(body) }),
  promiseRuns: (hootId: string, date: string) =>
    req<any[]>(`/v1/hoots/${hootId}/promise-runs?date=${date}`),
  patchAutomation: (id: string, body: any) => req<any>(`/v1/automations/${id}`, { method: "PATCH", body: JSON.stringify(body) }),
  outbound: () => req<{ count: number; bytes: number }>("/v1/outbound/today"),
  pellet: (hootId: string) => req<any>(`/v1/hoots/${hootId}/pellet`),
  voiceStatus: () => req<{ present: boolean; bytes: number; expected: number; loaded: boolean; pulling: boolean }>("/v1/voice/status"),
  voicePull: (which: "stt" | "tts" = "stt") =>
    req<any>(`/v1/voice/model/${which === "tts" ? "pull-tts" : "pull"}`, { method: "POST" }),
  speak: async (text: string): Promise<Blob> => {
    const res = await fetch("/v1/voice/speak", {
      method: "POST",
      headers: { authorization: `Bearer ${token()}`, "content-type": "application/json" },
      body: JSON.stringify({ text }),
    });
    if (!res.ok) throw new Error(`speak → ${res.status}`);
    return res.blob();
  },
  voiceTurn: async (hootId: string, wav: Blob) => {
    const res = await fetch(`/v1/hoots/${hootId}/voice/turn`, {
      method: "POST",
      headers: { authorization: `Bearer ${token()}`, "content-type": "audio/wav" },
      body: wav,
    });
    if (res.status === 409) return { needsModel: true as const };
    if (!res.ok) throw new Error(`voice turn → ${res.status}`);
    return res.json() as Promise<{ turn_id: string; queued: boolean; transcript: string }>;
  },
  topics: (hootId: string, q: string) =>
    req<{ topic: string; count: number }[]>(`/v1/topics?hoot=${encodeURIComponent(hootId)}&q=${encodeURIComponent(q)}`),
};

export type Item = {
  id: string;
  turn_id: string;
  thread_id: string;
  seq: number;
  kind: "message" | "tool_call" | "tool_result" | "note";
  role: "user" | "hoot" | "system" | null;
  content: string; // JSON
  surface: string | null;
  delivered: string;
  created_at: number;
};

export type Presence = {
  status: "awake" | "thinking" | "sleeping" | "quiet";
  lastHeard: { at: number; surface: string } | null;
  nextPromise: number | null;
};

export type Fact = {
  id: string;
  hoot_id: string;
  text: string;
  category: string | null;
  scope: string;
  source_item_id: string | null;
  confidence: "pinned" | "confirmed" | "extracted";
  created_at: number;
  forgotten_at: number | null;
  source_thread_id?: string | null;
  hoot_name?: string;
};

export type Automation = {
  id: string;
  hoot_id: string;
  title: string;
  prompt: string;
  rrule: string;
  timezone: string;
  enabled: number;
  thread_kind: string;
  deliver: number;
  last_fired_at: number | null;
  next_fire_at: number | null;
};

export type StreamEvt = { id: number; event: string; data: any };
