# Security

## Threat model

Hoots is a single-user daemon on your own machine. The threat model assumes the
machine itself is trusted and the network is not.

- **Loopback only.** The perch binds `127.0.0.1` (default port 7420). Nothing is
  exposed to your LAN or the internet; there is no port-forwarding story, no
  public endpoint, no tunnel in v1.
- **Bearer token.** Every `/v1` route requires
  `Authorization: Bearer $PERCH_AUTH_TOKEN`. The token lives in your env (and in
  `~/.hoots` for the launchd service), never in the database or in the repo.
  Anything running as your user can read it, which is the point — the token
  keeps stray browser pages and local processes out, not a remote attacker.
- **Model config** carries `api_key_env`, not the key itself: the perch resolves
  the key from its own environment at call time, so a database leak does not leak
  credentials.
- **No accounts, no cloud sync.** There is no user table, no session cookie, no
  hosted component to compromise. Deleting `~/.hoots` deletes the product.

## What leaves the machine

Exactly two destinations, both opt-in, both recorded in the outbound ledger
(`outbound_log` table, counted in the UI footer):

1. **Your model endpoint** (`OPENAI_BASE_URL`) — turn context, pellet
   regeneration, day digests. Whatever the model provider sees, by definition.
   Point it at a local server (Ollama, LM Studio, llama.cpp) and nothing leaves
   at all.
2. **Telegram** (optional, only with `TELEGRAM_BOT_TOKEN`) — outbound hoot
   messages to chats you bound, and long-polling to receive replies.

## What does not leave

- The full bough history. Turns send a token-budgeted window plus the pellet
  summary and fact list — not the archive.
- Deleted (forgotten) facts.
- Other hoots' memory. Hoots are isolated; only `scope: 'global'` facts cross.
- Anything at all from a hoot whose model endpoint is local.
- Fonts and assets are self-hosted; there is no font CDN or analytics script.

Day digests are generated lazily on first view and see only that day's items of
that bough — never the pellet, never other hoots.

## Reporting a vulnerability

Email **sidmohan001@gmail.com** with a description, the daemon version
(`GET /v1/health`), and a reproduction if you have one. Please do not open a
public issue for anything exploitable.

You can expect an acknowledgement within a few days. Fixes land on `main` with a
`security:` commit prefix and a note in the release; there is no embargo process
beyond that — this is a one-maintainer project, and early disclosure beats a
long silence.

## Known sharp edges

- `PERCH_AUTH_TOKEN` default is `dev-token`. Set a long random value.
- The daemon trusts its own data directory. Anyone who can write `~/.hoots` can
  rewrite your ledger and your hoot personas.
- Automations are instructions executed by a model with built-in tools; a
  prompt-injected document can steer a turn. Tools are read-mostly and scoped to
  the local ledger, so the blast radius is your own notes.
