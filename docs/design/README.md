# Parliament — design boards (v2)

The boards that fix Parliament's vocabulary, presence grammar, and interaction
rules. Read them before proposing a UI change; the decisions they produced are
locked in `docs/DECISIONS.md`.

Parliament design: [ask user for names later], boards v2.

| Board | What it settles |
|---|---|
| `01 · Principles + answers (rev 2).png` | The "we will / we won't" list and answers to the brief's questions |
| `02 · What we'd push back on.png` | Where the brief was wrong, and what replaces it |
| `03 · IA sketch.png` | One view, two drawers; what the sidebar and ⌘K overlay contain |
| `04A · Almanac (diary).png` | Day-folded diary reading of a bough |
| `04B · Perch — v1 base (dark).png` | The base hoot screen: presence glyph, composer, machine footer |
| `04C · Correspondence — later, as weekly digest.png` | Digest direction, kept for later |
| `05 · Promises (automations).png` | Promises: today-strip, kept/late/missed states |
| `06 · Parliament + new-hoot empty state.png` | Multiple hoots, hatching a new one, empty pellet slots |
| `07 · Live updates + Telegram continuity.png` | Slow thinking, queued chips, arriving-from-Telegram continuity |

`design-tokens.json` (W3C design tokens draft) sits next to the boards so the
set is self-contained; the canonical copy is `../design-tokens.json`, and it
compiles to CSS custom properties via `parliament/src/tokens.ts`.

Rules that come from these boards: presence glyph encodes daemon state only,
amber means "in motion or needs you", quiet red is the only alarm colour, day
digests are lazy, and no demo memory is ever seeded. See `docs/DECISIONS.md`
for the full list.
