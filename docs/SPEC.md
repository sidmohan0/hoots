# Hoots — Design Contract (v0)

Status: draft, pre-implementation.
Audience: contributors to `perch` (daemon) and `parliament` (web UI).

Hoots is a system for always-on personal agents. An agent ("hoot") lives
independently of any one client, holds a persistent memory, acts on a
schedule, and is reachable from several chat surfaces. This document fixes
the vocabulary, the data model, and the API surface for v1.

---

## 1. Vocabulary

Product-layer names (whimsy allowed):

| Term        | Meaning |
|-------------|---------|
| **hoot**    | One personal agent. Has a name, a model config, memory, and channels. |
| **perch**   | The always-on daemon process. Hoots "sit" on the perch. Owns all state. |
| **parliament** | The collection of a user's hoots (the UI's sidebar view). Real collective noun for owls. |
| **bough**   | A hoot's primary, never-deleted thread. The hoot's continuous life-story. |
| **hunt**    | A bounded task thread a hoot works (has a goal, runs to completion). |
| **pellet**  | A rolling summary of a hoot's bough — the long-term memory. Regenerated as the bough grows. |
| **herald**  | A channel bridge that carries messages between the outside world and the perch. v1 ships `herald-telegram`; `herald-imessage` is opt-in on macOS. |
| **molt**    | Replacing a hoot's model configuration without losing its memory. |
| **night flight** | The nightly autonomous pass: every active hoot rereads its day, pins what matters, notes one thing for tomorrow. |
| **screech** | Voice channel (reserved, v2). |
| **talon**   | The tool interface a hoot can call (reserved; v1 tools are built-in). |

Engineering-layer names (boring, on purpose): `thread`, `turn`, `item`,
`automation`, `channel`. Whimsy must not leak into schemas or wire formats.

---

## 2. Data model

All state lives in SQLite under the perch's data directory (default
`~/.hoots/perch.db`). Append-heavy, single-writer (the perch), read by UI
via the API.

### hoot
```ts
{
  id: string                  // uuid
  name: string                // "Brian"
  avatar: string | null       // emoji or asset id, v1
  status: "active" | "paused"
  model: {
    base_url: string          // any OpenAI-compatible endpoint
    api_key_env: string       // key resolved from perch env, never stored in db
    model: string             // e.g. "gpt-5.2"
    params: object | null     // temperature, max tokens, etc.
  }
  system_prompt: string       // the hoot's persona + operating instructions
  created_at: int             // unix ms
}
```

### thread
```ts
{
  id: string                  // uuid
  hoot_id: string
  kind: "bough" | "hunt"
  title: string | null
  status: "open" | "complete" | "archived"
  goal: string | null         // hunts only
  created_at: int
  updated_at: int
}
```
Exactly one `bough` per hoot, created with the hoot, never archived.
`hunt` threads are created by automations or tools, and complete.

### turn
```ts
{
  id: string
  thread_id: string
  status: "in_progress" | "completed" | "interrupted"
  trigger: "user" | "automation" | "channel" | "tool"
  started_at: int
  completed_at: int | null
  error: string | null
}
```
A turn is one model invocation cycle (possibly many model calls + tool
uses). Turns are serial per thread.

### item
```ts
{
  id: string
  turn_id: string
  seq: int                    // order within turn
  kind: "message" | "tool_call" | "tool_result" | "note"
  role: "user" | "hoot" | "system" | null   // messages only
  content: object             // kind-specific
  created_at: int
}
```
Items are the append-only ledger. The bough's items are the hoot's memory.

### automation
```ts
{
  id: string
  hoot_id: string
  title: string
  prompt: string              // instruction given to the hoot at fire time
  rrule: string               // RFC 5545 RRULE incl. DTSTART with timezone
  enabled: bool
  thread_kind: "bough" | "hunt"   // run in the bough, or spawn a hunt
  deliver: "channel" | "silent"   // push the result to channels, or not
  created_at: int
  last_fired_at: int | null
  next_fire_at: int | null
}
```

### channel
```ts
{
  id: string
  hoot_id: string
  kind: "telegram"            // v1; later: imessage, email, slack
  external_id: string         // e.g. telegram chat id
  created_at: int
}
```
Inbound channel messages are turns with `trigger: "channel"` in the hoot's
bough. Outbound hoot messages are delivered to every channel bound to the
hoot (fan-out), unless a turn originated from a specific channel, in which
case the reply goes back to that channel only.

### pellet (stored as thread metadata, not a table)
The pellet is a generated summary + key-facts list over the bough. It is
regenerated (a) when bough item count grows ~50 since last generation,
(b) on demand. It is injected as system context in every turn, ahead of
recent window items.

---

## 3. The turn loop

1. Acquire per-thread turn lock (serialize turns on a thread).
2. Assemble context: hoot system prompt + pellet + last N bough items
   (token-budgeted) + hunt goal (if hunt).
3. Call the model (OpenAI-compatible chat completions) with the v1 tool set.
4. On tool calls: execute, append `tool_result` items, loop (max K hops).
5. On final assistant message: append item, mark turn `completed`.
6. Emit stream events throughout (see §5).
7. On crash/timeout: mark turn `interrupted`; the ledger stays consistent
   because items were appended as produced.

V1 built-in tools:
- `recall(query)` — keyword search over bough items.
- `remember(fact)` — pin a fact into the next pellet generation.
- `schedule_automation(title, prompt, rrule)` — create an automation.
- `list_automations()` / `disable_automation(id)`.
- `create_hunt(goal)` — spawn a hunt thread for bounded work.

---

## 4. Automations

The perch runs a scheduler loop every 60s: find enabled automations with
`next_fire_at <= now`, fire a turn (`trigger: "automation"`) with the
automation prompt, compute the next occurrence from the RRULE, and — if
`deliver: "channel"` — deliver the resulting hoot message(s) through all
bound channels.

RRULEs are evaluated with the user's timezone from the automation record
(`default_timezone`, RFC 5545 `DTSTART;TZID=`). Missed fires while the
perch was down fire once on startup (coalesced), then resume the schedule.

### Night flight

`PERCH_NIGHT_FLIGHT` (default off) adds one autonomous pass at 03:00 local:
every *active* hoot gets a `trigger: "automation"`, `origin_surface:
"silent"` turn on its bough with a fixed prompt (reread today, pin what is
worth carrying, note one thing for tomorrow — two short lines). The pass is
claimed before it fires, keyed to the 03:00 occurrence, so a night slept
through yields one catch-up run on boot and never a stack; each run logs one
line. Paused hoots are skipped. Same rrule machinery as promises
(`FREQ=DAILY;BYHOUR=3`), but not an `automations` row — it is not the
user's to edit in v1.

---

## 5. API surface

Base: `http://127.0.0.1:7420/v1`. Auth: `Authorization: Bearer
$PERCH_AUTH_TOKEN` (loopback-bound listener in v1).

```
GET    /health                          -> {ok, version}
POST   /hoots                           -> create hoot (name, system_prompt, model)
GET    /hoots                           -> list
GET    /hoots/:id                       -> detail
PATCH  /hoots/:id                       -> update (name, prompt, model) [molt]
DELETE /hoots/:id                       -> pause+archive (v1: soft)

GET    /hoots/:id/threads               -> threads
POST   /threads/:id/turns               -> {message} -> {turn_id} (starts turn)
GET    /threads/:id/turns               -> list turns
GET    /turns/:id/items                 -> items of a turn
GET    /threads/:id/items?after=        -> windowed item read (bough paging)

GET    /hoots/:id/automations           -> list
POST   /hoots/:id/automations           -> create
PATCH  /automations/:id                 -> enable/disable/edit
DELETE /automations/:id

POST   /hoots/:id/pellet/regenerate     -> force pellet rebuild
GET    /hoots/:id/pellet                -> current pellet

GET    /stream                          -> SSE, events below
```

SSE events:
```
event: turn.status      data: {turn_id, status, error?}
event: item.append      data: {item}
event: hoot.updated     data: {hoot}
event: automation.fired data: {automation_id, turn_id}
```

---

## 6. Channels (heralds)

A herald is a connector that (a) receives inbound messages and (b) sends
outbound messages, translating to/from the item ledger. Every herald is an
in-process module behind one contract (`perch/src/herald.ts`):

```ts
interface Herald {
  id: string                                   // "herald-telegram"
  start(ctx: HeraldContext): () => void        // returns a stop function
}

interface HeraldContext {
  send(text: string, hootId: string): Promise<number>  // out: perch -> surface
  deliver(hootId, chatKey, surface, text): Promise<unknown> // in: surface -> turn
  transport(fn: (text, hootId) => Promise<number>): void    // herald installs `send`
}
```

`surface` is the herald id minus the `herald-` prefix. The perch owns the
ledger half of every herald so a new one never re-implements it: `deliver`
resolves the hoot's bough, records surface read state for the "last heard
from you" line, and starts a `trigger: "channel"` turn; `fanOut(item)` picks
the heralds an outbound hoot message reaches and stamps `items.delivered`.
A herald only translates to and from its own wire format.

Fan-out policy: a turn answers on the surface it came from; an automation
turn with `deliver: "channel"` (`origin_surface: "system"`) reaches every
binding; nothing buzzes a phone while a web tab has been read in the last
minute; web-origin and `silent` turns are recorded but never pushed.

Registry: `registerHerald`, `activeHeralds`, `fanOut`, `startHeralds`,
`stopHeralds`. Heralds are registered at boot from config, each opt-in.

**herald-telegram (v1)**: long-polling Bot API (works behind NAT; no
public endpoint required). Inbound chat message → `trigger: "channel"`
turn in the hoot's bough → replies delivered back to that chat. Hoots may
proactively message any bound chat (automations with
`deliver: "channel"`).

**herald-imessage (macOS, opt-in)**: requires `PERCH_IMESSAGE=true` *and*
`PERCH_IMESSAGE_BUDDY` (comma-separated handles); registered only when both
are set. Outbound shells out to `/usr/bin/osascript` and Messages.app,
chunked at 3500 chars, skipping every send while no buddy is configured.
Inbound polls `~/Library/Messages/chat.db` read-only every 5s for rows past
a stored rowid (`meta` key `imessage:last_rowid`), keeps only the configured
buddies, and delivers them on surface `imessage`. Two one-time macOS grants
are needed — Automation (System Settings › Privacy & Security › Automation ›
the terminal running the perch › Messages; AppleScript failure `-1743`) and
Full Disk Access (… › Full Disk Access › the same terminal; failure
`SQLITE_CANTOPEN`). Each logs a one-line hint, once, and the perch keeps
running.

Heralds run inside the perch process today. The registry is already shaped
for out-of-process loaders — a child process or socket transport registers
the same `Herald` and never touches the ledger — but no such loader ships
yet.

## 7. Non-goals for v1

- Computer use / remote environments.
- Voice (screech), email/slack heralds, out-of-process herald loaders.
- Multi-user accounts, sharing, admin controls.
- Vector memory (pellet + keyword recall only).
- Model-agnostic providers beyond the OpenAI-compatible chat completions
  wire format (that format is itself the abstraction).

## 8. Reserved words

`screech`, `talon`, `roost`, `brood`, `molt`(as a command name). Do not
reuse for other meanings. (`night flight` was reserved for exactly the
nightly pass above and is no longer free.)
