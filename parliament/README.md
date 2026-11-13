# parliament

The web UI for Hoots: one hoot or a whole parliament, live over SSE.

React + Vite, served same-origin by the perch daemon (see `perch/src/server.ts`).
It holds no state of its own — every screen is a view over the REST + SSE API,
and the bough is the truth.

```bash
npm run dev -w parliament   # Vite on 5173, proxying 127.0.0.1:7420
npm run build -w parliament # what the daemon serves in production
```

Style comes only from `docs/design-tokens.json` (via `src/tokens.ts`); never
hardcode a colour or a spacing step. The boards in `docs/design/` are the source
of the interaction grammar, and `docs/DECISIONS.md` is binding.
