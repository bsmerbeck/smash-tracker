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

| id                          | target           | scale | measuredBy       | verdict                                                                           |
| --------------------------- | ---------------- | ----- | ---------------- | --------------------------------------------------------------------------------- |
| `engine-recompute-p95-8k`   | ≤100ms           | 8k    | automated        | **PASS** (synthetic: 3.2-4.3ms; real sparg0 account, 8,378 matches: 3.2-3.4ms)    |
| `engine-recompute-p95-50k`  | ≤400ms           | 50k   | automated        | **PASS** (synthetic: 21-28.5ms)                                                   |
| `filter-change-to-paint-8k` | ≤200ms           | 8k    | browser-protocol | **PASS** (scripted real-Chrome harness, synthetic 8k fixture: 69.6ms / 71.3ms)    |
| `heap-delta-50k`            | ≤150MB           | 50k   | browser-protocol | **PASS** (scripted real-Chrome harness, synthetic 50k fixture: 21.73MB / 21.79MB) |
| `matches-gzip-payload-8k`   | ≤1,500,000 bytes | 8k    | automated        | **PASS** (synthetic: 154,603 bytes; real sparg0 account: 200,083 bytes)           |

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

## Browser arm — scripted real-Chrome harness

`filter-change-to-paint-8k` and `heap-delta-50k` require a real browser (jsdom is never a
substitute, D-26). The manual DevTools protocol originally written was judged impractical (20
hand-timed recordings; its heap arm implied a signed-in 50k-game account, which does not and must
not exist per D-18). A SCRIPTED, real-Chrome measurement was built instead
(`apps/web/scripts/scl01BrowserBudget.mjs` + `perfFixturePlugin.mjs` + a DEV-ONLY perf harness
entry, `apps/web/perf-harness.html`/`src/perfHarness/`), needing no credentials and no production
data: it starts a real Vite dev server and real headless Chrome, mounts the REAL `MatchupsPage`
against `generateSyntheticMatches` fixtures with only the auth layer substituted by a fixed fake
value, and drives the same real interactions a user would. The harness is proven unreachable from
the production build by a committed guard (`perfHarnessProductionIsolation.guard.test.ts`, both a
fast static-import-graph check in the default suite and a real-`vite-build`-based check run
on demand) — see `36-06-SUMMARY.md` for the full transcripts. Command:
`pnpm --filter @smash-tracker/web run budget:browser`. Full sample sets and machine context are in
`36-SCL-01-PROTOCOL.md`'s Results block and `36-SCL-01-READOUT.md`.

**What this proves and does not prove:** real UI, real React commit/paint, the real shared engine,
real Chrome, over SYNTHETIC data at the stated scale — never sparg0's or any real account in a
browser (that would require production data in a browser, which D-20 forbids), and never a
minified production bundle (a Vite DEV server).

## Proven failing cases (D-26 — an oracle without a demonstrated failing case is not an oracle)

All four measured budgets (the two automated, plus the two browser-protocol) were each proven to
genuinely MISS and exit non-zero when their target was temporarily set to an absurd value, then
restored to the exact D-19 value and re-verified PASS:

| Budget id                   | Absurd target used | Observed                            | Exit     |
| --------------------------- | ------------------ | ----------------------------------- | -------- |
| `engine-recompute-p95-8k`   | 0.001ms            | `measured=3.48ms verdict=MISS`      | non-zero |
| `matches-gzip-payload-8k`   | 1 byte             | `measured=154603bytes verdict=MISS` | non-zero |
| `filter-change-to-paint-8k` | 0.001ms            | `measured=76.1ms verdict=MISS`      | non-zero |
| `heap-delta-50k`            | 0.001MB            | `measured=21.89MB verdict=MISS`     | non-zero |

Every restore was `diff`-confirmed against a pre-edit backup of `budgets.ts` before re-measuring.
Full transcripts in `36-06-SUMMARY.md`.

## FIXT-01 disposition — DECIDED

**Option A — FIXT-01 closes as NOT TRIGGERED. Plan 36-08 is not executed.**

- **Decider:** the owner (D-30 in `36-CONTEXT.md`, `[HUMAN]`-gated decision).
- **Date:** 2026-09-17.
- **MISS list:** empty — no budget missed in its final, restored, as-measured state.
- **Required recorded caveat:** the two browser-protocol budgets measure the REAL Matchups UI
  and the real shared evidence engine under real headless Chrome, but over SYNTHETIC data inside
  the DEV-ONLY perf harness — proven structurally absent from the production build — and are
  therefore **not** a measurement of the real sparg0 (or any real) account inside a browser. The
  real-account arm (engine-compute p95 and gzip-payload size, both budgets measured a second time
  directly against sparg0's actual 8,378-match export) carries no such caveat — that half of the
  evidence is against real production match data (via the owner's local, gitignored export file,
  never a live production read by this agent, D-20).
- **Commands that reproduce every number:** synthetic automated arms —
  `pnpm --filter @smash-tracker/shared build && pnpm --filter @smash-tracker/shared budget` and
  `... && pnpm --filter @smash-tracker/api budget`; real-account arm —
  `pnpm --filter @smash-tracker/api exec tsx scripts/sparg0RealDataReadout.ts --file apps/api/sparg0-export.json`;
  browser arm — `pnpm --filter @smash-tracker/web run budget:browser`; production-isolation guards —
  `pnpm --filter @smash-tracker/web test` (static half) and
  `pnpm --filter @smash-tracker/web run guard:perf-harness-build` (build-output half).

Plan 36-08 (the conditional FIXT-01 server-side aggregate build) is **not executed** — D-21's
speculative-build prohibition holds; no server-side aggregate endpoint exists anywhere under
`apps/api/src/routes/`.
