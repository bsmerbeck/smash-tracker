# RPT-08: The unsupported-claim rubric — what "unsupported" means, mechanically

**Decision substrate:** D-09 / RPT-08, phase 39 plan 01 (wave 1, Evidence-Grounded Prep & Debrief
Spine). D-09 fixes the ordering: this rubric and the adversarial fixture corpus land BEFORE any
report-prose, prompt or rendering code is written, with a committed oracle shown FAILING on a
deliberately wrong-number output (a claim citing a real evidence id but stating a wrong number
must be caught).

This is the TRACKED copy that survives a clean checkout (`.gitignore:26` ignores `.planning/`),
mirroring the `SCL-01-record.md` / `TRND-01-rating-model.md` precedent in this same directory.

## Definition

A factual specific in a report output is **UNSUPPORTED** when it is not recomputable from the
immutable snapshot (`EvidenceSnapshot`) the output was generated against.

**Citation existence alone is explicitly declared insufficient.** `legacyCitationRule.ts`'s frozen
`legacyCitationOnlyVerdict` is the machine-checked demonstration: it implements exactly today's
shipped citation rule (`validatePracticePlanCitations`, `apps/api/src/reports/synthesis.ts`) —
"every evidence id a claim cites is a key of the snapshot's rows" — and `rpt08Oracle.test.ts`
proves it ACCEPTS a claim that cites a real, issued evidence id while asserting a value the
snapshot's own row contradicts (rule R2, below — the named hard case). A citation existing is
necessary but never sufficient; the value itself must be recomputable.

## The rule table

Every rule is mechanically decidable — a recompute, a lexical check, or a set-membership test over
the snapshot — never a matter of taste. Each rule names the fixture family (in
`adversarialFixtures.ts`) that exercises it.

| Rule | Statement                                                                                                                                                                                                                                                                                                              | Mechanical check                                                                                                                                                                                                                                                                                                           | Fixture family                                                           |
| ---- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| R1   | A claim cites an evidence id that is unissued for this job, or unknown to the snapshot entirely.                                                                                                                                                                                                                       | Set-membership: the claim's `claimId` is in `issuedClaimIds`, and every one of its evidence ids is a key of `snapshot.rows`.                                                                                                                                                                                               | `citation_missing`, `unissued_claim_id`                                  |
| R2   | A claim's asserted value is contradicted by recomputing it from the evidence row(s) it cites — the named hard case: a real citation paired with a wrong number.                                                                                                                                                        | Recompute: the asserted `ClaimValue` must equal the value stored on the cited row(s).                                                                                                                                                                                                                                      | `wrong_value`, `well_formed` (the control)                               |
| R3   | A claim's subject axis (fighter, stage, opponent tag) references an entity the snapshot has no row for — including the boundary case of an axis-free predicate (`recent_form`/`cohort_disclosure`), whose subject is legitimately all-null and must still resolve to exactly one row (`rf-all`/`cd-all`), never crash. | Set-membership: `evidenceIdFor(predicate, subject)` (or `vodEvidenceId` for `vod_annotation`) must be a key of `snapshot.rows`.                                                                                                                                                                                            | `all_null_subject`                                                       |
| R4   | Connective prose introduces a digit, percentage, fighter name, stage name, or opponent tag that no claim referenced in the SAME section licenses. NFC-normalize before comparing; any Unicode decimal digit counts as a digit (a fullwidth digit is a digit).                                                          | Lexical: extract entities/digits from prose, NFC-normalize, and check licensing against the section's own `licensedClaimIds` — never a claim licensed only in a different section.                                                                                                                                         | `prose_entity`, `prose_encoding`, `ordinary_prose` (the negative corpus) |
| R5   | A confidence word appears that is either outside the licensed phrase table, or mismatched to the claim's actual confidence tier (a strength word on a low-tier claim, a hedge word on a high-tier claim).                                                                                                              | Lexical: the word must be a member of the licensed table (D-03) AND consistent with the cited claim's `tier`.                                                                                                                                                                                                              | `confidence_word`, `ordinary_prose`                                      |
| R6   | An assertion rests on fewer than `ABSTENTION_FLOOR_GAMES` countable games.                                                                                                                                                                                                                                             | Recompute: the row's `sample.eligibleDenominator` (or `rawSampleSize` for an axis-free row) must be `>= ABSTENTION_FLOOR_GAMES`.                                                                                                                                                                                           | `sub_floor`, `tier_boundary`, `cold_start`                               |
| R7   | An unknown stage or character is counted inside a rate's denominator, a claim's own stage/fighter id (subject or entity value) is the unknown bucket (id 0) or off the roster, or prose names the unknown bucket as if it were a real, pickable entity.                                                                | Recompute + id + lexical: a `rate` claim's denominator must equal `sample.eligibleDenominator`, never `rawSampleSize`; a claim whose id is not a roster/StageList id is DROPPED; prose naming the bucket (any casing, plurals included) WITHHOLDS THAT SECTION'S PROSE ONLY and never drops a claim (owner decision D-22). | `unknown_bucket`                                                         |
| R8   | A non-null recommended-action slot (D-12) references a claim id that did not survive validation.                                                                                                                                                                                                                       | Set-membership: every non-null action slot's `claimId` must be a member of the surviving claim set.                                                                                                                                                                                                                        | `action_unlinked`                                                        |

## The verdict model

Per-claim, the validator's verdict is **`accepted`** or **`dropped`** — a claim failing any rule
above is dropped, never silently rewritten to agree with the recomputed value (an unsupported
claim is dropped and disclosed, never repaired in place).

Per-output, the verdict is **`passed`** when at least `MIN_VIABLE_CLAIMS[surface]` claims survive,
**`failed`** otherwise — citing the exported constant (`claims.ts`) by name so the number stays
auditable rather than duplicated in prose:

| Surface                | `MIN_VIABLE_CLAIMS` | Rationale                                                                                       |
| ---------------------- | ------------------- | ----------------------------------------------------------------------------------------------- |
| `scout`                | 3                   | Below three surviving claims a scouting output is not a report.                                 |
| `prep_report`          | 3                   | Same floor as `scout` — the same claim pipeline, the same minimum bar for a shippable output.   |
| `prep_bundle_child`    | 3                   | Each bundle child is itself a full report against one opponent — the same floor applies.        |
| `post_event_synthesis` | 2                   | Rests on annotation (`vod_annotation`) claims, which are legitimately fewer per event reviewed. |

A `failed` output routes to the existing `failJob` (D-07), `failureReason: 'validation'` — the
refund path and its math are untouched.

## What this rubric cannot decide

Readability, usefulness, and tone are explicitly OUT of scope for every rule above — they are
judgement calls, not mechanically decidable facts about a snapshot, and route to the owner's
judgement at UAT rather than to a rule in this table.
