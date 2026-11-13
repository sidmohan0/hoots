# Contributing

Thanks for poking at Hoots. It is a small, opinionated codebase, and the best
contributions keep it small and opinionated.

## Setup

Requires Node 22 or newer (`.nvmrc` pins it) and a C toolchain for
`better-sqlite3`.

```bash
npm ci
cp .env.example .env      # set OPENAI_API_KEY (any OpenAI-compatible endpoint works)
npm run dev               # perch on 127.0.0.1:7420
npm run dev -w parliament # optional: Vite UI on 5173, proxying the perch
```

`PERCH_DATA_DIR` selects the data directory (default `~/.hoots`). Point it at a
temp dir to keep an experiment out of your real ledger.

## Architecture in ten lines

- **perch** (`perch/`) is a loopback-bound Fastify daemon. It owns everything:
  the SQLite ledger, the turn loop, the scheduler, the SSE bus.
- **parliament** (`parliament/`) is a React/Vite UI served by the daemon
  same-origin. It is a view; it holds no state of its own.
- **SQLite** at `$PERCH_DATA_DIR/perch.db` is the source of truth: hoots,
  threads, turns, items, automations, facts, outbound ledger. Append-heavy,
  single writer.
- A **turn** is one model invocation cycle, serialized per thread by a DB claim
  on the turns table.
- The **pellet** is the rolling memory summary; the **facts** table carries
  `scope: hoot | global`.
- **Heralds** (`perch/src/herald-telegram.ts`) bridge chat channels: inbound
  message → turn, outbound hoot message → every bound channel.
- The **scheduler** fires automations from RFC 5545 RRULEs, timezone-correct,
  and coalesces missed fires on boot.
- The **outbound ledger** records every request that leaves the machine. A
  destination with no ledger row is a bug.
- The UI speaks REST + SSE only. Progress arrives as `item.append` events; slow
  thinking is designed around, not hidden.
- Two rules hold it together: **never block the composer** and **the bough is
  append-only**.

## Vocabulary budget

`docs/DECISIONS.md` #2 is binding: **three coined words** — *hoot*, *bough*,
*pellet*. In UI copy, hunts are "tasks", heralds are their channel name
("Telegram"), automations are "promises". Engineering-layer names (`thread`,
`turn`, `item`, `automation`, `channel`) stay boring and never inherit the
whimsy. `docs/SPEC.md` §8 lists reserved words; don't repurpose them.

## Design changes

**A design change needs a board or a `docs/DECISIONS.md` entry.** Locked
decisions are not relitigated in PRs — amend the doc instead. If your change
touches presence grammar, the accent rule, the composer, the memory surface, or
anything in the vocabulary budget, say so in the PR and link the decision.

## Tests

```bash
npm test                  # vitest, all workspaces
npm test -w perch         # one workspace
npm run typecheck         # tsc --noEmit in both workspaces; CI gates on this
```

Add a test with every behaviour change. Tests run against a throwaway
`PERCH_DATA_DIR` and never call a real model — stub `runTurn` or assert on the
DB.

## Commits

Imperative mood, area prefix, one concern per commit:

```
perch: queue turns instead of 409 when the thread is busy
parliament: fold day separators lazily
docs: record the late/missed distinction
```

Keep the subject under ~72 characters; put the *why* in the body.

## PR checklist

- [ ] The change serves a principle in `docs/DECISIONS.md` (name it)
- [ ] Tests added or updated; `npm test` passes
- [ ] `npm run typecheck` passes
- [ ] A design board or DECISIONS entry exists if the UI or vocabulary changed
- [ ] No new coined words; no new dependency without a reason in the description

### DCO

Sign off every commit — `git commit -s` adds the line, which certifies you wrote
the patch or have the right to submit it:

```
Signed-off-by: Your Name <you@example.com>
```

## Good first issues

Issues labelled `good first issue` are scoped to one file or one component and
have their acceptance criteria written out. Good hunting grounds: a herald for a
new channel, digest typography, keyboard traps, scheduler edge cases (DST
boundaries, UNTIL handling), and empty states.

## Adding a herald

A herald is one file with two halves:

- **inbound** — receive a channel message, map its external id to a `channels`
  row, and call `startTurn({ threadId, trigger: "channel", message, surface })`.
  Replies route back to the originating surface, so pass the surface through.
- **outbound** — subscribe to outbound item deliveries for hoots that have a
  channel row of your kind and call the provider API. Log every send through
  `logOutbound()` so the footer count stays honest.

Register it from `perch/src/index.ts`, keep credentials in an env var read by
`config.ts`, and leave the token unset ⇒ herald disabled. Document the required
env vars in `.env.example`.

## Dogfooding

The maintainer runs Hoots as their daily driver: every change ships into a live
ledger before it is announced. Regressions show up as a bad day, not a failing
test, so rough edges in real use are fair game for issues.

## License

Contributions are MIT, under the same terms as `LICENSE`.
