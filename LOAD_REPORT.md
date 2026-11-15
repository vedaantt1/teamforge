# Load report: GET /board (limit=50)

- Concurrency: 100 virtual users, keep-alive, 15s, random pagination offsets
- Dataset: 10,000 users / 2,000 teams
- Requests: 26161 (1739 req/s), status codes: {"200":26161}
- Latency ms: p50 52.0, p90 69.6, **p95 76.8**, p99 102.1, max 2068.3
- Target p95 < 200 ms: **PASS**

## Methodology and caveats

- Client: scripts/load.js (Node http, keep-alive). Server: one Node process, SQLite file (WAL), seeded by scripts/seed.js; started with RATE_LIMIT=off.
- Client and server ran on the same machine over loopback, so numbers exclude real network latency and TLS and share CPU with the load generator.
- Read path only (GET /board, limit=50, varying `after` offsets). Join/accept write storms are not benchmarked here; races are covered by the test suite, not by this load run.
- Local result only: this is not a measurement of any deployed service.

## Run details

- Measured once, on the code that excludes full teams in the board query itself (an earlier run, before that change, gave p95 76.6 ms under the same conditions).
- Environment: a 1-vCPU Linux container; Node 22; fresh seed (4,958 memberships, 1,530 teams on the board in this seed; the seed is randomized).
- The max latency (2068.3 ms) is far above p99 (102.1 ms). It is probably connection warm-up, but that was not investigated.
- Not measured: any deployed service, other hardware, TLS, or a write storm.
