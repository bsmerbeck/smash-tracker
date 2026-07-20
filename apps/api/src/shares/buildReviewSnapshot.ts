import {
  extractCitationTokens,
  publicShareSnapshotSchema,
  type ClientVisibleVersion,
  type PublicShareSnapshot,
} from '@smash-tracker/shared';

/**
 * One distinct source VOD a citation in the delivered version's body refers
 * to, resolved by the CALLER (`RtdbService.getShareByToken`'s coachReview
 * branch — it owns the `matches/{tenantId}` read) — this function stays
 * pure/no-I/O, mirroring `buildRecapSnapshot`/`buildShareSnapshot`.
 */
export interface ReviewCitationSource {
  sourceVodRef: string;
  vodUrl: string;
}

/**
 * Phase 12 (Coach Reviews & Delivery, DLV-01/DLV-02/DLV-03): builds the
 * client-visible delivery snapshot from a SEALED `reviewVersions` record.
 *
 * Authored FROM SCRATCH via `publicShareSnapshotSchema`'s named `kind:
 * 'coachReview'` fields — never spreads `version` — the same from-scratch
 * discipline `buildRecapSnapshot`/`buildShareSnapshot` already prove out for
 * the other two share kinds. There is structurally no `coachPrivateNotes`
 * field on `ClientVisibleVersion` to leak in the first place (REV-03:
 * `reviews.ts`'s `sealVersionPayload` already excludes it and hidden
 * sections before this ever runs) — this function's only job is picking the
 * RIGHT fields onto the RIGHT response shape, never guarding against a wrong
 * one being present.
 *
 * `reviewedMomentsCount` (required on every `publicShareSnapshotSchema` row,
 * regardless of kind) is the total count of `{{cite:...}}` tokens embedded
 * across every section body — the coachReview analogue of a vod-review
 * snapshot's "moments reviewed" aggregate — computed here, not passed in, so
 * the caller can never drift it out of sync with the sections actually
 * shipped in this same response.
 */
export function buildReviewSnapshot(
  version: ClientVisibleVersion,
  coachDisplayName: string,
  citationSources: ReviewCitationSource[],
): PublicShareSnapshot {
  const reviewedMomentsCount = version.sections.reduce(
    (total, section) => total + extractCitationTokens(section.body).length,
    0,
  );

  const snapshot: PublicShareSnapshot = {
    createdAt: version.publishedAt,
    kind: 'coachReview',
    coachDisplayName,
    reviewPublishedAt: version.publishedAt,
    sections: version.sections,
    ...(citationSources.length > 0 ? { citationSources } : {}),
    reviewedMomentsCount,
  };

  return publicShareSnapshotSchema.parse(snapshot);
}
