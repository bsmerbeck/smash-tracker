import { describe, expect, it } from 'vitest';
import {
  canonicalizeForHash,
  computeArtifactHash,
  manifestArtifactSchema,
  validateArchiveTargets,
  type ManifestArtifactWithoutHash,
  type SourceToDestMapping,
} from './migrateManifestArtifact.js';

/**
 * Phase 30.1 Plan 04 (review C3-M2): the pure artifact-validator suite.
 * `validateArchiveTargets` is the single authority the `archive` subcommand
 * calls to derive the source ids it is allowed to archive — this suite
 * proves it REJECTS every partial/duplicated/substituted/mismatched map and
 * ACCEPTS only the exact expected four-mapping set.
 */

const HBOX_SOURCE_ID = '0f0443e4-c637-4dd4-9c3a-c8365c1f7ad6';
const MKLEO_SOURCE_ID = 'd4c17fdc-be36-49a1-8223-e0a3ab16a40c';
const SPARG0_SOURCE_ID = 'e5d9f25d-929d-4884-875d-67cfab05d5c1';
const IZAW_SOURCE_ID = '1438981f-2830-469d-ac96-cca1ee8cc75b';

const EXPECTED_SOURCE_IDS = [
  HBOX_SOURCE_ID,
  MKLEO_SOURCE_ID,
  SPARG0_SOURCE_ID,
  IZAW_SOURCE_ID,
] as const;

function makeMapping(sourceId: string, destUid: string, label: string): SourceToDestMapping {
  return { sourceId, destUid, label };
}

const HBOX_MAPPING = makeMapping(HBOX_SOURCE_ID, 'dest-hbox-uid', 'Hungrybox');
const MKLEO_MAPPING = makeMapping(MKLEO_SOURCE_ID, 'dest-mkleo-uid', 'MkLeo');
const SPARG0_MAPPING = makeMapping(SPARG0_SOURCE_ID, 'dest-sparg0-uid', 'Sparg0');
const IZAW_MAPPING = makeMapping(IZAW_SOURCE_ID, 'dest-izaw-uid', 'IzAw');

function makeValidMap(): SourceToDestMapping[] {
  return [HBOX_MAPPING, MKLEO_MAPPING, SPARG0_MAPPING, IZAW_MAPPING];
}

function makeValidArtifact(overrides?: { sourceToDestMap?: unknown }): ManifestArtifactWithoutHash {
  return {
    generatedAtMs: Date.UTC(2026, 7, 10, 12, 0, 0),
    dbIdentity: { host: 'smash-tracker-f97b7.firebaseio.com', projectId: 'smash-tracker-f97b7' },
    sourceToDestMap: (overrides?.sourceToDestMap ?? makeValidMap()) as never,
    workspaces: [],
    ok: true,
  };
}

function withHash(artifact: ManifestArtifactWithoutHash): unknown {
  return { ...artifact, sha256: computeArtifactHash(artifact) };
}

describe('validateArchiveTargets', () => {
  it('accepts exactly the four expected mappings and returns their four source ids', () => {
    const artifact = withHash(makeValidArtifact());

    const result = validateArchiveTargets(artifact, EXPECTED_SOURCE_IDS);

    expect(result).toHaveLength(4);
    expect(new Set(result)).toEqual(new Set(EXPECTED_SOURCE_IDS));
  });

  it('rejects an empty sourceToDestMap', () => {
    const artifact = withHash(makeValidArtifact({ sourceToDestMap: [] }));

    expect(() => validateArchiveTargets(artifact, EXPECTED_SOURCE_IDS)).toThrow();
  });

  it('rejects a short map (three entries)', () => {
    const shortMap = [HBOX_MAPPING, MKLEO_MAPPING, SPARG0_MAPPING];
    const artifact = withHash(makeValidArtifact({ sourceToDestMap: shortMap }));

    expect(() => validateArchiveTargets(artifact, EXPECTED_SOURCE_IDS)).toThrow(
      /exactly 4 entries/,
    );
  });

  it('rejects a map with a required field absent (schema failure)', () => {
    const brokenMap = [
      { sourceId: HBOX_MAPPING.sourceId, destUid: HBOX_MAPPING.destUid }, // missing `label`
      MKLEO_MAPPING,
      SPARG0_MAPPING,
      IZAW_MAPPING,
    ];
    const artifact = withHash(makeValidArtifact({ sourceToDestMap: brokenMap }));

    expect(() => validateArchiveTargets(artifact, EXPECTED_SOURCE_IDS)).toThrow(
      /schema validation/,
    );
  });

  it('rejects a duplicate sourceId', () => {
    const map = [
      HBOX_MAPPING,
      { ...MKLEO_MAPPING, sourceId: HBOX_MAPPING.sourceId },
      SPARG0_MAPPING,
      IZAW_MAPPING,
    ];
    const artifact = withHash(makeValidArtifact({ sourceToDestMap: map }));

    expect(() => validateArchiveTargets(artifact, EXPECTED_SOURCE_IDS)).toThrow(
      /duplicate sourceId/,
    );
  });

  it('rejects a duplicate destUid', () => {
    const map = [
      HBOX_MAPPING,
      { ...MKLEO_MAPPING, destUid: HBOX_MAPPING.destUid },
      SPARG0_MAPPING,
      IZAW_MAPPING,
    ];
    const artifact = withHash(makeValidArtifact({ sourceToDestMap: map }));

    expect(() => validateArchiveTargets(artifact, EXPECTED_SOURCE_IDS)).toThrow(
      /duplicate destUid/,
    );
  });

  it('rejects a substituted sourceId (four unique ids but one not in the expected set)', () => {
    const map = [
      HBOX_MAPPING,
      MKLEO_MAPPING,
      SPARG0_MAPPING,
      { ...IZAW_MAPPING, sourceId: 'not-a-real-source-tenant-id' },
    ];
    const artifact = withHash(makeValidArtifact({ sourceToDestMap: map }));

    expect(() => validateArchiveTargets(artifact, EXPECTED_SOURCE_IDS)).toThrow(
      /does not match the expected sources/,
    );
  });

  it('rejects a mismatched map (four unique ids whose set differs entirely from expected)', () => {
    const map = [
      makeMapping('foreign-source-1', 'dest-1', 'Foreign1'),
      makeMapping('foreign-source-2', 'dest-2', 'Foreign2'),
      makeMapping('foreign-source-3', 'dest-3', 'Foreign3'),
      makeMapping('foreign-source-4', 'dest-4', 'Foreign4'),
    ];
    const artifact = withHash(makeValidArtifact({ sourceToDestMap: map }));

    expect(() => validateArchiveTargets(artifact, EXPECTED_SOURCE_IDS)).toThrow(
      /does not match the expected sources/,
    );
  });

  it('rejects an artifact carrying an unknown top-level field (strict schema)', () => {
    const artifact = withHash(makeValidArtifact()) as Record<string, unknown>;
    artifact.extraField = 'should not be here';

    expect(() => validateArchiveTargets(artifact, EXPECTED_SOURCE_IDS)).toThrow(
      /schema validation/,
    );
  });

  it('rejects an artifact whose sourceToDestMap entry carries an unknown field (strict schema)', () => {
    const map = [{ ...HBOX_MAPPING, extra: 'nope' }, MKLEO_MAPPING, SPARG0_MAPPING, IZAW_MAPPING];
    const artifact = withHash(makeValidArtifact({ sourceToDestMap: map }));

    expect(() => validateArchiveTargets(artifact, EXPECTED_SOURCE_IDS)).toThrow(
      /schema validation/,
    );
  });

  it('rejects a non-object input', () => {
    expect(() => validateArchiveTargets(null, EXPECTED_SOURCE_IDS)).toThrow();
    expect(() => validateArchiveTargets('not an artifact', EXPECTED_SOURCE_IDS)).toThrow();
    expect(() => validateArchiveTargets(undefined, EXPECTED_SOURCE_IDS)).toThrow();
  });
});

describe('manifestArtifactSchema', () => {
  it('parses a well-formed artifact', () => {
    const artifact = withHash(makeValidArtifact());
    expect(() => manifestArtifactSchema.parse(artifact)).not.toThrow();
  });
});

describe('computeArtifactHash / canonicalizeForHash', () => {
  it('produces the same hash regardless of key insertion order', () => {
    const artifact = makeValidArtifact();
    const reordered: ManifestArtifactWithoutHash = {
      ok: artifact.ok,
      workspaces: artifact.workspaces,
      sourceToDestMap: artifact.sourceToDestMap,
      dbIdentity: artifact.dbIdentity,
      generatedAtMs: artifact.generatedAtMs,
    };

    expect(computeArtifactHash(artifact)).toBe(computeArtifactHash(reordered));
  });

  it('produces a different hash when dbIdentity changes (cycle-2 MEDIUM: foreign-env binding)', () => {
    const artifact = makeValidArtifact();
    const otherDb: ManifestArtifactWithoutHash = {
      ...artifact,
      dbIdentity: { host: 'other-host', projectId: 'other-project' },
    };

    expect(computeArtifactHash(artifact)).not.toBe(computeArtifactHash(otherDb));
  });

  it('produces a different hash when sourceToDestMap changes', () => {
    const artifact = makeValidArtifact();
    const changed: ManifestArtifactWithoutHash = {
      ...artifact,
      sourceToDestMap: [
        { ...HBOX_MAPPING, destUid: 'a-different-dest-uid' },
        MKLEO_MAPPING,
        SPARG0_MAPPING,
        IZAW_MAPPING,
      ],
    };

    expect(computeArtifactHash(artifact)).not.toBe(computeArtifactHash(changed));
  });

  it('canonicalizeForHash sorts object keys but preserves array order', () => {
    const value = { b: 1, a: [3, 1, 2] };
    expect(canonicalizeForHash(value)).toEqual({ a: [3, 1, 2], b: 1 });
    expect(Object.keys(canonicalizeForHash(value) as object)).toEqual(['a', 'b']);
  });
});
