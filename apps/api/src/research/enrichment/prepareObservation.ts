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
 * 30.2 production defect C, parity half: two gathered observations sharing
 * one `observationId` can only ever persist as ONE record (the store
 * upserts by id), so a duplicate id inside a single gather is an
 * UNDER-KEYED DISCRIMINATOR — a structural failure that must abort the
 * dry-run/apply at extraction time, never shrink production silently. The
 * original defect hashed 9,367 records into the reviewed manifest while
 * persistence could only ever hold 9,225 distinct ids.
 */
export class EnrichmentObservationCollisionError extends Error {
  constructor(
    readonly observationId: string,
    readonly firstSourcePageTitle: string,
    readonly secondSourcePageTitle: string,
  ) {
    super(
      `enrichment observation id collision: ${observationId} was produced twice in one gather ` +
        `(pages "${firstSourcePageTitle}" and "${secondSourcePageTitle}") — the id discriminator is ` +
        'under-keyed; persistence upserts by id and would silently drop one record. Stop-ship parity defect.',
    );
    this.name = 'EnrichmentObservationCollisionError';
  }
}

/**
 * A stateful per-gather guard: `register` every prepared observation the
 * moment it is gathered; a repeated id throws
 * `EnrichmentObservationCollisionError` naming both source pages, so any
 * future under-keying aborts at extraction time on BOTH the dry-run and the
 * apply path (same code path, same failure).
 */
export function createObservationIdCollisionGuard(): (
  record: ResearchEnrichmentObservationRecord,
) => void {
  const firstPageByObservationId = new Map<string, string>();
  return (record) => {
    const firstPage = firstPageByObservationId.get(record.observationId);
    if (firstPage !== undefined) {
      throw new EnrichmentObservationCollisionError(
        record.observationId,
        firstPage,
        record.sourcePageTitle,
      );
    }
    firstPageByObservationId.set(record.observationId, record.sourcePageTitle);
  };
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
  // COLLISION-LOUD (30.2 defect C): a duplicate id in the hashed list means
  // the manifest would cover MORE records than persistence can ever hold
  // (the store upserts by id) — the exact silent-shrink shape the parity
  // seam exists to make impossible. Refuse to hash it.
  const firstPageByObservationId = new Map<string, string>();
  for (const record of records) {
    const firstPage = firstPageByObservationId.get(record.observationId);
    if (firstPage !== undefined) {
      throw new EnrichmentObservationCollisionError(
        record.observationId,
        firstPage,
        record.sourcePageTitle,
      );
    }
    firstPageByObservationId.set(record.observationId, record.sourcePageTitle);
  }

  const canonicalRecords = records
    .map((record) => {
      // eslint-disable-next-line @typescript-eslint/no-unused-vars -- rest-destructure-to-omit idiom; the two clock stamps are intentionally discarded
      const { fetchedAtMs: _fetchedAtMs, observedAtMs: _observedAtMs, ...content } = record;
      return content;
    })
    .sort((a, b) => a.observationId.localeCompare(b.observationId));
  return createHash('sha256').update(canonicalize(canonicalRecords)).digest('hex');
}
