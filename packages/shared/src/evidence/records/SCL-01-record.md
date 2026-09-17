# SCL-01: Scale measurement gate — budgets, verdicts, FIXT-01 disposition

**Decision substrate:** the five written SCL-01 budgets (D-19), measured against both a synthetic
8k/50k fixture and sparg0's real production account, feeding the D-27 FIXT-01 trigger decision.
Recorded during Phase 36 (Evidence Engine Foundation & Scale Gate), plan 36-06.

This is the TRACKED copy that survives a clean checkout (`.gitignore:26` ignores `.planning/`).
The full working detail — every command, both full run transcripts, and the browser protocol —
lives in `.planning/phases/36-evidence-engine-foundation-scale-gate/36-SCL-01-READOUT.md` and
`36-SCL-01-PROTOCOL.md`.

## The rules these budgets live under (restated here — D-19)

These five targets were written into `packages/shared/src/evidence/budgets.ts` **before any
measurement was taken**. A later change may **tighten** a target but must **never loosen** one to
make a miss disappear. The `SCL_01_BUDGETS` array is **append-only**: a later plan may append a new
budget id (plan 36-08 appends `server-heap-delta-50k` under this exact rule) but may never edit or
remove an existing entry. The array's declared order is the order this record and the readout
render every budget in, so two readouts stay diffable.

## The five budgets, their instrument, and their verdict

| id                          | target           | scale | measuredBy       | verdict                                                                        |
| --------------------------- | ---------------- | ----- | ---------------- | ------------------------------------------------------------------------------ |
| `engine-recompute-p95-8k`   | ≤100ms           | 8k    | automated        | **PASS** (synthetic: 3.2-4.3ms; real sparg0 account, 8,378 matches: 3.2-3.4ms) |
| `engine-recompute-p95-50k`  | ≤400ms           | 50k   | automated        | **PASS** (synthetic: 21-28.5ms)                                                |
| `filter-change-to-paint-8k` | ≤200ms           | 8k    | browser-protocol | **NOT MEASURED** — pending owner/Codex-UAT browser run                         |
| `heap-delta-50k`            | ≤150MB           | 50k   | browser-protocol | **NOT MEASURED** — pending owner/Codex-UAT browser run                         |
| `matches-gzip-payload-8k`   | ≤1,500,000 bytes | 8k    | automated        | **PASS** (synthetic: 154,603 bytes; real sparg0 account: 200,083 bytes)        |

Every target above was re-verified against `packages/shared/src/evidence/budgets.ts`'s current
source at the time this record was written and matches D-19's value exactly — none was edited.

## Real-account arm (sparg0)

Obtained via the owner-run, read-only, structurally-write-free export
(`apps/api/scripts/sparg0Export.ts`, D-20) — the owner ran it under their own ADC; this agent never
read production. The export's own receipt (never committed — `apps/api/sparg0-export*.json` is
`.gitignore`d, D-28):

- match count: **8,378**
- matches sha256: `7f56f0374af6cc6e9cc1026212ea3571872c89533741a0c1bb03aed5b5636869`
- database host: `smash-tracker-f97b7.firebaseio.com`

The engine-compute and gzip-payload budgets were then measured against this real file using a new,
tracked, unit-tested harness (`apps/api/scripts/sparg0RealDataReadout{,Core}.ts`, 9 tests in
`sparg0RealDataReadoutCore.test.ts`, unit-tested against synthetic fixtures/files — never real
content). The harness reads the local, `.gitignore`d export file (a local file read, not a
production read — D-20) and prints AGGREGATE NUMBERS ONLY. No match row, opponent tag, uid, slug,
or tournament name from that file appears anywhere in this record, the readout, the harness source,
its tests, or any reply.

**Shape aggregates (EVID-01/EVID-11, counts only, no content):**

- Distinct (my-fighter × opponent-fighter) pairs: **672**
- Pairs clearing the 3-game abstention floor: **422**
- Pairs abstaining (below the floor): **250**
- Games in the unknown-stage bucket: **2,080** of 8,378 (24.8%)
- Known-stage-field coverage: **75.17%**
- Unknown-character games: **0** (matches the D-25 expectation — no live ingestion path produces one)

## Never-measured arm

`filter-change-to-paint-8k` and `heap-delta-50k` require a real browser (jsdom is never a
substitute, D-26) and have not yet been provided. The written protocol
(`36-SCL-01-PROTOCOL.md`) is ready; this record will be updated once either arm B is completed or
the owner explicitly waives it.

## FIXT-01 disposition

**Pending — Task 5's owner `checkpoint:decision`.** Every AUTOMATED budget (both engine-compute
scales, the gzip payload budget) PASSED cleanly, including against sparg0's real 8,378-match
account measured directly. Two BROWSER-PROTOCOL budgets remain genuinely unmeasured. This section
will be updated with the chosen option (A/B/C), the decider, the date, and the list of MISS
verdicts (currently none) once Task 5 resolves.
