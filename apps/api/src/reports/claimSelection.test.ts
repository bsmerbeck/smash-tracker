import { describe, expect, it } from 'vitest';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import {
  ACTION_ID_VOCABULARY,
  CLAIM_ID_VOCABULARY,
  EVIDENCE_POLICY_VERSION,
  confidenceTierFor,
  resolveSubjectDisplayName,
  storedScoutReportSchema,
  type ClaimAtom,
  type ClaimId,
  type ClaimSubject,
  type ClaimValue,
  type SampleMeta,
} from '@smash-tracker/shared';
import {
  CLAIM_SELECTION_SECTION_IDS,
  claimSelectionSchema,
  projectScoutSelection,
  type ClaimSelection,
} from './claimSelection.js';

/**
 * Plan 39-06 Task 1 (AI-SPEC §4 item 3): the OFFLINE proof of the schema the
 * model is actually sent. Every assertion runs over `zodOutputFormat(schema)`
 * exactly as `generate.ts` calls it — no API call, no cost.
 */

type JsonNode = Record<string, unknown>;

const FORMAT = zodOutputFormat(claimSelectionSchema);
const EMITTED = FORMAT.schema as JsonNode;

function resolveRef(ref: string): JsonNode {
  const match = /^#\/\$defs\/(.+)$/.exec(ref);
  if (!match) {
    throw new Error(`unexpected $ref ${ref}`);
  }
  return (EMITTED.$defs as Record<string, JsonNode>)[match[1]!]!;
}

/** Every node in the emitted schema, $defs included. */
function allNodes(node: unknown, out: JsonNode[] = []): JsonNode[] {
  if (Array.isArray(node)) {
    node.forEach((member) => allNodes(member, out));
    return out;
  }
  if (node !== null && typeof node === 'object') {
    out.push(node as JsonNode);
    Object.values(node as JsonNode).forEach((member) => allNodes(member, out));
  }
  return out;
}

/**
 * The vocabulary a string node communicates to the model: a JSON-Schema
 * `enum` keyword when the SDK passes one through, else the SDK's own
 * `{enum: [...]}` description encoding (see the tripwire test below).
 */
function vocabularyOf(node: JsonNode): readonly string[] | null {
  if (Array.isArray(node.enum)) {
    return node.enum as string[];
  }
  if (typeof node.description === 'string') {
    const match = /\{enum: (\[[^\]]*\])/.exec(node.description);
    if (match) {
      return JSON.parse(match[1]!) as string[];
    }
  }
  return null;
}

/** Walks the emitted schema along object properties / array items / anyOf, resolving $refs, detecting a $ref cycle. */
function nodeAt(path: readonly (string | number)[]): JsonNode {
  let node: JsonNode = EMITTED;
  for (const step of path) {
    if (typeof node.$ref === 'string') {
      node = resolveRef(node.$ref);
    }
    if (step === 'items') {
      node = node.items as JsonNode;
    } else if (typeof step === 'number') {
      node = (node.anyOf as JsonNode[])[step]!;
    } else {
      node = (node.properties as Record<string, JsonNode>)[step]!;
    }
  }
  return typeof node.$ref === 'string' ? resolveRef(node.$ref) : node;
}

const WELL_FORMED: ClaimSelection = {
  sections: {
    overview: { claimIds: ['c01'], connective: 'Open the set patient and steady.' },
    gameplan: { claimIds: ['c02', 'c03'], connective: 'Keep the pace you set early.' },
    watchFor: { claimIds: [], connective: 'Stay calm when the set gets close.' },
  },
  action1: { actionId: 'a01', claimId: 'c02' },
  action2: null,
  action3: null,
};

describe('claimSelectionSchema — the emitted JSON Schema, proven offline (AI-SPEC §4 item 3)', () => {
  it('every claim-id node carries exactly CLAIM_ID_VOCABULARY and every action-id node exactly ACTION_ID_VOCABULARY', () => {
    for (const sectionId of CLAIM_SELECTION_SECTION_IDS) {
      const items = nodeAt(['sections', sectionId, 'claimIds', 'items']);
      expect(items.type).toBe('string');
      expect(vocabularyOf(items)).toEqual([...CLAIM_ID_VOCABULARY]);
    }
    for (const slot of ['action1', 'action2', 'action3'] as const) {
      const actionObject = nodeAt([slot, 0]);
      expect(vocabularyOf(nodeAt([slot, 0, 'actionId']))).toEqual([...ACTION_ID_VOCABULARY]);
      expect(vocabularyOf(nodeAt([slot, 0, 'claimId', 0]))).toEqual([...CLAIM_ID_VOCABULARY]);
      expect(actionObject.type).toBe('object');
    }
  });

  it('each action slot is nullable (anyOf [object, null]) and each claimId inside it is nullable', () => {
    for (const slot of ['action1', 'action2', 'action3'] as const) {
      const variants = (nodeAt([slot]).anyOf ?? []) as JsonNode[];
      expect(variants.map((variant) => variant.type ?? 'ref')).toEqual(['ref', 'null']);
      const claimIdVariants = nodeAt([slot, 0, 'claimId']).anyOf as JsonNode[];
      expect(claimIdVariants.map((variant) => variant.type)).toEqual(['string', 'null']);
    }
  });

  it('every object node carries additionalProperties: false', () => {
    const objectNodes = allNodes(EMITTED).filter((node) => node.type === 'object');
    expect(objectNodes.length).toBeGreaterThanOrEqual(4);
    for (const node of objectNodes) {
      expect(node.additionalProperties).toBe(false);
    }
  });

  it('has no $ref cycle — the schema is non-recursive', () => {
    const defs = (EMITTED.$defs ?? {}) as Record<string, JsonNode>;
    function refsIn(node: unknown): string[] {
      return allNodes(node)
        .map((member) => member.$ref)
        .filter((ref): ref is string => typeof ref === 'string');
    }
    function visit(name: string, stack: readonly string[]): void {
      expect(stack).not.toContain(name);
      for (const ref of refsIn(defs[name])) {
        visit(ref.replace('#/$defs/', ''), [...stack, name]);
      }
    }
    for (const ref of refsIn({ ...EMITTED, $defs: undefined })) {
      visit(ref.replace('#/$defs/', ''), []);
    }
  });

  it('exactly three action slot keys exist and no property anywhere is an array of action ids', () => {
    const topLevelKeys = Object.keys(EMITTED.properties as JsonNode).sort();
    expect(topLevelKeys).toEqual(['action1', 'action2', 'action3', 'sections']);
    const arrayNodes = allNodes(EMITTED).filter((node) => node.type === 'array');
    for (const arrayNode of arrayNodes) {
      const items = arrayNode.items as JsonNode;
      const resolved = typeof items.$ref === 'string' ? resolveRef(items.$ref) : items;
      expect(vocabularyOf(resolved)).not.toEqual([...ACTION_ID_VOCABULARY]);
    }
  });

  it('the design depends on no provider-stripped constraint beyond the documented connective .min(1)', () => {
    const text = JSON.stringify(EMITTED);
    for (const keyword of ['"maxItems"', '"minimum"', '"maximum"', '"maxLength"', '"minLength"']) {
      expect(text).not.toContain(keyword);
    }
  });

  it('TRIPWIRE (found at execution): the installed SDK emits the vocabularies as description text, not as an `enum` keyword', () => {
    // `@anthropic-ai/sdk` 0.110.0's `transformJSONSchema` keeps only the keys
    // it knows (type/anyOf/$ref/properties/items/format/...) and folds every
    // other key — `enum` included — into the node's `description` as
    // `{enum: [...]}`. The API itself supports `enum`; this helper does not
    // forward it, so the closed vocabulary reaches the model as a
    // description, and is ENFORCED client-side by the Zod parse (next test)
    // and by validator rule R1. If an SDK upgrade starts forwarding `enum`,
    // this test fails on purpose: revisit plan 39-06's SUMMARY finding and
    // drop this tripwire in favour of a direct `enum` assertion.
    const claimItems = nodeAt(['sections', 'overview', 'claimIds', 'items']);
    expect(claimItems).not.toHaveProperty('enum');
    expect(String(claimItems.description)).toContain('{enum: ["c01"');
  });
});

describe('claimSelectionSchema — parse behaviour (the client-side enforcement)', () => {
  it('parses a well-formed selection', () => {
    expect(claimSelectionSchema.safeParse(WELL_FORMED).success).toBe(true);
    expect(FORMAT.parse(JSON.stringify(WELL_FORMED))).toEqual(WELL_FORMED);
  });

  it('rejects a selection naming a claim id outside the fixed vocabulary', () => {
    const outOfVocabulary = {
      ...WELL_FORMED,
      sections: {
        ...WELL_FORMED.sections,
        overview: { claimIds: ['c99'], connective: 'Open the set patient and steady.' },
      },
    };
    expect(claimSelectionSchema.safeParse(outOfVocabulary).success).toBe(false);
    expect(() => FORMAT.parse(JSON.stringify(outOfVocabulary))).toThrow();
  });

  it('rejects an action id outside the fixed vocabulary', () => {
    expect(
      claimSelectionSchema.safeParse({
        ...WELL_FORMED,
        action2: { actionId: 'a99', claimId: null },
      }).success,
    ).toBe(false);
  });

  it('rejects a section with an EMPTY connective (the .min(1) that makes the projection total) — the SDK parse THROWS, it never yields a stored record', () => {
    const emptyConnective = {
      ...WELL_FORMED,
      sections: { ...WELL_FORMED.sections, gameplan: { claimIds: ['c02'], connective: '' } },
    };
    expect(claimSelectionSchema.safeParse(emptyConnective).success).toBe(false);
    // `messages.parse` rethrows this, so the route's EXISTING catch-all
    // failure branch (one failJob, then rethrow) handles it — no new branch.
    expect(() => FORMAT.parse(JSON.stringify(emptyConnective))).toThrow(
      /Failed to parse structured output/,
    );
  });
});

// ---------------------------------------------------------------------------
// projectScoutSelection (review C1-B1)
// ---------------------------------------------------------------------------

const NULL_SUBJECT: ClaimSubject = {
  myFighterId: null,
  opponentFighterId: null,
  stageId: null,
  opponentTag: null,
};

function sampleFor(games: number): SampleMeta {
  return {
    rawSampleSize: games,
    eligibleDenominator: games,
    knownFieldCoverage: 1,
    dateRange: null,
    refreshedAt: 1_700_000_500_000,
    evidencePolicyVersion: EVIDENCE_POLICY_VERSION,
    recencyTreatment: 'unweighted',
    confidenceTier: confidenceTierFor(games),
  };
}

function claim(
  id: ClaimId,
  predicate: ClaimAtom['predicate'],
  subject: Partial<ClaimSubject>,
  value: ClaimValue,
): ClaimAtom {
  const games = value.kind === 'record' ? value.games : 6;
  return {
    id,
    predicate,
    subject: { ...NULL_SUBJECT, ...subject },
    value,
    claimKind: 'fact',
    evidenceIds: [`ev-${id}`],
    tier: confidenceTierFor(games),
    policyVersion: EVIDENCE_POLICY_VERSION,
    sample: sampleFor(games),
  };
}

// Stage ids chosen so the resolver's canonical names are unambiguous in a
// failure message: 3 = Final Destination, 1 = Battlefield, 31 = 75m.
const CLAIMS: readonly ClaimAtom[] = [
  claim(
    'c01',
    'stage_record',
    { opponentFighterId: 8, stageId: 3 },
    {
      kind: 'record',
      wins: 1,
      losses: 5,
      games: 6,
    },
  ),
  claim(
    'c02',
    'stage_record',
    { opponentFighterId: 8, stageId: 1 },
    {
      kind: 'record',
      wins: 5,
      losses: 1,
      games: 6,
    },
  ),
  claim(
    'c03',
    'stage_record',
    { opponentFighterId: 9, stageId: 3 },
    {
      kind: 'record',
      wins: 2,
      losses: 4,
      games: 6,
    },
  ),
  claim(
    'c04',
    'stage_record',
    { opponentFighterId: 9, stageId: 31 },
    {
      kind: 'record',
      wins: 3,
      losses: 3,
      games: 6,
    },
  ),
  claim(
    'c05',
    'stage_pick_rate',
    { opponentFighterId: 8, stageId: 31 },
    {
      kind: 'rate',
      numerator: 1,
      denominator: 6,
    },
  ),
  claim(
    'c06',
    'stage_record',
    { opponentFighterId: 9, stageId: null },
    {
      kind: 'record',
      wins: 0,
      losses: 6,
      games: 6,
    },
  ),
];

describe('projectScoutSelection (review C1-B1)', () => {
  it('projects a well-formed selection onto a record storedScoutReportSchema.parse ACCEPTS', () => {
    const projected = projectScoutSelection({ selection: WELL_FORMED, claims: CLAIMS });
    expect(storedScoutReportSchema.safeParse(projected).success).toBe(true);
    expect(projected).toMatchObject({
      overview: WELL_FORMED.sections.overview.connective,
      gameplan: [WELL_FORMED.sections.gameplan.connective],
      watchFor: [WELL_FORMED.sections.watchFor.connective],
    });
    expect(projected.stageStrategy.reasoning).toBe(WELL_FORMED.sections.gameplan.connective);
  });

  it('bans come from LOSING stage_record claims and picks from WINNING ones, by resolved stage name, de-duplicated in claim order', () => {
    const projected = projectScoutSelection({ selection: WELL_FORMED, claims: CLAIMS });
    expect(projected.stageStrategy.bans).toEqual([resolveSubjectDisplayName('stage', 3)]);
    expect(projected.stageStrategy.picks).toEqual([resolveSubjectDisplayName('stage', 1)]);
    expect(projected.stageStrategy.bans).toEqual(['Final Destination']);
    expect(projected.stageStrategy.picks).toEqual(['Battlefield']);
    // An even record (c04), a non-record predicate (c05) and a stage_record
    // with no stage id (c06) contribute nothing.
    expect(projected.stageStrategy.bans).not.toContain('75m');
    expect(projected.stageStrategy.picks).not.toContain('75m');
  });

  it('stage names never come from model prose — a selection naming a stage in its prose adds nothing to either list', () => {
    const prosey: ClaimSelection = {
      ...WELL_FORMED,
      sections: {
        ...WELL_FORMED.sections,
        gameplan: { claimIds: [], connective: 'Ban Smashville and pick Kalos every time.' },
      },
    };
    const projected = projectScoutSelection({ selection: prosey, claims: [] });
    expect(projected.stageStrategy.bans).toEqual([]);
    expect(projected.stageStrategy.picks).toEqual([]);
  });

  it('has no characterStrategy and no headToHead own-property, and confidenceNotes is the empty string', () => {
    const projected = projectScoutSelection({ selection: WELL_FORMED, claims: CLAIMS });
    expect(Object.prototype.hasOwnProperty.call(projected, 'characterStrategy')).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(projected, 'headToHead')).toBe(false);
    expect(projected.confidenceNotes).toBe('');
  });

  it('a stripped overview projects to the empty string and still parses; stripped list sections project to []', () => {
    const projected = projectScoutSelection({
      selection: WELL_FORMED,
      claims: CLAIMS,
      strippedSectionIds: ['overview', 'gameplan', 'watchFor'],
    });
    expect(projected.overview).toBe('');
    expect(projected.gameplan).toEqual([]);
    expect(projected.watchFor).toEqual([]);
    expect(projected.stageStrategy.reasoning).toBe('');
    expect(storedScoutReportSchema.safeParse(projected).success).toBe(true);
  });

  it('is total over an empty claim set', () => {
    const projected = projectScoutSelection({ selection: WELL_FORMED, claims: [] });
    expect(projected.stageStrategy).toEqual({
      bans: [],
      picks: [],
      reasoning: WELL_FORMED.sections.gameplan.connective,
    });
    expect(storedScoutReportSchema.safeParse(projected).success).toBe(true);
  });
});
