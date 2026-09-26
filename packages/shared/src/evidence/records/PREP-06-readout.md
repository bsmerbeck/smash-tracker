# PREP-06: `PREP_PAID_REPORTS_ENABLED` readout, prices and what a credit buys

**Decision substrate:** PREP-06, discharging D-14 (owner-run readout, counts only), D-15 (the
on/off call is made at the checkpoint with the numbers in front of the owner), D-16 (prices read
from source bytes), D-17 (no deploy, no gate flip in this phase) and D-19 (every percentage
labelled with its method and denominator). Recorded during Phase 39 (Evidence-Grounded Prep &
Debrief Spine), plan 39-14.

This is the TRACKED copy that survives a clean checkout (`.gitignore` ignores `.planning/`). The
obligations it discharges are written out in
`.planning/phases/39-evidence-grounded-prep-debrief-spine/39-CONTEXT.md` (D-07, D-14 to D-17, D-19
to D-21). Its anti-drift test is `packages/shared/src/evidence/prep06Record.test.ts`.

## PROCEDURE

The owner follows `docs/prep06-readout-runbook.md` and runs the committed, read-only readout
(`apps/api/scripts/prep06Readout.ts`) in their own shell with their own copy of the internal-jobs
secret. Claude never sees the secret, never runs the script against production and never reads
production; the owner pastes back the printed output and Claude transcribes it here.

## SOAK EVIDENCE

Columns mirror the readout's own printed row (`apps/api/scripts/prep06Readout.ts`, the
`printReadout` header line): each row states its own `method`, and exact and approximate rows are
never blended into one figure (D-19).

| day | method | reconcile% | duplicate% | numerator | denominator | note |
| --- | ------ | ---------- | ---------- | --------- | ----------- | ---- |

_Not yet filled — the owner has not run the readout. Rows are transcribed as printed at plan 39-14's
final task._

**Method mix:** not yet recorded.

### FOOTNOTES

_Not yet filled — the footnotes are transcribed verbatim from the readout's printed output, never
paraphrased, at plan 39-14's final task._

**REFERENCE:** v2.5's flip rule — `>=98% reconcile` and `<0.5% duplicates` — is the reference the
numbers above are read AGAINST. It is not a threshold any code enforces: the readout computes no
pass/fail verdict, and no code in this repository compares a number in this record against it. The
owner makes the call (D-15).

## PRICES

The credit packs as shipped, read from `packages/shared/src/billing.ts` (`CREDIT_PACKS`) at
execution time. `amountCents` is the Stripe amount in cents, exactly as the constant carries it.

| id       | credits | amountCents | label        |
| -------- | ------- | ----------- | ------------ |
| `pack5`  | 5       | 800         | `5 reports`  |
| `pack15` | 15      | 2000        | `15 reports` |

These carry forward unchanged (D-16). Any price or packaging change is a separate owner decision
outside this phase. `prep06Record.test.ts` asserts this table equals `CREDIT_PACKS` row for row.

## WHAT A CREDIT BUYS

PRICES answers what a credit COSTS. This section answers what a credit BUYS after this phase — the
second clause of PREP-06's sentence. One credit is spent per generation by a caller who is not on
the free-use list (`REPORTS_ALLOWED_UIDS`); the job records whether it actually took a credit in the
stored `wasCharged` field, and a failed job is refunded only through the one existing `failJob`
path. It applies once the owner deploys this phase's code (D-17); nothing here is live today.

Minimum viable claim counts per surface, from the exported `MIN_VIABLE_CLAIMS` constant
(`packages/shared/src/evidence/claims.ts`):

| surface                | MIN_VIABLE_CLAIMS |
| ---------------------- | ----------------- |
| `scout`                | 3                 |
| `prep_report`          | 3                 |
| `prep_bundle_child`    | 3                 |
| `post_event_synthesis` | 2                 |

1. **The normal case — a validated report.** The claims that survived validation (engine-authored
   figures, each with its sample cue and confidence tier), the report's sections, at most three
   recommended actions (the stored slots `action1`, `action2`, `action3`), and a `validation` block
   that names the `snapshotId` the report was checked against, with its `policyVersion` and
   `claimSchemaVersion`. The validation block is written only on a report that passed.
2. **D-20 — prose-less is still delivered and still charged.** When the prose lint strips the
   commentary from one section or from every section, the report is still delivered, as a
   claims-only report, and the credit is spent — a stripped section is never a refund. It is
   DISCLOSED on the report card (the `reports.withheldProse` caption) and by an equivalent line in
   the `.md` export, and it is OBSERVABLE: the count is persisted on the stored report as `strippedSectionCount` and emitted
   as the `report_prose_stripped` event.
3. **D-21 — thin evidence buys a refund, not a report.** When the claims issued for a job are already
   below the surface's `MIN_VIABLE_CLAIMS` at job claim, the job fails fast: the model is not called,
   nothing is delivered, the job fails through `failJob` with `failureReason` `validation`, the
   credit is returned exactly once, the `report_failed_validation` event is emitted, and the UI says
   there is not enough match evidence yet. This is a DELIBERATE CHANGE from today's shipped
   behaviour on the live, publicly purchasable scout path, where the same caller is currently charged
   for a cold-read report. It takes effect only when the owner deploys (D-17).
4. **D-07 — dropped claims are delivered with a note.** Claims the validator could not support are
   dropped, and the delivered report says how many (the `reports.droppedClaims` caption, from the
   stored `droppedClaimCount`); the `report_claims_dropped` event records it. Prose that names the
   unknown stage or character bucket withholds that section's prose only, disclosed like any other
   withheld commentary, and never drops a claim (owner decision D-22); a claim whose own stage or
   fighter id is the unknown bucket is dropped. Only when fewer than `MIN_VIABLE_CLAIMS` claims survive does the job fail with
   `failureReason` `validation` and refund through `failJob`.

## BOUNDARY

Counts only. This record carries no uid, no correlation id, no event payload and no secret — only
the per-day aggregates the readout prints. If a pasted readout ever shows anything that identifies a
user, an opponent or a tournament, it is not transcribed; it is reported as a defect in the script.

## DECISION

**PENDING — owner checkpoint not yet run.** The on/off choice, the owner's rationale, the date, the
statement that this phase performed no deploy and no environment-variable change, and the owner's
acknowledgement of the section above are all recorded here at plan 39-14's final task.
