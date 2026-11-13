# Hoots — design brief: Parliament (v1)

## What it is

Hoots is a self-hosted system for **always-on personal agents**. One "hoot" is a
persistent agent that lives on your own machine: it remembers across sessions,
checks in on a schedule, and talks to you from your phone (Telegram) as well as
the web. The web app is called **Parliament** — the collective noun for owls.

The pitch in one line: *an agent with continuity and gentle initiative, owned
by you, running on your own hardware.*

## Why it should feel different

- Not a chat app with history — a **relationship with continuity**.
- Not a notification firehose — **few, well-timed check-ins** you set.
- Not a cloud product — **local-first**; your machine holds everything.

## Vocabulary (please use these words)

| Word | Meaning |
|---|---|
| **hoot** | the agent itself — one character |
| **bough** | its single, continuous thread of memory. There is no chat list; each hoot has exactly one life-story. |
| **pellet** | its distilled long-term memory: a short summary + a list of durable facts. Visible and inspectable. |
| **parliament** | the app; also the sidebar view of all your hoots |
| **hunt** | a bounded task the hoot works |
| **automation** | a scheduled check-in (title + instruction + recurrence) |
| **herald** | a channel bridge, e.g. Telegram |

## What exists today (backend, working)

A local daemon serves a REST + SSE API at `127.0.0.1:7420`:

- `GET /v1/hoots`, `GET /v1/hoots/:id`, `PATCH` (rename/re-persona), `POST` (create)
- `GET /v1/hoots/:id/threads`, `GET /v1/threads/:id/items` (the bough's messages)
- `POST /v1/threads/:id/turns` `{message}` → returns `{turn_id}`; the reply lands in items
- `GET /v1/hoots/:id/pellet` `{facts: string[], summary: string, generated_at}`
- `GET/POST/PATCH/DELETE /v1/hoots/:id/automations` `{title, prompt, rrule, enabled, next_fire_at}`
- `GET /v1/stream` — SSE: `turn.status`, `item.append`, `hoot.updated`, `automation.fired`

Data realities: turns take **seconds to ~a minute** (the model "thinks"); replies
arrive as items; the same conversation is also happening in Telegram.

## The five flows to design

1. **Live conversation** with a hoot — how a slow, thinking reply is shown without spinners-and-dread.
2. **Memory made legible** — seeing/trusting what the hoot remembers (the pellet).
3. **Automations** — creating and feeling a scheduled check-in ("every day at 6, 10, 12, 3, 5").
4. **Parliament** — multiple hoots: switching, adding one (name + persona), seeing who's awake.
5. **Cross-surface continuity** — replies you already got on Telegram, visible when you open the web app.

## The opinions we actually want (answer these)

1. **Chat vs diary.** One endless thread per agent is the data model. How do you
   make a single never-ending thread navigable across days and weeks? Day
   separators, a time gutter, "you were last here" markers, something else?
2. **Presence.** How does an always-on agent feel *alive* without being noisy?
   What's the status vocabulary — sleeping / thinking / last-seen / gone-quiet?
3. **Proactivity framing.** Are automations "schedules" or "promises the hoot
   keeps"? How do you show what fired, what's next, and what was missed?
4. **Memory legibility.** Show the pellet raw (facts + paragraph) or something
   softer? On demand or ambient? Where's the line between magical and creepy?
5. **Trust.** "Your data never leaves this machine" — how to make that legible
   without privacy boilerplate?
6. **Empty states.** A brand-new hoot knows nothing and has no history. How do
   you make that charming rather than broken?
7. **The default screen.** If users only ever used ONE view, what should it be,
   and why?
8. **What would you cut** from the list above for v1?

## Deliverables we'd love

- One page of **opinionated principles** (the "we will / we won't" list).
- **2–3 divergent directions** for the main conversation screen + memory surface
  (lo-fi wireframes are perfect; Figma/paper/Excalidraw all welcome).
- An **information architecture** sketch: parliament sidebar, conversation, memory, automations.
- Interaction notes for **live updates** (does content stream in place, do
  headers pulse, do we batch?) and for arriving-from-Telegram continuity.
- The **one thing** you think we're getting wrong.

## Constraints

- React/Vite web app served by the local daemon — **desktop-first**, responsive is nice-to-have.
- Live updates arrive via SSE; **slow thinking is part of the experience**, not a bug to hide.
- Keyboard-friendly; light + dark.
- Single user, no accounts, no auth UI.
- Telegram is a **first-class sibling surface**, not a fallback. Same agent, two windows.
- Local data only; no cloud sync.

## Non-goals for v1

Voice, computer control, sharing/multi-user, native mobile app, plugin marketplace.

## Format

No code needed. Opinions + sketches, async, whatever medium you think in.
Strong takes welcome; disagreement with the brief is the most useful thing you
can send.
