import { describe, expect, it } from 'vitest';
import {
  INSIGHT_TEMPLATES,
  buildRateClaim,
  type Insight,
  type InsightTemplateId,
} from '@smash-tracker/shared';
import { trackRefForInsight } from './trackRef';

const EMPTY_CLAIM = buildRateClaim({
  rate: { wins: 0, losses: 0, total: 0, rate: 0 },
  refreshedAt: 0,
  dateRange: { fromMs: null, toMs: null },
});

interface InsightSpec {
  templateId: InsightTemplateId;
  scopeKey: string;
  axes?: Record<string, string | number>;
  copyKey?: string;
  copyValues?: Record<string, string | number>;
}

/** A structurally complete insight; only the fields `trackRefForInsight` reads vary. */
function insightOf(spec: InsightSpec): Insight {
  return {
    id: `${spec.templateId}:${spec.scopeKey}:last30`,
    templateId: spec.templateId,
    scopeKey: spec.scopeKey,
    horizon: 'last30',
    kind: 'fact',
    state: 'fact',
    recent: EMPTY_CLAIM,
    baseline: EMPTY_CLAIM,
    deltaPoints: null,
    window: { horizon: 'last30', fromMs: null, toMs: null, games: 0, scoped: true },
    salience: 0,
    copy: { key: spec.copyKey ?? `insights.${spec.templateId}.x`, values: spec.copyValues ?? {} },
    doors: [{ kind: 'games', axes: spec.axes ?? {}, count: 1 }],
    countedMatchIds: [],
  };
}

/** Every template id DD-09 lets carry a Track action. */
const TRACKABLE_IDS: InsightTemplateId[] = [
  'characterMovers',
  'rivalMovers',
  'formNow',
  'matchupOrPlayer',
];

describe('trackRefForInsight (DD-09)', () => {
  it('characterMovers resolves to the matchup its doors name', () => {
    const ref = trackRefForInsight(
      insightOf({
        templateId: 'characterMovers',
        scopeKey: 'character:1',
        axes: { fighter: 1, vs: 10 },
      }),
    );
    expect(ref).toEqual({
      kind: 'matchup',
      itemRef: { fighterId: 1, vsFighterId: 10 },
      nameParts: { fighterId: 1, vsFighterId: 10 },
    });
  });

  it('characterMovers at a scope with no fighter axis resolves to nothing', () => {
    expect(
      trackRefForInsight(
        insightOf({ templateId: 'characterMovers', scopeKey: 'account', axes: { vs: 10 } }),
      ),
    ).toBeNull();
  });

  it('rivalMovers resolves to the headline rival, but never to a provider-id identity', () => {
    expect(
      trackRefForInsight(
        insightOf({
          templateId: 'rivalMovers',
          scopeKey: 'character:1',
          axes: { fighter: 1, vs: 'mkleo' },
        }),
      ),
    ).toEqual({ kind: 'opponent', itemRef: 'mkleo', nameParts: { tag: 'mkleo' } });
    expect(
      trackRefForInsight(
        insightOf({
          templateId: 'rivalMovers',
          scopeKey: 'character:1',
          axes: { fighter: 1, vs: 'sgg:9fb774ae' },
        }),
      ),
    ).toBeNull();
  });

  it('formNow resolves by scope: player -> opponent, stage -> stage, pairing -> matchup', () => {
    expect(
      trackRefForInsight(insightOf({ templateId: 'formNow', scopeKey: 'player:mkleo' })),
    ).toEqual({ kind: 'opponent', itemRef: 'mkleo', nameParts: { tag: 'mkleo' } });
    expect(trackRefForInsight(insightOf({ templateId: 'formNow', scopeKey: 'stage:3' }))).toEqual({
      kind: 'stage',
      itemRef: 3,
      nameParts: { stageId: 3 },
    });
    const pairing = {
      kind: 'matchup',
      itemRef: { fighterId: 1, vsFighterId: 10 },
      nameParts: { fighterId: 1, vsFighterId: 10 },
    };
    expect(
      trackRefForInsight(insightOf({ templateId: 'formNow', scopeKey: 'character:1:10' })),
    ).toEqual(pairing);
    expect(
      trackRefForInsight(insightOf({ templateId: 'formNow', scopeKey: 'matchup:1-10' })),
    ).toEqual(pairing);
    expect(
      trackRefForInsight(
        insightOf({ templateId: 'formNow', scopeKey: 'pairing', axes: { fighter: 1, vs: 10 } }),
      ),
    ).toEqual(pairing);
  });

  it('formNow at the account scope, a single-fighter scope or the id-0 stage resolves to nothing', () => {
    for (const scopeKey of ['account', 'character:1', 'stage:0', 'stage:abc']) {
      expect(
        trackRefForInsight(insightOf({ templateId: 'formNow', scopeKey })),
        scopeKey,
      ).toBeNull();
    }
  });

  it('matchupOrPlayer resolves to the opponent only when player-driven', () => {
    expect(
      trackRefForInsight(
        insightOf({
          templateId: 'matchupOrPlayer',
          scopeKey: 'character:1:10',
          axes: { fighter: 1, vs: 10 },
          copyKey: 'insights.matchupOrPlayer.player',
          copyValues: { opponent: 'mkleo' },
        }),
      ),
    ).toEqual({ kind: 'opponent', itemRef: 'mkleo', nameParts: { tag: 'mkleo' } });
    expect(
      trackRefForInsight(
        insightOf({
          templateId: 'matchupOrPlayer',
          scopeKey: 'character:1:10',
          axes: { fighter: 1, vs: 10 },
          copyKey: 'insights.matchupOrPlayer.matchup',
          copyValues: { distinctOpponents: 4, totalGames: 20 },
        }),
      ),
    ).toBeNull();
  });

  it('covers every id in the closed template registry: the four DD-09 ids may track, all others are null', () => {
    const registryIds = INSIGHT_TEMPLATES.map((template) => template.id);
    expect(registryIds).toHaveLength(19);
    expect(TRACKABLE_IDS.every((id) => registryIds.includes(id))).toBe(true);

    for (const templateId of registryIds) {
      // A scope that WOULD resolve to a pairing, a rival and a stage if the id were allowed to.
      const tempting = insightOf({
        templateId,
        scopeKey: 'character:1:10',
        axes: { fighter: 1, vs: templateId === 'rivalMovers' ? 'mkleo' : 10, stage: 3 },
        copyKey: 'insights.matchupOrPlayer.player',
        copyValues: { opponent: 'mkleo' },
      });
      const ref = trackRefForInsight(tempting);
      if (TRACKABLE_IDS.includes(templateId)) {
        expect(ref, templateId).not.toBeNull();
      } else {
        expect(ref, templateId).toBeNull();
      }
    }
  });
});
