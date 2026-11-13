# Done (v0.3)

- Turn queueing, live turn card, optimistic send, reply pill, away divider
- Facts ledger with scope/category/provenance/guess + confirm/forget/correct
- Promise card (NL → chips → assumptions → pellet conflicts → I promise)
- Automation run log with sent/late/missed + one-note-per-day cap
- presence truth, queue API, turn retry, digest invalidation + retry
- Telegram: markdown→HTML, chunking, 429/5xx backoff, web-focus gate
- Memory column, fact grouping, provenance jump, day spine, kept/missed counter
- Open-source scaffolding: LICENSE, CoC, SECURITY, CONTRIBUTING, templates, CI, tests
- a11y: drawer focus trap, aria-live log

# Roadmap

Sourced from the gap list between `docs/SPEC.md` and what the daemon actually
does. Priorities are real: P0 items break a daily driver, P1 items block telling
anyone else about it, P2 is what comes after. Nothing here overrides
`docs/DECISIONS.md`.

## Now (P0 — daily-driver breakage)

- [ ] **Markdown rendering for hoot replies.** Replies are markdown and render
      literally today. Needs a sanitised renderer and token styles; user
      messages stay plain.
- [ ] **Optimistic send + retry.** Append a `sending…` bubble immediately,
      reconcile with the server item over SSE, mark failures in quiet colour and
      make them clickable to resend.
- [ ] **Reply pill.** When scrolled up, show a "Juniper replied" pill instead of
      yanking the viewport; never auto-scroll away from a reader.
- [ ] **Connection states.** `reconnecting…` in the footer after 3s of a closed
      stream, quiet presence after 30s, no toast spam.
- [ ] **Error toasts.** One small surface for failed sends, failed fact writes,
      and interrupted turns, with retry.
- [ ] **DELETE a queued turn.** The queue drains and survives restarts, but a
      queued chip cannot be removed once sent.
- [ ] **Presence honesty.** Presence must reflect daemon/hoot state only, never
      user activity (DECISIONS #7), and must drop to quiet when the stream is
      down.

## Next (P1 — blocks a second user)

- [ ] **Automation tools.** SPEC §3 promises `schedule_automation`,
      `list_automations`, `disable_automation`; only `recall` and `remember`
      exist. A hoot cannot keep its own promises yet.
- [ ] **Hunt threads.** `create_hunt(goal)` plus the thread kind, so bounded work
      stops polluting the bough.
- [ ] **Linux service unit.** Only a launchd plist exists; add systemd and
      document both.
- [ ] **Telegram onboarding.** A guided path from bot token to bound chat, since
      the herald is the only way to reach a hoot away from the desk.
- [ ] **Outbound ledger coverage for webhooks.** Any destination without a
      ledger row is a bug; webhooks do not exist yet.
- [ ] **Second-hoot onboarding.** The empty pellet slots (DECISIONS #11) and the
      explicit global-fact promotion flow (DECISIONS #13) both need to ship
      before a second hoot is usable.
- [ ] **`GET /v1/stream` reconnect tests.** Replay exists; add coverage so a
      reconnect regression is caught.

## Later (P2)

- [ ] Markdown in day digests, and digest typography past v1.
- [ ] Memory search across the pellet, not just FTS5 over items.
- [ ] Herald for one more chat surface (iMessage or email).
- [ ] `molt` as a real command: swap a hoot's model without losing memory.
- [ ] Local model presets in onboarding (Ollama / LM Studio) so a keyless setup
      is the easy path.
- [ ] Night flight: autonomous background work outside a user-visible turn.
- [ ] Export/import of a bough as plain text.

## Cut for v1

- Computer use and remote execution environments.
- Voice (screech).
- iMessage, email, and Slack heralds.
- Multi-user accounts, sharing, admin controls.
- Vector memory.
- Mobile app, cloud sync, plugin marketplace.
- Provider-specific wire formats beyond OpenAI-compatible chat completions.
- Folding a message into an in-flight turn (queueing only; see DECISIONS #6).
