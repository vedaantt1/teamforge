# TeamForge: design (one page)

**Shape.** One Node 22 process (Express) and one SQLite file in WAL mode on a *persistent disk*; a React UI; live updates over server-sent events (SSE). **Status:** verified locally only. 53 automated tests pass, a separate real-browser script (not in CI) passes its checks against the built UI, and one local read-path load run is in `LOAD_REPORT.md`. It is not deployed and the GitHub CI workflow has not run.

**Data model.** `users` · `teams(leader_id, invite_code UNIQUE, invite_expires, looking, locked)` · `members(PRIMARY KEY(hackathon_id, user_id), team_id)` · `requests` (one pending per user per team) · `idempotency(PRIMARY KEY(user_id, key), status, body)` · `audit(ts, actor, team, action, detail)`. Invariants live in the schema: the primary key is "one team per person", and a `BEFORE INSERT` trigger is "never over max size".

**Races.** Every change runs in one `BEGIN IMMEDIATE` transaction, so the write lock is taken *before* the capacity read and check-then-insert cannot interleave, across requests or processes. One function (`addToTeam`) takes every seat, whether by invite code or by leader approval. Tests: a 50-way last-seat race, a 60-way race across three processes on one file, repeated rounds, and a SIGKILL-and-restart integrity check. Removing the capacity check and the trigger makes the race tests fail.

**Idempotency and the one-team rule protect different cases.** A same-key replay answers *a retry of the same request* (double click, lost reply). It returns the original result even if state has since changed, and it is recorded in the same transaction as the effect, so a crash cannot split them. The primary key answers *different requests* by the same person (a new key, a second tab, an invite join versus an approved request): the second insert fails. Neither replaces the other. The client keeps one key per logical action, reuses it only after an uncertain failure with an identical payload, and after an ambiguous result asks the server for the person's real membership before reporting an outcome.

**Live updates.** Events are queued during a transaction and sent after COMMIT. The board stream is public to signed-in users. A team stream is re-authorised at every delivery: a subscriber who is no longer a member receives one content-free `membership_ended` event and the stream is closed. This covers removal, leaving and team deletion, and is tested with real streams. Full teams are excluded by the board query itself, and unlocking a full team does not list it.

**Security.** Signed 12-hour tokens, scrypt passwords, server-side leader checks on every mutating team route, validation on all input, parameterised SQL. Invite codes are 50 bits, expire in 24 hours and are rotatable; joins are rate-limited per user and per IP.

**Suggestions.** `score = 0.65 × skillComplement + 0.35 × timezoneFit`. *skillComplement* is the share of the candidate's skills the team lacks; *timezoneFit* is 1 − circular distance to the team's mean offset ÷ 12 h. Each result returns its breakdown.

**Known limits.**

- *Single process, persistent disk.* SQLite has one writer, so several app instances on one shared disk are not supported. Rate limits and the SSE hub live in memory: correct per process only, and reset on restart. EventSource passes the token in the URL, and an open stream is not re-checked when its token expires.
- Minimum size is enforced when a team is locked. A reconnecting client re-syncs; events missed while offline are not replayed.
- An idempotency key is not bound to its payload or route; the UI never reuses a key across payloads, but another client could.
- Any signed-in user can read any team's roster and skills. This was left as is; no privacy policy has been decided.
- A requester cannot learn that a request was declined (no per-user event or status). The join response can report `looking: true` for a team the join just filled; `GET /teams/:id` is correct.

**With another week.** Postgres (`SELECT … FOR UPDATE`, same constraints) behind several instances; Redis for rate limits and fan-out; key fingerprints and expiry; a per-user event channel; cookie sessions; the browser script in CI; a join-storm load test (only the read path is benchmarked).
