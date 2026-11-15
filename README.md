# TeamForge: race-proof hackathon team formation

Express + SQLite (single process, one file on a persistent disk), server-sent events for live updates, React UI. See DESIGN.md for the design and its limits.

```
npm ci && npm test                      # 53 tests: API, races (incl. 3 processes), kill-and-restart, event streams, UI submission logic
(cd web && npm ci && npm run build)     # React UI -> web/dist, served by the API
npm start                               # http://localhost:3000, database file ./data.db (override with DB_PATH)
```

- `SECRET` signs login tokens. If unset, a random one is generated at each start and everyone is signed out on restart.
- `node scripts/seed.js [db]` adds 10,000 users and 2,000 teams (all passwords `password123`, e.g. `u1@seed.io`). It writes to `DB_PATH` / `./data.db` unless you pass a path, so give it a separate file, not a database you care about.
- `node scripts/load.js [base-url]` runs 100 concurrent clients against `GET /board` and writes `LOAD_REPORT.md`; start the server on a seeded database first (`RATE_LIMIT=off`).
- Mutating routes accept an `Idempotency-Key` header. Live updates: `GET /events?topic=board` or `team:ID` (team streams are members-only and are closed when membership ends).
- `docker compose up --build` is provided but has not been run.
- Optional real-browser check, not in CI (needs Python, Playwright and Chromium; uses a temporary database and never touches `./data.db`): `python e2e/browser-check.py` after building the UI.
