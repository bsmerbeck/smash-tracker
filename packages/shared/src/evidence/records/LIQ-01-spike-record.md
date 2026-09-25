# LIQ-01: Liquipedia research spike — page families, request budget, attribution

**Decision substrate:** whether NEW Liquipedia page families (beyond the shipped `*/VODs` family)
are reachable through the permitted MediaWiki API within the published terms, at what request cost,
and with what attribution — verified against real fetched samples, before any Phase 42 parser code
exists (D-22). Recorded during Phase 36 (Evidence Engine Foundation & Scale Gate), plan 36-07.

This is the TRACKED copy that survives a clean checkout (`.gitignore:24-27` ignores `.planning/`, an
explicit owner decision, 2026-07-21). The full working detail — every printed verdict/fingerprint
line, the owner's verbatim run output, and the four-rerun iteration history — lives in
`.planning/phases/36-evidence-engine-foundation-scale-gate/36-LIQ-01-SPIKE.md`. Per-asset provenance
for the samples committed to the fixture corpus lives in
`apps/api/src/liquipedia/__fixtures__/MANIFEST.md` — this record does not duplicate that table.
Contains no uid, no editor `user`/`comment` member, no email address, no Discord handle, and no
credential — only page titles, revision ids, byte counts, structural fingerprints (counts only),
timings, and dates.

## Status

**All three families — MEASURED, live API (owner rerun #4, 2026-09-17; `player-results` also
confirmed across two earlier reruns).** `player-results` and `other-entrant-brackets` are reachable
as stored wikitext via `action=query`, within budget, for the samples this spike drew. See the two
findings below, and the "early-edition sampling" limitation, before treating any of this as
representative of the Ultimate-era page shape Phase 42 actually needs.

## Page families probed and the exact titles

| Family                   | Titles tried                                                                                                  | Mechanism                                                      |
| ------------------------ | ------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------- |
| `player-results`         | `Sparg0/Results`, `MkLeo/Results`, `Hungrybox/Results`, `IzAw/Results`                                        | Static, real, specific — no discovery needed                   |
| `tournament-results`     | Discovered via `list=allpages` under series-name prefixes (Genesis, Smash Summit, Battle of BC, CEO, Riptide) | Evidence-tolerant token match + "most recent-looking" fallback |
| `other-entrant-brackets` | Discovered via `list=allpages` under each accepted `tournament-results` event page                            | Evidence-tolerant token match + "first subpage" fallback       |

Every request in every run was `action=query` only, through the shipped `LiquipediaClient` and the
shipped RTDB-backed distributed limiter — never a second transport, never a bypassed or widened
parse-class allowlist (D-22). No `action=parse`/`action=expandtemplates` request was ever issued by
this probe.

## `player-results` — wikitext-vs-generated classification (live API, real bytes)

| Title                                             | Revision id | Bytes | Verdict                 | Notes                                               |
| ------------------------------------------------- | ----------- | ----- | ----------------------- | --------------------------------------------------- |
| `Hungrybox/Results`                               | 536882      | 9,417 | **sufficient**          | Real prose/table content directly in wikitext       |
| `MKLeo/Results` (redirected from `MkLeo/Results`) | 344697      | 245   | **stub-generator-only** | Structural fingerprint below                        |
| `Sparg0/Results`                                  | 294596      | 248   | **stub-generator-only** | IDENTICAL structural fingerprint to `MKLeo/Results` |
| `IzAw/Results`                                    | —           | —     | **missing**             | No page exists under this title                     |

**Structural fingerprint for both stub-generator-only pages (identical, leak-free — counts only,
never a content excerpt):**

```
templates{{=7 links[[=0 pipes|=9 lines=11 startsWithRedirect=false firstTemplate="ResultsPageHeader"
```

**API-reported redirect (surfaced, never guessed):** `MkLeo/Results` → `MKLeo/Results`.

### Finding: generated results pages need `action=parse` or LPDB, not plain wikitext

`MKLeo/Results` and `Sparg0/Results` are both template-driven: seven template transclusions
(`{{ResultsPageHeader}}` plus per-game `{{Tabs dynamic}}`/`{{AchievementTableSMW}}` calls), zero
internal links, the first template named `ResultsPageHeader` — the same generator shape already
confirmed for the shipped `*/VODs` family, just with a different downstream template. Their
placements/results are NOT present as plain wikitext text; a parser would need either a deliberate,
anchored `action=parse`/`action=expandtemplates` allowlist addition (30-second parse-class budget,
D-22 — never a bypass, never applied by this spike) or LiquipediaDB (LPDB) access to read the
underlying structured data — see the LPDB section below for why the latter is now the recommended
route. `Hungrybox/Results`, by contrast, carries real prose/table content directly in its wikitext at
9,417 bytes — no parse-class request needed for that shape.

### Finding: coverage is inconsistent across the four demo players

Of the four tracked demo accounts, `player-results` coverage is: one player with directly-readable
wikitext content (`Hungrybox`), two players with a template-driven stub requiring `action=parse`/LPDB
(`MKLeo`, `Sparg0`), and one player with no page at all (`IzAw`) — consistent with the existing
`*/VODs` corpus's own honest-zero finding for `IzAw` (`apps/api/src/liquipedia/__fixtures__/
MANIFEST.md`: "IzAw has no Liquipedia subpages at all"). Any cross-player evidence surface (LIQ-04,
Phase 42) must treat Liquipedia coverage as per-player and partial, never assume uniform availability
across tracked accounts.

## `tournament-results` — discovery outcome and classification (live API, real bytes)

Discovery seeded from `LIQ_SPIKE_SERIES_PREFIX_SEEDS` (Genesis, Smash Summit, Battle of BC, CEO,
Riptide) via `list=allpages`. **No discovered title anywhere carried an "Ultimate" token** — every
prefix's acceptance fell through to the `fallback-latest` rule (highest trailing number in the
title). See the limitation below for why.

| Series prefix  | Discovered | Accepted title   | Reason            | Revision id | Bytes | Notes                                                             |
| -------------- | ---------- | ---------------- | ----------------- | ----------- | ----- | ----------------------------------------------------------------- |
| `Genesis`      | 9          | `Genesis 10`\*   | `fallback-latest` | 522235      | 1,405 | \*API-redirected to `GENESIS/X` before fetch (see redirect note)  |
| `Smash Summit` | 10         | `Smash Summit/1` | `fallback-latest` | 504430      | 8,300 | `prizePoolCount=28` template invocations                          |
| `Battle of BC` | 10         | `Battle of BC/1` | `fallback-latest` | 507803      | 1,059 | 2016 event; Melee + Wii U — see fixture corpus                    |
| `CEO`          | 10         | `CEO/2014`       | `fallback-latest` | 526291      | 776   | Smallest tournament-results sample                                |
| `Riptide`      | 10         | _(none)_         | _(none)_          | —           | —     | See "per-family accepted-title cap" note below — NOT a "no match" |

**API-reported redirect:** `Genesis 10` → `GENESIS/X` (both `tournament-results` and
`other-entrant-brackets` families followed this redirect for the same source title).

**Per-family accepted-title cap, not a discovery failure:** `LIQ_SPIKE_MAX_TITLES_PER_DISCOVERY_FAMILY`
is 4. By the time discovery reached the `Riptide` prefix (processed last), the family had already
accepted 4 titles from the first four prefixes, so the fallback picker never ran against Riptide's own
10 discovered titles (which DID include `Riptide/2021` and several 2021 subpages — visible in the
working record's full discovery dump). This is a budget-governance behavior working as designed, not
evidence that Riptide lacks a tournament page.

### Finding: sampled tournament pages are ALL early editions — this wiki's naming convention for the Ultimate era is INFERRED, not verified

`list=allpages` returns results in alphabetical/lexicographic title order, capped at the MediaWiki
default page-size (observed: 9-10 results per call); the shipped `LiquipediaClient.listSubpages` sets
no `aplimit`, so only the FIRST page of alphabetically-earliest titles under each prefix is ever seen.
For a series that has run many editions, the earliest-numbered/earliest-dated editions sort first,
which is exactly what every accepted title above is: `CEO/2014` (CEO's earliest listed edition, not
its most recent), `Battle of BC/1` (its first, 2016, Melee/Wii U-era event, not any later Ultimate
edition), `Smash Summit/1`, and `Genesis 10`/`GENESIS/X` (an early-numbered Genesis, not the most
recent one at spike time). **None of these are confirmed Ultimate-era pages** — this spike samples
plausible-looking evidence pages, not the pages a real Ultimate-focused parser would target. The
observed naming pattern (`Series/<edition>`, with per-game sub-branches like `Series/<edition>/Melee`
or `Series/<edition>/Wii U`) STRONGLY IMPLIES a parallel `Series/<edition>/Ultimate` page exists for
editions run during the Ultimate era, but this is an INFERENCE from the shape of adjacent pages, not
a page this spike actually fetched. **Phase 42 must confirm this with a targeted fetch of a
known-Ultimate-era title before building any parser against it.**

## `other-entrant-brackets` — discovery outcome and classification (live API, real bytes)

Discovery ran `list=allpages` under each ACCEPTED `tournament-results` title, preferring a "Bracket"
token match (extra preference for one that ALSO contains "Singles"), falling back to the first
returned subpage.

| Under event title | Discovered                              | Accepted title(s)                                                              | Reason(s)                      | Revision id(s) | Bytes         |
| ----------------- | --------------------------------------- | ------------------------------------------------------------------------------ | ------------------------------ | -------------- | ------------- |
| `Genesis 10`      | 1                                       | `GENESIS/X`                                                                    | `fallback-first-subpage`       | 522235         | 1,405         |
| `Smash Summit/1`  | 10                                      | `Smash Summit/1/Singles Bracket`                                               | `bracket-token-singles`        | 329345         | 24,632        |
| `Battle of BC/1`  | 9                                       | `Battle of BC/1/Melee/Singles Bracket`, `Battle of BC/1/Wii U/Singles Bracket` | `bracket-token-singles` (both) | 298570, 534568 | 20,210, 7,302 |
| `CEO/2014`        | _(not reached — budget cap, see below)_ |                                                                                |                                |                |               |

**`GENESIS/X`'s "bracket" sample is a duplicate, not a real bracket page.** `list=allpages` under a
redirect SOURCE title (`Genesis 10`) does not follow the redirect before listing — it matched only the
source title itself (its own listing entry), so the "first subpage" fallback selected `Genesis 10`,
which the client then resolved through the SAME redirect to `GENESIS/X` (identical revision id and
byte count as the tournament-results sample above) — not a distinct bracket page. **Phase 42 must run
subpage discovery against the REDIRECT TARGET, not the source title,** or repeat this exact
duplicate-fetch defect. `CEO/2014`'s bracket discovery was never attempted: the family's request
budget was governed by `LIQ_SPIKE_RESERVED_DISCOVERY_REQUESTS`/`LIQ_SPIKE_RESERVED_FETCH_REQUESTS` per
accepted event, and only 3 of the 4 accepted `tournament-results` titles fit inside the family's
20-request-shared budget on this run (see the budget table below) — a real budget-exhaustion
governance outcome, not a bug.

### Finding: this wiki's real bracket-structure template names

The `computeBracketTemplateCounts` fingerprint matcher shipped with the FIRST version of this probe
required a template name to literally START with "Bracket" or "Match" (`{{Bracket...}}`,
`{{Match...}}`) — a guess never checked against real bytes. All bracket pages sampled on this run
reported `Bracket=0 Match=0`, an implausible result on 7-25 KB bracket pages that the owner caught
live. The REAL template names this wiki uses carry those words as a SUBSTRING, not a prefix:
`BracketMatchDetails` (the match wrapper — 21-30 uses per page), and shape-specific bracket
structure templates `32DEWBracketA`, `64DELBracketSmwA`, `DEFinalSmwBracket`, and siblings. No
`match2`/`TeamCard` markup was found anywhere in any real sample on this wiki — that template family
belongs to OTHER Liquipedia wikis (e.g. Dota2, League of Legends), not this one. The matcher was fixed
(`apps/api/scripts/liqSpikeProbeCore.ts`, `fix(36-07)` commit) to match these words as a
case-insensitive substring anywhere in a template's name, excluding page-transclusion syntax
(`{{:Page Name}}`, which embeds a whole separate page rather than calling a template) — verified
offline against the owner's saved report bytes, never against a new live request.

## Request budget observed under the shared limiter (live API, across all owner runs)

| Run                                                                | General requests       | Parse-class | Budget exhausted | Min observed START spacing    | Notes                                                                                                          |
| ------------------------------------------------------------------ | ---------------------- | ----------- | ---------------- | ----------------------------- | -------------------------------------------------------------------------------------------------------------- |
| #1 (first live run)                                                | Unknown — not reported | 0           | Unknown          | 908 ms (VIOLATION — pre-D-29) | Failed at the write step (ENOENT); the D-29 defect and Melee-era discovery waste were both first observed here |
| #2 (post fixes A/B/C/D)                                            | Unknown — not reported | 0           | 20 (exhausted)   | 908 ms (VIOLATION — pre-D-29) | Exited non-zero on the (new) spacing check; no report written                                                  |
| #3 (post D-29 fix, classifier rewrite, budget governance)          | 6                      | 0           | false            | **2,000 ms (compliant)**      | First clean run; `tournament-results`/`other-entrant-brackets` still 0 samples (exact-suffix filter defect)    |
| **#4 (post evidence-tolerant discovery fix — this record's data)** | **11**                 | **0**       | **false**        | **2,000 ms (compliant)**      | All three families sampled; this run's `pages`/`discoveries` are the source for every table above              |

`LIQ_SPIKE_MAX_GENERAL_REQUESTS` is 20 on every run; parse-class requests are always 0 — this probe
never issues one. Runs #1/#2 never reached a receipt, so their exact request counts are not known and
are not invented here — only what each run's owner-pasted output actually reported.

## The D-29 limiter defect, fix, and reach

**Defect (found by this spike's first live run):** the shared `LiquipediaLimiter`
(`apps/api/src/liquipedia/limiter.ts`) stamped its durable RTDB budget timestamp from the clock read
**before** the RTDB transaction round-trip, then returned to the caller as soon as the transaction
committed — with no wait to align the caller's actual dispatch to that stamp. A real transaction's
round-trip latency varies (a cold RTDB connection commonly costs roughly a second; a warm one tens of
milliseconds); when latency dropped between two consecutive acquisitions, the REAL spacing between
the two actual HTTP dispatches shrank below the published interval even though both durable stamps
were correctly ≥2,000 ms apart. Reproduced live twice (runs #1 and #2): two requests measured 908 ms
apart (required ≥2,000 ms).

**Fix:** the limiter now reserves the earliest legal slot unconditionally, then either sleeps or
best-effort repairs the durable stamp so its own RESOLUTION never precedes that slot; a second, local
(per-instance, per-budget-path) precision cache closes a further non-convergence gap discovered while
proving the repair-only approach insufficient (a repair transaction has its own nonzero latency, so
chasing it with more repairs never converges under constant latency). Proven by induction and by 18
tests (7 new) covering decreasing/increasing/random latency profiles, an extreme single-latency
overshoot, and the parse-class two-budget composition. Confirmed against the live API on BOTH runs #3
and #4: `minObservedGeneralStartSpacingMs=2000` exactly, no violation, on two independent live runs.

**Reach:** `apps/api/src/liquipedia/limiter.ts` gates every outbound Liquipedia call in this
codebase — not only this spike probe, but also the production `apps/api/scripts/
enrichDemoAccounts.ts` enrichment CLI. The fix applies to both callers; no separate fix was needed
for the enrichment CLI.

**Residual, unaffected risk (pre-existing, documented in `limiter.ts`'s own module doc comment,
unchanged by this fix):** cross-PROCESS clock skew. The durable RTDB stamp guarantees serialization
across processes but not real-time spacing across DIFFERENT processes' clocks; this spike and the
enrichment CLI both run from one process at a time, so the assumption holds for both today. The named
follow-up (a server-relative clock) remains open and out of scope for this record.

## Four-run instrument history (honesty note)

This spike's own probe needed four live reruns before it produced trustworthy evidence: run #1 found
a write-path bug (fixed) and the D-29 limiter defect; run #2 confirmed D-29 was still unfixed and that
discovery-by-link-following wasted the entire budget on Melee-era dead ends (both fixed); run #3
confirmed D-29 fixed live but showed the discovery filter's guessed exact-suffix naming pattern
matched nothing real (fixed with evidence-tolerant token/fallback discovery); run #4 confirmed
discovery now samples real pages in every family, but surfaced a template-name-matching defect in the
fingerprint (fixed offline against the saved report, no fifth live run needed). The instrument itself,
not just the subject, needed iteration — recorded here so Phase 42 does not assume the FIRST version
of any evidence-gathering tool in this codebase is trustworthy without a live check.

## Committed fixtures

Three sanitized samples committed to `apps/api/src/liquipedia/__fixtures__/` (see `MANIFEST.md` for
full per-asset provenance — revision ids, capture date, exact API query form, what each proves):

- `query-player-results-batch.json` — the real single batched call covering `Hungrybox/Results`
  (sufficient), `MKLeo/Results`/`Sparg0/Results` (stub-generator-only), `IzAw/Results` (missing), and
  the `MkLeo/Results` → `MKLeo/Results` redirect.
- `query-battle-of-bc-1-tournament.json` — a real `tournament-results` overview page.
- `query-battle-of-bc-1-melee-singles-bracket.json` — a real `other-entrant-brackets` page carrying
  this wiki's actual bracket-structure template names.

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
allowlist addition (never a bypass) OR LPDB access (now GRANTED — see below) before their placements
can be read; treat `tournament-results` and real `other-entrant-brackets` pages (the three genuine
bracket samples, not the `GENESIS/X` duplicate) as reachable via plain `action=query` wikitext, within
budget; rely on the D-29 limiter fix as already applied and tested for any future Liquipedia caller;
reuse the real bracket-structure template names recorded above as a starting point for a bracket
parser, understanding they were observed on LEGACY (Melee/Wii U-era) pages, not confirmed against an
Ultimate-era page.

**May not, yet:** assume the `Series/<edition>/Ultimate`-shaped naming convention is correct — it is
an INFERENCE from adjacent pages' shape, never a page this spike actually fetched (see the
early-edition-sampling finding above); run subpage discovery against a redirect SOURCE title and
expect a real bracket page — the `GENESIS/X` sample proves that returns a duplicate of the tournament
page, not a bracket; widen or bypass `LIQUIPEDIA_PARSE_CLASS_ALLOWLIST` — no anchored regex proposal
has been recorded for any real page in this spike as of this writing (the `MKLeo/Results`/
`Sparg0/Results` shape would propose `^[^/]+/Results$` if a future plan deliberately extends the
allowlist, but that decision belongs to Phase 42, not this spike).

## LiquipediaDB (LPDB) access status (D-31 — supersedes D-23 and this record's earlier "pending request" framing)

**GRANTED before this phase**, per an owner statement made 2026-09-17: the owner requested LPDB access
weeks before Phase 36 began and already holds an API key (`LIQUIPEDIA_API_KEY`, held as an owner
environment secret; webhook access is also available per the owner, not expected to be needed). The
exact grant date is not recorded. No tracked source in this repository references the key today
(verified: `git grep LIQUIPEDIA_API_KEY` across tracked files returns no hits outside
`.planning/STATE.md`'s own note of this decision; `apps/api/src/config/env.ts` declares no such field
yet). **This spike never made an LPDB request and never will** — LPDB integration is out of scope for
Phase 36 by design (research spike only); this section records the access STATUS, not a capability
this probe exercised.

**What is UNVERIFIED:** the key's tier and any account-specific rate limit — the owner reports the
Liquipedia web dashboard for this key exposes no tier/rate-limit information, so there is no
account-specific figure to cite. **The PUBLIC published terms
(`https://liquipedia.net/api-terms-of-use`) are the authority for budgeting LPDB access**, not this
key's dashboard. The milestone research quoted a 60-requests/hour free-tier figure from that public
terms page — cited here as "per milestone research of the public terms page, to be re-read live at
Phase 42 planning time," never as a number this spike verified directly. Also unverified: which
tables/fields are actually queryable, and whether webhook use carries separate terms.

**Binding constraints for Phase 42, regardless of tier:** LPDB access gets its OWN rate budget and its
OWN limiter instance — NEVER shares `apps/api/src/liquipedia/limiter.ts`'s MediaWiki general/
parse-class budget paths, which are reserved for the `action=query`/`action=parse` surface this record
covers. LPDB-sourced facts get their own provenance content type (distinct from a wikitext/parse
provenance record) so a UI can attribute them correctly. CC-BY-SA attribution applies identically
(see above) regardless of access method. The key must be added to `apps/api/src/config/env.ts` as an
optional Zod field with a config-null accessor, following the exact `LIQUIPEDIA_CONTACT`/
`getLiquipediaConfig` precedent already shipped there — never logged, never committed, never sent to
the browser.

**Consequence for the generated-results finding:** `MKLeo/Results`/`Sparg0/Results`-style
`ResultsPageHeader` stub pages, unreachable as wikitext, now have a SANCTIONED structured route (LPDB)
that does not require a parse-class allowlist change at all. This is RECOMMENDED as the Phase 42 path
for that shape — clearly marked as a recommendation, not a verified capability, since no LPDB request
was made in this spike and the key's actual query surface remains unverified per above.

This spike (`.planning/phases/36-evidence-engine-foundation-scale-gate/36-LPDB-REQUEST.md`) drafted an
LPDB access-request message before this correction surfaced. It was NEVER sent, is now superseded by
the pre-existing grant (D-31), and is retained only as a statement of intended use Phase 42 may reuse
if the existing grant's terms ever require re-affirming that use case.

**Submission date:** N/A — no request was submitted in this phase; access was already granted before
Phase 36 began (owner statement, 2026-09-17, D-31). The exact original grant date is not recorded.
