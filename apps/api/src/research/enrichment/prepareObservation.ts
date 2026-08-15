import { createHash } from 'node:crypto';
import {
  researchEnrichmentObservationRecordSchema,
  type ResearchEnrichmentObservationRecord,
} from '@smash-tracker/shared';

/**
 * 30.2 reliability gate (owner corrective directive, Gate 1): THE single
 * dry-run/apply parity seam. Every observation an enrichment run gathers —
 * dry-run or real — passes through `prepareAndValidateObservation` BEFORE it
 * is counted, hashed into a manifest, or persisted. The function parses the
 * record through the EXACT persistence schema
 * (`researchEnrichmentObservationRecordSchema`, the same parse
 * `writeEnrichmentObservation` performs at the write boundary), so a schema
 * error after a successful preflight is structurally impossible: any record
 * the schema would reject at write time is rejected at EXTRACTION time, in
 * the same code path, before a manifest can ever be produced around it.
 *
 * The production defect this closes: the MkLeo apply aborted at the write
 * boundary on a `rawTag: ""` observation that every dry-run had silently
 * included in its manifest — per-record validation ran only immediately
 * before each write, so the dry-run and the apply disagreed about which
 * records were persistable (same class as the earlier flag-cap defect,
 * commit b3ee394f).
 */

export class EnrichmentObservationInvalidError extends Error {
  constructor(
    readonly observationId: string,
    readonly sourcePageTitle: string,
    detail: string,
  ) {
    super(
      `enrichment observation ${observationId} (page "${sourcePageTitle}") failed the ` +
        `persistence schema at extraction time — stop-ship parity defect, nothing was written: ${detail}`,
    );
    this.name = 'EnrichmentObservationInvalidError';
  }
}

/**
 * Parses one adapter-built observation through the exact persistence schema.
 * Returns the SCHEMA-PARSED record (the byte-identical value
 * `writeEnrichmentObservation` would persist); throws
 * `EnrichmentObservationInvalidError` naming the record and its issues on
 * any failure. Pure — no I/O, no clock.
 */
export function prepareAndValidateObservation(
  record: ResearchEnrichmentObservationRecord,
): ResearchEnrichmentObservationRecord {
  const parsed = researchEnrichmentObservationRecordSchema.safeParse(record);
  if (!parsed.success) {
    const detail = parsed.error.issues
      .map((issue) => `${issue.path.join('.') || '<root>'}: ${issue.message}`)
      .join('; ');
    throw new EnrichmentObservationInvalidError(
      typeof record?.observationId === 'string' ? record.observationId : '<unknown>',
      typeof record?.sourcePageTitle === 'string' ? record.sourcePageTitle : '<unknown>',
      detail,
    );
  }
  return parsed.data;
}

/**
 * Deterministic canonical serialization: arrays in order, object keys
 * sorted — the same discipline `enrichManifestArtifact.ts` uses for the
 * manifest content hash, restated here because this module must not import
 * a script.
 */
function canonicalize(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalize).join(',')}]`;
  }
  if (value !== null && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalize(record[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

/**
 * The canonical page-level digest over EVERY schema-parsed observation a run
 * gathered — the value the dry-run manifest records and the apply preflight
 * recomputes, so "the exact records apply would persist" is hash-compared,
 * not merely count-compared.
 *
 * `fetchedAtMs`/`observedAtMs` are EXCLUDED from each record's hashed form —
 * they are wall-clock stamps of the invocation, not source facts, and the
 * write-set hash discipline in `enrichManifestArtifact.ts` already strips
 * `fetchedAtMs` from source revisions for the same reason: a preflight run
 * minutes after the reviewed dry-run must hash equal when the SOURCE
 * CONTENT is equal. Every other member — ids, provenance, players, games,
 * scores, VOD URLs, reasons — is covered verbatim.
 *
 * Records are sorted by `observationId` so gather order can never move the
 * digest.
 */
export function computeObservationPersistenceHash(
  records: readonly ResearchEnrichmentObservationRecord[],
): string {
  const canonicalRecords = records
    .map((record) => {
      // eslint-disable-next-line @typescript-eslint/no-unused-vars -- rest-destructure-to-omit idiom; the two clock stamps are intentionally discarded
      const { fetchedAtMs: _fetchedAtMs, observedAtMs: _observedAtMs, ...content } = record;
      return content;
    })
    .sort((a, b) => a.observationId.localeCompare(b.observationId));
  return createHash('sha256').update(canonicalize(canonicalRecords)).digest('hex');
}
