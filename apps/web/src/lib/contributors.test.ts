import { describe, expect, it } from 'vitest';
import {
  OWNER_CONTRIBUTOR_KEY,
  contributorKeyOf,
  contributorLabel,
  deriveContributorKeys,
  filterContributorIndices,
} from './contributors';

describe('contributorKeyOf', () => {
  it('returns the owner sentinel for an owner note (no coach)', () => {
    expect(contributorKeyOf({})).toBe(OWNER_CONTRIBUTOR_KEY);
  });

  it('returns the coach display name for a coach-authored note', () => {
    expect(contributorKeyOf({ coach: { displayName: 'Ken' } })).toBe('Ken');
  });

  it('returns the owner sentinel when coach is explicitly null', () => {
    expect(contributorKeyOf({ coach: null })).toBe(OWNER_CONTRIBUTOR_KEY);
  });
});

describe('deriveContributorKeys', () => {
  it('puts the owner sentinel first, then coaches sorted', () => {
    const notes = [
      { coach: { displayName: 'Zed' } },
      { coach: undefined },
      { coach: { displayName: 'Ann' } },
    ];
    expect(deriveContributorKeys(notes)).toEqual([OWNER_CONTRIBUTOR_KEY, 'Ann', 'Zed']);
  });

  it('returns only the owner sentinel for an owner-only list', () => {
    expect(deriveContributorKeys([{}, { coach: null }])).toEqual([OWNER_CONTRIBUTOR_KEY]);
  });

  it('returns only coaches (no sentinel) for a coach-only list', () => {
    const notes = [{ coach: { displayName: 'Ann' } }, { coach: { displayName: 'Zed' } }];
    expect(deriveContributorKeys(notes)).toEqual(['Ann', 'Zed']);
  });

  it('dedupes coach names case-insensitively, keeping first-seen casing', () => {
    const notes = [{ coach: { displayName: 'Ken' } }, { coach: { displayName: 'ken' } }];
    expect(deriveContributorKeys(notes)).toEqual(['Ken']);
  });
});

describe('filterContributorIndices', () => {
  const notes = [
    { coach: { displayName: 'Ken' } }, // 0
    {}, // 1 owner
    { coach: { displayName: 'Ann' } }, // 2
    { coach: null }, // 3 owner
  ];

  it('returns every index for a null selection', () => {
    expect(filterContributorIndices(notes, null)).toEqual([0, 1, 2, 3]);
  });

  it('returns only owner-note indices for the owner sentinel', () => {
    expect(filterContributorIndices(notes, OWNER_CONTRIBUTOR_KEY)).toEqual([1, 3]);
  });

  it('returns only a specific coach key indices', () => {
    expect(filterContributorIndices(notes, 'Ann')).toEqual([2]);
  });

  it('matches case-insensitively', () => {
    expect(filterContributorIndices(notes, 'ken')).toEqual([0]);
  });
});

describe('contributorLabel', () => {
  it('returns the passed owner label for the owner sentinel', () => {
    expect(contributorLabel(OWNER_CONTRIBUTOR_KEY, 'You')).toBe('You');
  });

  it('returns the coach key unchanged', () => {
    expect(contributorLabel('Rival Coach', 'You')).toBe('Rival Coach');
  });
});
