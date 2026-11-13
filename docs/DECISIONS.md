# Hoots — locked decisions

Every entry here is settled. Don't relitigate in PRs; amend the doc instead.

## From the Parliament design review (v2 boards, 2026-11-13)

1. **Local-first copy.** Never claim "your data never leaves this machine."
   Say: "Your machine is the source of truth. Here is exactly what leaves it,
   and when." Backed by the outbound ledger (see 5).
2. **Vocabulary budget: three coined words** — hoot, bough, pellet. In the UI:
   hunts are "tasks" (rendered inline as turns), heralds are their channel
   name ("Telegram"), automations are "promises". API field names keep
   `automation` etc.; UI copy uses the budget words.
3. **One view, two drawers.** The hoot page (`/juniper`) is the only
   destination. Memory and promises are drawers (`?d=memory`, `?d=promises`),
   closed by default. ⌘K is one overlay: hoots, days, facts, topics — Enter
   lands in the bough, never a results page.
4. **Promises have one home.** The today-strip is canonical; the drawer is its
   history and settings. (The footer count is the outbound ledger, not
   promises.)
5. **Outbound ledger is real.** Every outbound request (model turn context,
   pellet regeneration, Telegram sends, webhooks) is written by the single
   outbound client the perch uses. A destination with no ledger row is a bug.
   Never sent: full bough history, deleted facts, other hoots' memory.
6. **Composer never blocks.** While a turn is in flight, new input is queued
   ("queued next"), not folded into the in-flight turn, and the API never
   returns 409 to the composer. Folding mid-turn is explicitly out of scope.
7. **Presence grammar.** The glyph encodes daemon/hoot state only — never user
   activity. "Last heard from you" is a separate line. The hoot speaks first
   person inside the bough; chrome speaks neutral third person; never both in
   one line.
8. **One accent, one meaning.** Amber (`color.*.accent`) = in motion or needs
   you: thinking pupils, sent/kept dots, noted chips, primary button. Idle
   awake and sleeping stay neutral ink. `color.*.quiet` (#B4441E) is the only
   alarm colour and never animates.
9. **Day digests are lazy.** Generated the first time a past day is viewed —
   no midnight job. A digest call sees only that day's items of that bough,
   never the pellet, never other hoots.
10. **"Late" is defined.** Fired more than 15 minutes after schedule = late.
    Catch-ups after the Mac sleeps are late, not missed. "Missed" requires an
    owner-apology note; capped at one per day, batched.
11. **New-hoot empty pellet slots are UI scaffolding** in v1 — fixed labels
    ("who you are", "what you're working on", "people who matter", "how you
    like to be nudged"), not pellet schema changes.
12. **Never seed a demo with invented memory.** Board personas (Juniper's
    Big Sur, Maya, Biscuit) are illustration only.
13. **Multi-hoot memory (decided before a second hoot ships):** facts carry
    `scope: hoot | global`. A hoot's context = its own pellet + global facts.
    Promotion to global is explicit only (user action or onboarding answers);
    hoots never auto-promote. The `scope` column ships with the facts work.

## Design tokens

`docs/design-tokens.json` (W3C draft format) is the source of truth for
colour, type, space, radius, motion, and component specs. Compiles to CSS
custom properties. Fonts are self-hosted (Space Grotesk / Inter / JetBrains
Mono, SIL OFL) — no external font CDN.
