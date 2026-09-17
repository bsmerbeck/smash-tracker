# LIQ-01: Liquipedia research spike — page families, request budget, attribution

**Decision substrate:** whether NEW Liquipedia page families (beyond the shipped `*/VODs` family)
are reachable through the permitted MediaWiki API within the published terms, at what request cost,
and with what attribution — verified against real fetched samples, before any Phase 42 parser code
exists (D-22). Recorded during Phase 36 (Evidence Engine Foundation & Scale Gate), plan 36-07.

This is the TRACKED copy that survives a clean checkout (`.gitignore:24-27` ignores `.planning/`, an
explicit owner decision, 2026-07-21). The full working detail — every printed verdict/fingerprint
line, the owner's verbatim run output, and the discovery-fix iteration history — lives in
`.planning/phases/36-evidence-engine-foundation-scale-gate/36-LIQ-01-SPIKE.md`. Per-asset provenance
for any sample later committed to the fixture corpus lives in
`apps/api/src/liquipedia/__fixtures__/MANIFEST.md` — this record does not duplicate that table.
Contains no uid, no editor `user`/`comment` member, no email address, no Discord handle, and no
credential — only page titles, revision ids, byte counts, structural fingerprints (counts only),
timings, and dates.

## Status

**`player-results` — MEASURED, live API, three separate owner-run reruns (see iteration history
below).** **`tournament-results` and `other-entrant-brackets` — PENDING**: a discovery-mechanism
defect prevented either family from sampling a real page on every rerun so far; the fix (evidence-
tolerant token/fallback discovery, replacing an exact-suffix guess) is committed
(`apps/api/scripts/liqSpikeProbeCore.ts`) but has not yet been re-run against the live API. This
record will be updated with real tournament/bracket verdicts once that rerun lands — no verdict for
either family is stated here, on the guess, or inferred.

## Page families probed and the exact titles

| Family                   | Titles tried                                                                                                  | Mechanism                                    |
| ------------------------ | ------------------------------------------------------------------------------------------------------------- | -------------------------------------------- |
| `player-results`         | `Sparg0/Results`, `MkLeo/Results`, `Hungrybox/Results`, `IzAw/Results`                                        | Static, real, specific — no discovery needed |
| `tournament-results`     | Discovered via `list=allpages` under series-name prefixes (Genesis, Smash Summit, Battle of BC, CEO, Riptide) | PENDING — see Status                         |
| `other-entrant-brackets` | Discovered via `list=allpages` under each accepted tournament-results event page                              | PENDING — see Status                         |

Every request in every run was `action=query` only, through the shipped `LiquipediaClient` and the
shipped RTDB-backed distributed limiter — never a second transport, never a bypassed or widened
parse-class allowlist (D-22). No `action=parse`/`action=expandtemplates` request was ever issued by
this probe.

## `player-results` — wikitext-vs-generated classification (live API, real bytes)

| Title                                             | Revision id | Bytes | Verdict                 | Notes                                               |
| ------------------------------------------------- | ----------- | ----- | ----------------------- | --------------------------------------------------- |
| `Hungrybox/Results`                               | 536882      | 9,417 | **sufficient**          | Real prose/table content directly in wikitext       |
| `MKLeo/Results` (redirected from `MkLeo/Results`) | —           | 245   | **stub-generator-only** | Structural fingerprint below                        |
| `Sparg0/Results`                                  | —           | 248   | **stub-generator-only** | IDENTICAL structural fingerprint to `MKLeo/Results` |
| `IzAw/Results`                                    | —           | —     | **missing**             | No page exists under this title                     |

**Structural fingerprint for both stub-generator-only pages (identical, leak-free — counts only,
never a content excerpt):**

```
templates{{=7 links[[=0 pipes|=9 lines=11 startsWithRedirect=false firstTemplate="ResultsPageHeader"
```

**API-reported redirect (surfaced, never guessed):** `MkLeo/Results` → `MKLeo/Results`.

### Finding: generated results pages need `action=parse` or LPDB, not plain wikitext

`MKLeo/Results` and `Sparg0/Results` are both template-driven: seven template transclusions, zero
internal links, the first template named `ResultsPageHeader` — the same generator shape already
confirmed for the shipped `*/VODs` family (`{{ResultsPageHeader}}\n{{Player vod list}}`), just with a
different downstream template. Their placements/results are NOT present as plain wikitext text; a
parser would need either a deliberate, anchored `action=parse`/`action=expandtemplates` allowlist
addition (30-second parse-class budget, D-22 — never a bypass, never applied by this spike) or
LiquipediaDB (LPDB) access to read the underlying structured data. `Hungrybox/Results`, by contrast,
carries real prose/table content directly in its wikitext at 9,417 bytes — no parse-class request
needed for that shape.

### Finding: coverage is inconsistent across the four demo players

Of the four tracked demo accounts, `player-results` coverage is: one player with directly-readable
wikitext content (`Hungrybox`), two players with a template-driven stub requiring `action=parse`/LPDB
(`MKLeo`, `Sparg0`), and one player with no page at all (`IzAw`) — consistent with the existing
`*/VODs` corpus's own honest-zero finding for `IzAw` (`apps/api/src/liquipedia/__fixtures__/
MANIFEST.md`: "IzAw has no Liquipedia subpages at all"). Any cross-player evidence surface (LIQ-04,
Phase 42) must treat Liquipedia coverage as per-player and partial, never assume uniform availability
across tracked accounts.

## Request budget observed under the shared limiter (live API)

| Metric                                                    | Observed                                                                                                          | Requirement                                                                                       |
| --------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| General-class requests issued                             | 6                                                                                                                 | ≤ `LIQ_SPIKE_MAX_GENERAL_REQUESTS` (20)                                                           |
| Parse-class requests issued                               | 0                                                                                                                 | Always 0 — this probe never issues one                                                            |
| Budget exhausted                                          | false                                                                                                             | —                                                                                                 |
| Minimum observed general-class request-START spacing      | **2,000 ms**                                                                                                      | ≥ 2,000 ms (`LIQUIPEDIA_GENERAL_MIN_INTERVAL_MS`) — **compliant, exactly at the published floor** |
| Minimum observed general-class request-COMPLETION spacing | 1,725 ms (secondary/informational only — conflates network latency with limiter spacing; not a compliance figure) | —                                                                                                 |

## The D-29 limiter defect, fix, and reach

**Defect (found by this spike's first live run):** the shared `LiquipediaLimiter`
(`apps/api/src/liquipedia/limiter.ts`) stamped its durable RTDB budget timestamp from the clock read
**before** the RTDB transaction round-trip, then returned to the caller as soon as the transaction
committed — with no wait to align the caller's actual dispatch to that stamp. A real transaction's
round-trip latency varies (a cold RTDB connection commonly costs roughly a second; a warm one tens of
milliseconds); when latency dropped between two consecutive acquisitions, the REAL spacing between
the two actual HTTP dispatches shrank below the published interval even though both durable stamps
were correctly ≥2,000 ms apart. Reproduced live: two requests measured 908 ms apart (required
≥2,000 ms).

**Fix:** the limiter now reserves the earliest legal slot unconditionally, then either sleeps or
best-effort repairs the durable stamp so its own RESOLUTION never precedes that slot; a second, local
(per-instance, per-budget-path) precision cache closes a further non-convergence gap discovered while
proving the repair-only approach insufficient (a repair transaction has its own nonzero latency, so
chasing it with more repairs never converges under constant latency). Proven by induction and by 18
tests (7 new) covering decreasing/increasing/random latency profiles, an extreme single-latency
overshoot, and the parse-class two-budget composition. Confirmed against the live API on this
record's rerun: `minObservedGeneralStartSpacingMs=2000` exactly, no violation.

**Reach:** `apps/api/src/liquipedia/limiter.ts` gates every outbound Liquipedia call in this
codebase — not only this spike probe, but also the production `apps/api/scripts/
enrichDemoAccounts.ts` enrichment CLI. The fix applies to both callers; no separate fix was needed
for the enrichment CLI.

**Residual, unaffected risk (pre-existing, documented in `limiter.ts`'s own module doc comment,
unchanged by this fix):** cross-PROCESS clock skew. The durable RTDB stamp guarantees serialization
across processes but not real-time spacing across DIFFERENT processes' clocks; this spike and the
enrichment CLI both run from one process at a time, so the assumption holds for both today. The named
follow-up (a server-relative clock) remains open and out of scope for this record.

## Attribution requirement (CC-BY-SA)

Liquipedia's published terms of use require CC-BY-SA attribution on any displayed content
[CITED: `https://liquipedia.net/api-terms-of-use`, fetched during Phase 36 research]. The shipped
client already carries the two pieces this obliges: a descriptive, contact-bearing User-Agent on
every request (`createLiquipediaClient` in `apps/api/src/liquipedia/client.ts`), and a mechanical
article-URL builder (`buildLiquipediaPageUrl`, derived from the wiki's own `articlepath` convention)
for constructing a human-readable attribution link from any page title. Any Phase 42 display surface
that shows a Liquipedia-sourced fact MUST show a source name and link built this way — this spike
does not change that obligation, it only confirms which page families exist to attribute.

## What Phase 42 may and may not build on this record

**May:** treat `player-results` coverage as confirmed non-uniform across the four demo accounts (see
Finding above); treat `Hungrybox/Results` as directly parseable from wikitext without any allowlist
change; treat `MKLeo/Results`/`Sparg0/Results` as requiring a DELIBERATE, anchored parse-class
allowlist addition (never a bypass) OR LPDB access before their placements can be read; rely on the
D-29 limiter fix as already applied and tested for any future Liquipedia caller.

**May not, yet:** assume anything about `tournament-results`/`other-entrant-brackets` page naming,
structure, or reachability — that evidence is PENDING (see Status). Widen or bypass
`LIQUIPEDIA_PARSE_CLASS_ALLOWLIST` — no anchored regex proposal has been recorded for any real page
in this spike as of this writing (the `MKLeo/Results`/`Sparg0/Results` shape would propose
`^[^/]+/Results$` if a future plan deliberately extends the allowlist, but that decision belongs to
Phase 42, not this spike). Assume LPDB access — see the submission field below.

## LiquipediaDB (LPDB) access request

Per the published terms of use [CITED, as above], LPDB access is granted "upon approved request,"
with further documentation available only after logging into the LPDB Dashboard, and requests are
directed to Liquipedia's Discord. The exact review process, turnaround time, and Dashboard contents
beyond that are UNVERIFIED — this record does not invent them. Claude drafted the request text
(`.planning/phases/36-evidence-engine-foundation-scale-gate/36-LPDB-REQUEST.md`); the OWNER submits
it under their own identity. Phase 36 cannot be marked complete on LIQ-01 until the date below is
filled.

**Submission date:** _(blank — filled by the owner's Task 4 reply once submitted)_
