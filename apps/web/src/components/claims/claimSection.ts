import type { ClaimAtomRecord, StoredScoutReport } from '@smash-tracker/shared';

/**
 * Phase 39 (plan 39-09, RPT-06): the ONE rule every claim-anchored rendering
 * of a stored report section follows — the on-screen card, its print block
 * and the practice-plan view. Pure (no React, no i18n) so the rule lives in
 * one place and each host only decides where the section goes.
 *
 * A stored section is `{ claimIds, connective }` (plan 39-06's `sections`
 * keyed map). The claims it names are looked up in the record's `claims`
 * keyed map; an id the map does not carry is skipped (a dropped claim is
 * disclosed separately, plan 39-10 — it is never rendered as a gap here).
 */

/** One stored section, as `storedReportSectionSchema` parses it. */
export type StoredClaimSection = NonNullable<StoredScoutReport['sections']>[string];

/** The record's stored claim keyed map. */
export type StoredClaimMap = NonNullable<StoredScoutReport['claims']>;

/**
 * What a host renders for one section:
 * - `empty` — nothing at all, heading included (no prose survived and no
 *   claim resolved; an empty `<ul>` or a bare heading is never rendered);
 * - `claims` — the surviving (non-abstained) claims in stored order, led by
 *   the connective when it is non-empty. Abstained siblings are omitted
 *   silently: the abstention sentence is reserved for the all-abstained case
 *   (UI-SPEC E1 partial — never double messaging);
 * - `abstained` — every resolved claim abstained: the shipped abstention
 *   sentence renders in place of the list, with the smallest `gamesNeeded`
 *   (the nearest claim to clearing the floor);
 * - `prose` — no claim resolved but the connective survived.
 */
export type ResolvedClaimSection =
  | { kind: 'empty' }
  | { kind: 'claims'; connective: string; claims: ClaimAtomRecord[] }
  | { kind: 'abstained'; connective: string; gamesNeeded: number }
  | { kind: 'prose'; connective: string };

/** Resolves one stored section against the record's claim map, applying the E1 empty/partial/abstained rules. */
export function resolveClaimSection(
  section: StoredClaimSection | null | undefined,
  claims: StoredClaimMap | null | undefined,
): ResolvedClaimSection {
  if (!section) {
    return { kind: 'empty' };
  }
  const connective = section.connective.trim().length > 0 ? section.connective : '';
  const resolved: ClaimAtomRecord[] = [];
  for (const claimId of section.claimIds) {
    const claim = claims?.[claimId];
    if (claim) {
      resolved.push(claim);
    }
  }
  const live = resolved.filter((claim) => claim.value.kind !== 'abstained');
  if (live.length > 0) {
    return { kind: 'claims', connective, claims: live };
  }
  if (resolved.length > 0) {
    const gamesNeeded = Math.min(
      ...resolved.map((claim) => (claim.value.kind === 'abstained' ? claim.value.gamesNeeded : 0)),
    );
    return { kind: 'abstained', connective, gamesNeeded };
  }
  if (connective) {
    return { kind: 'prose', connective };
  }
  return { kind: 'empty' };
}

/**
 * A claims-era record carries the stored `sections` map (plan 39-06 always
 * writes all three sections). Its absence is the legacy path, rendered
 * exactly as before — `claims` alone is not the signal, because a
 * cold-start record with zero claims legitimately has no `claims` map.
 */
export function isClaimsEraReport(report: { sections?: StoredScoutReport['sections'] }): boolean {
  return report.sections != null;
}
