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

## FIXT-01 disposition

**Still the owner's Task 5 decision (`gate="blocking-human"`) — this record states the evidence and
the recommendation, it does not itself decide.** All FIVE budgets now carry a real, traceable
measurement and all five PASS, several with wide margin. The plan's own recommended option given
this evidence is **A** (close FIXT-01 as not-triggered) — unlike a partial readout, option A's own
caveat about a NOT-MEASURED real-account arm does not apply, since every arm (synthetic,
real-account, and now browser) has been measured. This section will be updated with the owner's
actual chosen option, the date, and the (currently empty) list of MISS verdicts once Task 5
resolves.
