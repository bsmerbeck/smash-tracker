import { describe, expect, it } from 'vitest';
import { RESEARCH_MAX_PROVIDER_TEXT } from './researchIngestion.js';
import {
  SIDE_EVENT_NAME_TOKENS,
  TIER_ESTIMATE_LADDER,
  TIER_ESTIMATE_POLICY_VERSION,
  TIER_LEVEL,
  TIER_OVERRIDE_CONTRACT_VERSION,
  TIER_WORDS,
  TOURNAMENT_EVENT_TYPE_MAX_LENGTH,
  ULTRANK_TO_APP_TIER,
  deriveEventKind,
  deriveSetting,
  estimateTierFromEntrants,
  resolveTournamentTier,
  tierLevel,
  tierOverrideResponseSchema,
  tierOverrideStoredSchema,
  tierOverrideUpdateBodySchema,
  type TierEntryFields,
  type TierUnknownReason,
} from './tournamentTier.js';

function entry(overrides: Partial<TierEntryFields> = {}): TierEntryFields {
  return { eventName: 'Ultimate Singles', ...overrides };
}

describe('vocabulary and versions', () => {
  it('declares the six-word vocabulary with unknown last, and the versions at 1', () => {
    expect(TIER_WORDS).toEqual(['supermajor', 'major', 'minor', 'regional', 'local', 'unknown']);
    expect(TIER_ESTIMATE_POLICY_VERSION).toBe(1);
    expect(TIER_OVERRIDE_CONTRACT_VERSION).toBe(1);
  });

  it('orders levels local 1 .. supermajor 5 and reports unknown as 0', () => {
    expect(TIER_LEVEL).toEqual({ local: 1, regional: 2, minor: 3, major: 4, supermajor: 5 });
    expect(tierLevel('unknown')).toBe(0);
    expect(tierLevel('supermajor')).toBe(5);
  });

  it('maps UltRank D to regional (D-03, owner-locked) and covers every letter', () => {
    expect(ULTRANK_TO_APP_TIER.D).toBe('regional');
    expect(Object.keys(ULTRANK_TO_APP_TIER).sort()).toEqual(
      ['A', 'A+', 'B', 'B+', 'C', 'D', 'P', 'P+', 'S', 'S+', 'SP'].sort(),
    );
  });

  it('keeps the event-type bound equal to the research-source provider text bound', () => {
    expect(TOURNAMENT_EVENT_TYPE_MAX_LENGTH).toBe(RESEARCH_MAX_PROVIDER_TEXT);
  });

  it('lists the side-event tokens', () => {
    expect([...SIDE_EVENT_NAME_TOKENS]).toEqual([
      'squad strike',
      'doubles',
      'teams',
      'crews',
      'ladder',
      'amateur',
      'redemption',
      'low tier',
      'random',
    ]);
  });
});

describe('estimateTierFromEntrants — D-01 ladder boundaries', () => {
  it.each([
    [0, 'local'],
    [63, 'local'],
    [64, 'regional'],
    [255, 'regional'],
    [256, 'minor'],
    [511, 'minor'],
    [512, 'major'],
    [1023, 'major'],
    [1024, 'supermajor'],
    [8158, 'supermajor'],
  ] as const)('%i entrants -> %s', (entrants, tier) => {
    expect(estimateTierFromEntrants(entrants)).toBe(tier);
  });

  it('exports the ladder ascending so the calibration oracle can pass a mutated copy', () => {
    expect(TIER_ESTIMATE_LADDER).toEqual([
      { tier: 'local', minEntrants: 0 },
      { tier: 'regional', minEntrants: 64 },
      { tier: 'minor', minEntrants: 256 },
      { tier: 'major', minEntrants: 512 },
      { tier: 'supermajor', minEntrants: 1024 },
    ]);
    const halved = TIER_ESTIMATE_LADDER.map((rung) => ({
      ...rung,
      minEntrants: Math.floor(rung.minEntrants / 2),
    }));
    expect(estimateTierFromEntrants(600, halved)).toBe('supermajor');
    expect(estimateTierFromEntrants(600)).toBe('major');
  });
});

describe('deriveEventKind and deriveSetting', () => {
  it('matches side-event tokens as whole words or phrases, case-insensitively', () => {
    expect(deriveEventKind('Squad Strike')).toBe('side-event');
    expect(deriveEventKind('Ultimate Doubles')).toBe('side-event');
    expect(deriveEventKind('Low Tier Ultimate')).toBe('side-event');
    expect(deriveEventKind('Ultimate Singles')).toBe('main');
    expect(deriveEventKind('Ultimate Singles Redemption Bracket')).toBe('side-event');
    expect(deriveEventKind('Randomizer Cup')).toBe('main');
    expect(deriveEventKind('   ')).toBe('unknown');
    expect(deriveEventKind('')).toBe('unknown');
  });

  it('decides setting from the stored boolean, then observed online evidence, else unknown', () => {
    expect(deriveSetting({ isOnline: false })).toBe('offline');
    expect(deriveSetting({ isOnline: true })).toBe('online');
    expect(deriveSetting({ isOnline: false, observedOnline: true })).toBe('offline');
    expect(deriveSetting({ isOnline: undefined, observedOnline: true })).toBe('online');
    expect(deriveSetting({ isOnline: null, observedOnline: false })).toBe('unknown');
    expect(deriveSetting({})).toBe('unknown');
  });
});

describe('resolveTournamentTier — estimate rung and the F2 gate', () => {
  it('resolves an offline 1,581-entrant main event to an estimated supermajor', () => {
    const r = resolveTournamentTier({ entry: entry({ numEntrants: 1581, isOnline: false }) });
    expect(r).toMatchObject({
      tier: 'supermajor',
      level: 5,
      basis: 'estimated',
      source: 'heuristic',
      setting: 'offline',
      eventKind: 'main',
      reason: null,
      entrants: 1581,
      ignoredOverrideReason: null,
      policyVersion: TIER_ESTIMATE_POLICY_VERSION,
    });
    expect(r.estimate).toEqual({ tier: 'supermajor', entrants: 1581 });
  });

  it('never estimates an online 5,605-entrant event (reason online)', () => {
    const r = resolveTournamentTier({ entry: entry({ numEntrants: 5605, isOnline: true }) });
    expect(r).toMatchObject({
      tier: 'unknown',
      level: 0,
      basis: 'unknown',
      source: 'none',
      reason: 'online',
      estimate: null,
    });
  });

  it('never estimates an unknown-setting 8,158-entrant event (reason settingUnknown)', () => {
    const r = resolveTournamentTier({ entry: entry({ numEntrants: 8158 }) });
    expect(r).toMatchObject({ tier: 'unknown', basis: 'unknown', reason: 'settingUnknown' });
  });

  it('treats observed online-tourney evidence as online for an entry with no stored isOnline', () => {
    const r = resolveTournamentTier({
      entry: entry({ numEntrants: 8158 }),
      observedOnline: true,
    });
    expect(r).toMatchObject({ tier: 'unknown', setting: 'online', reason: 'online' });
  });

  it('resolves a side event to unknown/sideEvent and never inherits a tier', () => {
    const r = resolveTournamentTier({
      entry: entry({ eventName: 'Squad Strike', numEntrants: 900, isOnline: false }),
    });
    expect(r).toMatchObject({
      tier: 'unknown',
      eventKind: 'side-event',
      reason: 'sideEvent',
      estimate: null,
    });
  });

  it('resolves an event with no numEntrants to unknown/noEntrants', () => {
    const r = resolveTournamentTier({ entry: entry({ isOnline: false }) });
    expect(r).toMatchObject({ tier: 'unknown', reason: 'noEntrants', entrants: null });
  });

  it('reports the FIRST applicable reason in the order online, sideEvent, noEntrants, settingUnknown', () => {
    const reasons: TierUnknownReason[] = [
      resolveTournamentTier({
        entry: entry({ eventName: 'Doubles', isOnline: true }),
      }).reason as TierUnknownReason,
      resolveTournamentTier({
        entry: entry({ eventName: 'Doubles', isOnline: false }),
      }).reason as TierUnknownReason,
      resolveTournamentTier({ entry: entry({ isOnline: false }) }).reason as TierUnknownReason,
      resolveTournamentTier({ entry: entry() }).reason as TierUnknownReason,
      resolveTournamentTier({
        entry: entry({ tierOverride: { contractVersion: 1, tier: 'unknown', setAtMs: 1 } }),
      }).reason as TierUnknownReason,
    ];
    expect(reasons).toEqual(['online', 'sideEvent', 'noEntrants', 'settingUnknown', 'manual']);
  });

  it.each(['registry-row-shape', 'legacy-shape'] as const)(
    'accepts both row shapes structurally (%s)',
    (shape) => {
      const fields: TierEntryFields =
        shape === 'registry-row-shape'
          ? { eventName: 'Ultimate Singles', numEntrants: null, isOnline: null, eventType: null }
          : { eventName: 'Ultimate Singles', numEntrants: 100, isOnline: false };
      expect(resolveTournamentTier({ entry: fields }).tier).toBe(
        shape === 'legacy-shape' ? 'regional' : 'unknown',
      );
    },
  );
});

describe('resolveTournamentTier — manual override and the reserved external rung', () => {
  it('resolves a stored override as manual and carries the hidden estimate', () => {
    const r = resolveTournamentTier({
      entry: entry({
        numEntrants: 1581,
        isOnline: false,
        tierOverride: { contractVersion: 1, tier: 'major', setAtMs: 1_700_000_000_000 },
      }),
    });
    expect(r).toMatchObject({ tier: 'major', level: 4, basis: 'manual', source: 'manual' });
    expect(r.estimate).toEqual({ tier: 'supermajor', entrants: 1581 });
    expect(r.reason).toBeNull();
  });

  it('lets an override win even for an online or side event', () => {
    const r = resolveTournamentTier({
      entry: entry({
        eventName: 'Doubles',
        numEntrants: 5605,
        isOnline: true,
        tierOverride: { contractVersion: 1, tier: 'minor', setAtMs: 1 },
      }),
    });
    expect(r).toMatchObject({ tier: 'minor', basis: 'manual' });
    expect(r.estimate).toBeNull();
  });

  it('resolves an override of unknown as manual with reason manual', () => {
    const r = resolveTournamentTier({
      entry: entry({
        numEntrants: 300,
        isOnline: false,
        tierOverride: { contractVersion: 1, tier: 'unknown', setAtMs: 1 },
      }),
    });
    expect(r).toMatchObject({
      tier: 'unknown',
      level: 0,
      basis: 'manual',
      source: 'manual',
      reason: 'manual',
    });
    expect(r.estimate).toEqual({ tier: 'minor', entrants: 300 });
  });

  it('ignores an override with a newer contractVersion WHOLE and reports why', () => {
    const r = resolveTournamentTier({
      entry: entry({
        numEntrants: 300,
        isOnline: false,
        tierOverride: {
          contractVersion: TIER_OVERRIDE_CONTRACT_VERSION + 1,
          tier: 'supermajor',
          setAtMs: 1,
        },
      }),
    });
    expect(r).toMatchObject({
      tier: 'minor',
      basis: 'estimated',
      ignoredOverrideReason: 'unsupported-contract-version',
    });
  });

  it('resolves an externalTierRow as recorded, carrying its source and reference', () => {
    const r = resolveTournamentTier({
      entry: entry({ numEntrants: 100, isOnline: false }),
      externalTierRow: {
        tier: 'major',
        source: 'liquipedia',
        sourceRef: { pageTitle: 'Supernova/2026', revisionId: 42 },
      },
    });
    expect(r).toMatchObject({
      tier: 'major',
      basis: 'recorded',
      source: 'liquipedia',
      sourceRef: { pageTitle: 'Supernova/2026', revisionId: 42 },
    });
    expect(r.estimate).toEqual({ tier: 'regional', entrants: 100 });
  });

  it('lets a manual override beat an externalTierRow', () => {
    const r = resolveTournamentTier({
      entry: entry({ tierOverride: { contractVersion: 1, tier: 'local', setAtMs: 1 } }),
      externalTierRow: { tier: 'major', source: 'ultrank' },
    });
    expect(r).toMatchObject({ tier: 'local', basis: 'manual', source: 'manual' });
  });

  it('falls through to the external rung when the override is ignored', () => {
    const r = resolveTournamentTier({
      entry: entry({ tierOverride: { contractVersion: 99, tier: 'local', setAtMs: 1 } }),
      externalTierRow: { tier: 'major', source: 'ultrank' },
    });
    expect(r).toMatchObject({
      tier: 'major',
      basis: 'recorded',
      source: 'ultrank',
      ignoredOverrideReason: 'unsupported-contract-version',
    });
  });
});

describe('override schemas', () => {
  it('stores contractVersion, tier and setAtMs; rejects an unknown tier word', () => {
    expect(
      tierOverrideStoredSchema.safeParse({ contractVersion: 1, tier: 'major', setAtMs: 5 }).success,
    ).toBe(true);
    expect(
      tierOverrideStoredSchema.safeParse({ contractVersion: 1, tier: 'huge', setAtMs: 5 }).success,
    ).toBe(false);
    expect(
      tierOverrideStoredSchema.safeParse({ contractVersion: 1, tier: 'major', setAtMs: -1 })
        .success,
    ).toBe(false);
  });

  it('accepts a body of { tierOverride: { tier } | null } and never a client-supplied version', () => {
    expect(tierOverrideUpdateBodySchema.parse({ tierOverride: { tier: 'minor' } })).toEqual({
      tierOverride: { tier: 'minor' },
    });
    expect(tierOverrideUpdateBodySchema.parse({ tierOverride: null })).toEqual({
      tierOverride: null,
    });
    expect(
      tierOverrideUpdateBodySchema.parse({
        tierOverride: { tier: 'minor', contractVersion: 9, setAtMs: 9 },
      }),
    ).toEqual({ tierOverride: { tier: 'minor' } });
    expect(tierOverrideUpdateBodySchema.safeParse({}).success).toBe(false);
  });

  it('shapes the response as entryKey plus an optional stored override', () => {
    expect(tierOverrideResponseSchema.parse({ entryKey: '987' })).toEqual({ entryKey: '987' });
    expect(tierOverrideResponseSchema.safeParse({ entryKey: '' }).success).toBe(false);
  });
});
