# Hoots

Personal agents that live on your machine, remember across sessions, and keep
the check-ins you asked for.

Hoots exists because a chat window forgets you the moment you close it. A hoot
keeps one continuous life-story, so a conversation from three weeks ago is still
the context for today — persistence is the feature, not a transcript. It runs on
your own hardware and writes to a local ledger you can read and edit, because an
agent that remembers you should not also own the record. And it keeps rhythms:
you set the promises, it shows up on time and tells you when it was late.

## Status

Pre-alpha, honest version. The daemon and the UI both run, one maintainer
dogfoods it daily, and it is not yet something you can hand to a stranger.

| Works today | Not yet |
|---|---|
| Multiple hoots, each with its own bough | Hunt (bounded task) threads |
| Turns against any OpenAI-compatible endpoint | Markdown rendering of replies |
| Pellet memory + facts with guesses, provenance, forget | Model-facing automation tools |
| Promises (automations) with timezone-correct RRULEs | Voice, iMessage, email, Slack |
| Telegram herald, inbound and outbound | Vector recall (keyword FTS5 only) |
| Day digests, outbound ledger, presence, ⌘K | Linux service unit (launchd only, macOS) |
| Turn queueing, boot reconciliation, SSE replay | Mobile layout, accounts, sync |

`docs/SPEC.md` is the design contract; `ROADMAP.md` says what is next and what
was cut.

## Architecture

```
        Telegram chat                      Browser (Parliament UI)
              │                                     │
              │ long-poll / send                    │ REST + SSE, same origin
              ▼                                     ▼
   ┌──────────────────────────────────────────────────────────────┐
   │ perch  — loopback daemon, 127.0.0.1:7420, bearer token       │
   │                                                              │
   │  herald-telegram   turn loop   scheduler   outbound ledger    │
   │        │              │            │            │            │
   │        └──────────────┴────────────┴────────────┘            │
   │                          │                                    │
   │                     SQLite ledger  ~/.hoots/perch.db          │
   │              hoots · threads · turns · items · facts          │
   │              automations · channels · outbound_log            │
   └──────────────────────────────────────────────────────────────┘
                              │
                              ▼
                    your model endpoint (OpenAI-compatible)
```

One process owns all state. The UI holds none: it is a view over the API, and
the same conversation can happen from Telegram.

## Voice (screech)

Speech in runs entirely on your machine: **Parakeet TDT 0.6B v3** (25 languages,
int8 ONNX) via sherpa-onnx, CPU only, ~28× realtime. The model is 671 MB, pulled
on first use and cached under `~/.hoots/models/`:

```bash
curl -X POST localhost:7420/v1/voice/model/pull -H "Authorization: Bearer $PERCH_AUTH_TOKEN"
```

Then either speak in the app (the mic in the composer) or send voice notes on
Telegram. Audio is transcribed to a normal turn — same ledger, same surfaces.
The recogniser unloads after five idle minutes, so people who never speak keep a
light daemon. Speech *out* (Piper) is the next step.

## Desktop app

Parliament runs as a local web app; the desktop shell (Tauri 2) adds what a tab
can't: a tray presence, close-to-tray, single instance, and a `hoots://` scheme.

```bash
npm run dev -w perch          # the daemon must be running
npm run dev -w @hoots/desktop # the shell, pointed at 127.0.0.1:7420
```

Builds for macOS and Windows are produced by `.github/workflows/desktop.yml`.
The shell expects a running perch (bring your own for now); a managed installer
is on the roadmap.

You can also install the web app itself: Chrome/Edge → Install, or the browser's
"You can install this app" affordance. It gets its own window and icon.

## Quick start

```bash
git clone https://github.com/sidmohan0/hoots && cd hoots
npm ci
cp .env.example .env          # set OPENAI_API_KEY and PERCH_AUTH_TOKEN
npm run dev                   # daemon on http://127.0.0.1:7420
```

Create a hoot with `curl -s localhost:7420/v1/hoots -H "Authorization: Bearer $PERCH_AUTH_TOKEN" -H 'content-type: application/json' -d '{"name":"Juniper","system_prompt":"..."}'`,
then open `http://127.0.0.1:7420/`. Requires Node 22+ and a C toolchain for
`better-sqlite3`.

## Design and decisions

- `docs/design/` — the boards and design tokens behind every screen.
- `docs/DECISIONS.md` — locked decisions. Read before proposing a change.
- `docs/SPEC.md` — vocabulary, data model, turn loop, API.

Three coined words, and only three: **hoot** (an agent), **bough** (its one
thread), **pellet** (its distilled memory). Everything else stays boring on
purpose.

## What leaves your machine

Your machine is the source of truth. Here is exactly what leaves it, and when —
no "your data never leaves this machine" hand-waving.

Two destinations, both opt-in, every request written to the outbound ledger that
the footer counts:

1. **Your model endpoint** — the turn's token-budgeted context, pellet
   regeneration, and day digests. Point `OPENAI_BASE_URL` at a local server and
   nothing leaves at all.
2. **Telegram** — only if you set a bot token: outbound hoot messages to chats
   you bound, plus long-polling for replies.

Never sent: the full bough history (only a recent window plus the pellet), facts
you deleted, other hoots' memory, and anything from a hoot on a local endpoint.
Fonts are self-hosted; there is no font CDN and no analytics. Details and the
threat model are in `SECURITY.md`.

## Contributing

`CONTRIBUTING.md` has the setup, the architecture in ten lines, the vocabulary
budget, and the herald contract. Run `npm test` and `npm run typecheck` before
opening a PR; a design change needs a board or a `docs/DECISIONS.md` entry.
Security reports go to sidmohan001@gmail.com, not the issue tracker.

## License

MIT — `LICENSE`. Copyright 2026 Sid Mohan and contributors.
