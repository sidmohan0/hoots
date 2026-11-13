# Hoots

Always-on personal agents ("hoots") that live on your own machine, remember
across sessions, check in on a schedule, and talk to you wherever you are.

## Pieces

- **perch** — the daemon. Always-on process that owns the ledger, runs turns
  against any OpenAI-compatible model endpoint, fires scheduled automations,
  and bridges chat channels. Serves the REST + SSE API.
- **parliament** — the web UI. One hoot or a whole parliament, live over SSE.

## Status

Pre-alpha. See `docs/SPEC.md` for the current design contract.

## Quick start

```bash
cp .env.example .env   # fill in model endpoint + telegram token
npm install
npm run dev -w perch
```

## License

MIT
