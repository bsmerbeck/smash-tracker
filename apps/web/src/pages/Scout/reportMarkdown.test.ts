import { describe, expect, it } from 'vitest';
import type { ScoutReportRecord } from '@smash-tracker/shared';
import {
  CLAIMS_ERA_RECORD,
  GAMEPLAN_CONNECTIVE,
  OVERVIEW_CONNECTIVE,
} from '@/test/claimReportFixtures';
import { reportMarkdownFilename, reportToMarkdown } from './reportMarkdown';

const BASE_RECORD: ScoutReportRecord = {
  id: 'r1',
  createdAt: Date.UTC(2026, 6, 5), // 2026-07-05
  model: 'claude-opus-4-8',
  player: { id: 1802316, gamerTag: 'Pandem1c', userSlug: 'user/07dc2239' },
  report: {
    overview: 'A fast-falling Fox/Falco player who plays aggressively.',
    gameplan: ['Punish landing lag hard.', 'Avoid neutral vs their dash dance.'],
    characterStrategy: {
      picks: ['Mario'],
      reasoning: 'Game 1: Mario; if they swap to Falco, keep Mario.',
    },
    stageStrategy: {
      bans: ['Final Destination'],
      picks: ['Battlefield'],
      reasoning: 'They perform best on flat stages with no platforms.',
    },
    headToHead: 'You are 2-1 against this player, all on Battlefield.',
    watchFor: ['Likes to shine spike off stage.'],
    confidenceNotes: 'Only 20 games sampled — treat character splits as light samples.',
  },
};

describe('reportToMarkdown', () => {
  it('renders an H1 with gamer tag and date, and an H2 per section', () => {
    const md = reportToMarkdown(BASE_RECORD);

    expect(md).toMatch(/^# Scout Report: Pandem1c/);
    expect(md).toContain('## Overview');
    expect(md).toContain('## Game plan');
    expect(md).toContain('## Character strategy');
    expect(md).toContain('## Stage strategy');
    expect(md).toContain('## Head-to-head');
    expect(md).toContain('## Watch for');
    expect(md).toContain('## Confidence notes');
  });

  it('includes all report content', () => {
    const md = reportToMarkdown(BASE_RECORD);

    expect(md).toContain('A fast-falling Fox/Falco player who plays aggressively.');
    expect(md).toContain('- Punish landing lag hard.');
    expect(md).toContain('- Avoid neutral vs their dash dance.');
    expect(md).toContain('Picks: Mario');
    expect(md).toContain('Game 1: Mario; if they swap to Falco, keep Mario.');
    expect(md).toContain('Bans: Final Destination');
    expect(md).toContain('Picks: Battlefield');
    expect(md).toContain('They perform best on flat stages with no platforms.');
    expect(md).toContain('You are 2-1 against this player, all on Battlefield.');
    expect(md).toContain('- Likes to shine spike off stage.');
    expect(md).toContain('Only 20 games sampled — treat character splits as light samples.');
  });

  it('omits the character strategy section when absent (pre-B.1 stored record)', () => {
    const record: ScoutReportRecord = {
      ...BASE_RECORD,
      report: { ...BASE_RECORD.report, characterStrategy: undefined },
    };
    const md = reportToMarkdown(record);

    expect(md).not.toContain('## Character strategy');
  });

  it('omits the head-to-head section when null', () => {
    const record: ScoutReportRecord = {
      ...BASE_RECORD,
      report: { ...BASE_RECORD.report, headToHead: null },
    };
    const md = reportToMarkdown(record);

    expect(md).not.toContain('## Head-to-head');
  });
});

/**
 * Plan 39-09 (review C2-H4): the LEGACY export path is byte-identical to the
 * pre-Phase-39 builder. This literal was captured from the builder as it
 * stood at 7ad0089b (before plan 39-09 touched it) for `BASE_RECORD` above,
 * and was run green against that unmodified builder before the claims-era
 * branch was added. Plan 39-10 extends this module additively (D-20's
 * withheld-prose line, claims-era only) — re-assert this pin, never rewrite it.
 */
const LEGACY_BASELINE_MARKDOWN = [
  `# Scout Report: Pandem1c — ${new Date(BASE_RECORD.createdAt).toLocaleDateString()}`,
  '',
  '## Overview',
  'A fast-falling Fox/Falco player who plays aggressively.',
  '',
  '## Game plan',
  '- Punish landing lag hard.',
  '- Avoid neutral vs their dash dance.',
  '',
  '## Character strategy',
  'Picks: Mario',
  '',
  'Game 1: Mario; if they swap to Falco, keep Mario.',
  '',
  '## Stage strategy',
  'Bans: Final Destination',
  'Picks: Battlefield',
  '',
  'They perform best on flat stages with no platforms.',
  '',
  '## Head-to-head',
  'You are 2-1 against this player, all on Battlefield.',
  '',
  '## Watch for',
  '- Likes to shine spike off stage.',
  '',
  '## Confidence notes',
  'Only 20 games sampled — treat character splits as light samples.',
].join('\n');

/**
 * Code review IN-05: English mirror of `reports.legacy.badge` + `.explain` —
 * the provenance label the card shows on every record that is not validated.
 * The export appends it AFTER the pinned body, so the pin above stays an exact
 * byte prefix of the legacy export.
 */
const LEGACY_LINE =
  "Legacy: generated before this app's report validator existed — its content wasn't machine-checked against your match data.";

describe('reportToMarkdown — legacy byte identity (plan 39-09, C2-H4)', () => {
  it('renders a legacy record (no claims, no sections) byte-identically to the pre-Phase-39 builder, then the legacy label (IN-05)', () => {
    expect(reportToMarkdown(BASE_RECORD)).toBe(`${LEGACY_BASELINE_MARKDOWN}\n\n${LEGACY_LINE}`);
  });
});

/** Every `## ` heading must be followed by at least one non-blank line before the next heading or the end. */
function emptyHeadings(markdown: string): string[] {
  const lines = markdown.split('\n');
  const empty: string[] = [];
  lines.forEach((line, index) => {
    if (!line.startsWith('## ')) return;
    const rest = lines.slice(index + 1);
    const next = rest.findIndex((candidate) => candidate.startsWith('## '));
    const body = next === -1 ? rest : rest.slice(0, next);
    if (!body.some((candidate) => candidate.trim().length > 0)) empty.push(line);
  });
  return empty;
}

describe('reportToMarkdown — claims-era record (plan 39-09, C2-H4)', () => {
  it("carries each surviving claim's FIGURE, sample and tier, read from the claim object", () => {
    const md = reportToMarkdown(CLAIMS_ERA_RECORD);

    expect(md).toContain(
      '- [Fact] Stage record: Battlefield — 34–21 · 62% · 55 games · medium confidence',
    );
    expect(md).toContain(
      '- [Trend] Their character usage: Donkey Kong — 60% (12/20) · 20 games · low confidence',
    );
    expect(md).toContain(
      '- [Fact] Head-to-head record: Pandem1c — 7–3 · 70% · 10 games · medium confidence',
    );
  });

  it("never takes a figure from the connective: the prose's numbers appear only inside the prose line", () => {
    const md = reportToMarkdown(CLAIMS_ERA_RECORD);
    const claimLines = md.split('\n').filter((line) => line.startsWith('- ['));
    expect(claimLines.length).toBeGreaterThan(0);
    for (const line of claimLines) {
      expect(line).not.toMatch(/9-1|90%/);
    }
    expect(md).toContain(GAMEPLAN_CONNECTIVE);
  });

  it('orders claims as stored, renders only surviving claims in a partially-abstained section, and the abstention sentence for an all-abstained one', () => {
    const md = reportToMarkdown(CLAIMS_ERA_RECORD);
    const gameplan = md.slice(md.indexOf('## Game plan'), md.indexOf('## Stage strategy'));
    expect(gameplan.indexOf('Stage record')).toBeLessThan(
      gameplan.indexOf('Their character usage'),
    );
    expect(gameplan).not.toContain('Not enough data yet');
    expect(gameplan).not.toContain('Matchup record');

    const watchFor = md.slice(md.indexOf('## Watch for'));
    expect(watchFor).toContain('Not enough data yet — 2 more games needed.');
    expect(watchFor).not.toContain('- [');
  });

  it('contains NO heading whose body is empty — no `## Confidence notes` when confidenceNotes is empty', () => {
    const md = reportToMarkdown(CLAIMS_ERA_RECORD);
    expect(md).not.toContain('## Confidence notes');
    expect(emptyHeadings(md)).toEqual([]);
  });

  it('leads a section with its connective and does not restate the projected stage reasoning', () => {
    const md = reportToMarkdown(CLAIMS_ERA_RECORD);
    expect(md).toContain(`## Overview\n${OVERVIEW_CONNECTIVE}\n- [Fact] Head-to-head record`);
    expect(md).toContain('## Stage strategy\nPicks: Battlefield\n\n## Watch for');
    expect(md.split(GAMEPLAN_CONNECTIVE)).toHaveLength(2);
  });

  it('suppresses an empty heading on the legacy path too', () => {
    const md = reportToMarkdown({
      ...BASE_RECORD,
      report: { ...BASE_RECORD.report, watchFor: [], confidenceNotes: '' },
    });
    expect(md).not.toContain('## Watch for');
    expect(md).not.toContain('## Confidence notes');
    expect(emptyHeadings(md)).toEqual([]);
  });
});

describe('reportMarkdownFilename', () => {
  it('builds a filename from the gamer tag and creation date', () => {
    expect(reportMarkdownFilename(BASE_RECORD)).toBe('scout-report-pandem1c-2026-07-05.md');
  });

  it('slugifies gamer tags with spaces and punctuation', () => {
    const record: ScoutReportRecord = {
      ...BASE_RECORD,
      player: { ...BASE_RECORD.player, gamerTag: 'Pandem1c | TSM' },
    };
    expect(reportMarkdownFilename(record)).toBe('scout-report-pandem1c-tsm-2026-07-05.md');
  });
});

/**
 * Plan 39-10 (decision D-20): the withheld-prose disclosure reaches the copy
 * the reader keeps. Claims-era, validated records only; the legacy pin above
 * must keep passing unchanged.
 */
describe('reportToMarkdown — withheld-prose disclosure line (plan 39-10, D-20)', () => {
  const ONE =
    "Commentary for 1 section was withheld because it couldn't be verified against your match data.";
  const TWO =
    "Commentary for 2 sections was withheld because it couldn't be verified against your match data.";
  const PREFIX = 'Commentary for ';

  function withCount(count: unknown): ScoutReportRecord {
    return {
      ...CLAIMS_ERA_RECORD,
      report: {
        ...CLAIMS_ERA_RECORD.report,
        strippedSectionCount: count as number | undefined,
      },
    };
  }

  function occurrences(markdown: string, needle: string): number {
    return markdown.split(needle).length - 1;
  }

  it('a claims-era record with strippedSectionCount 1 carries the singular line exactly once, last', () => {
    const md = reportToMarkdown(withCount(1));
    expect(occurrences(md, ONE)).toBe(1);
    expect(md.endsWith(`\n\n${ONE}`)).toBe(true);
    expect(emptyHeadings(md)).toEqual([]);
  });

  it('a claims-era record with strippedSectionCount 2 carries the plural line exactly once', () => {
    const md = reportToMarkdown(withCount(2));
    expect(occurrences(md, TWO)).toBe(1);
    expect(occurrences(md, PREFIX)).toBe(1);
  });

  it.each([
    { label: 'absent', count: undefined },
    { label: '0', count: 0 },
    { label: '-1', count: -1 },
    { label: '1.5', count: 1.5 },
    { label: 'NaN', count: Number.NaN },
  ])(
    'a claims-era record with strippedSectionCount $label carries no disclosure line',
    ({ count }) => {
      const md = reportToMarkdown(withCount(count));
      expect(md).not.toContain(PREFIX);
      expect(md).not.toContain('NaN');
    },
  );

  it('a claims-era record that is NOT validated (half-written) carries no line even with a positive count', () => {
    const md = reportToMarkdown({
      ...CLAIMS_ERA_RECORD,
      report: { ...CLAIMS_ERA_RECORD.report, validation: undefined, strippedSectionCount: 2 },
    });
    expect(md).not.toContain(PREFIX);
  });

  it('the LEGACY path is untouched: a legacy record with a stray count still equals the 39-09 byte-identity pin plus the legacy label (IN-05)', () => {
    const legacyWithCount: ScoutReportRecord = {
      ...BASE_RECORD,
      report: { ...BASE_RECORD.report, strippedSectionCount: 3 },
    };
    expect(reportToMarkdown(legacyWithCount)).toBe(`${LEGACY_BASELINE_MARKDOWN}\n\n${LEGACY_LINE}`);
    expect(reportToMarkdown(BASE_RECORD)).toBe(`${LEGACY_BASELINE_MARKDOWN}\n\n${LEGACY_LINE}`);
  });
});

/**
 * Code review IN-05: the export is the copy a paying user keeps, so it
 * discloses what the card discloses — the legacy provenance label
 * (`LegacyReportBadge`, shown for every record `isValidatedRecord` rejects)
 * and the dropped-claims line (`DroppedClaimsNote`, shown from the stored
 * count, which since SH-WR-05 counts claims only). Order matches the card:
 * legacy label, dropped claims, withheld commentary — all after the body.
 */
describe('reportToMarkdown — legacy label and dropped-claims line (code review IN-05)', () => {
  const DROPPED_ONE = "1 claim couldn't be verified and was removed from this report.";
  const DROPPED_TWO = "2 claims couldn't be verified and were removed from this report.";
  const DROPPED_SUFFIX = 'removed from this report.';
  const WITHHELD_ONE =
    "Commentary for 1 section was withheld because it couldn't be verified against your match data.";

  function occurrences(markdown: string, needle: string): number {
    return markdown.split(needle).length - 1;
  }

  function withDropped(count: unknown): ScoutReportRecord {
    return {
      ...CLAIMS_ERA_RECORD,
      report: { ...CLAIMS_ERA_RECORD.report, droppedClaimCount: count as number | undefined },
    };
  }

  it('a validated claims-era record carries NO legacy label', () => {
    expect(reportToMarkdown(CLAIMS_ERA_RECORD)).not.toContain(LEGACY_LINE);
  });

  it('a legacy record carries the legacy label exactly once, last', () => {
    const md = reportToMarkdown(BASE_RECORD);
    expect(occurrences(md, LEGACY_LINE)).toBe(1);
    expect(md.endsWith(`\n\n${LEGACY_LINE}`)).toBe(true);
  });

  it('a half-written claims-era record (no validation block) is labelled legacy, fail-closed like the card', () => {
    const md = reportToMarkdown({
      ...CLAIMS_ERA_RECORD,
      report: { ...CLAIMS_ERA_RECORD.report, validation: undefined },
    });
    expect(occurrences(md, LEGACY_LINE)).toBe(1);
  });

  it('droppedClaimCount 1 carries the singular line exactly once', () => {
    const md = reportToMarkdown(withDropped(1));
    expect(occurrences(md, DROPPED_ONE)).toBe(1);
    expect(occurrences(md, DROPPED_SUFFIX)).toBe(1);
  });

  it('droppedClaimCount 2 carries the plural line exactly once, before the withheld-prose line', () => {
    const md = reportToMarkdown(withDropped(2));
    expect(occurrences(md, DROPPED_TWO)).toBe(1);
    expect(md.endsWith(`\n\n${DROPPED_TWO}\n\n${WITHHELD_ONE}`)).toBe(true);
  });

  it.each([
    { label: 'absent', count: undefined },
    { label: '0', count: 0 },
    { label: '-1', count: -1 },
    { label: '1.5', count: 1.5 },
    { label: 'NaN', count: Number.NaN },
  ])('droppedClaimCount $label carries no dropped-claims line', ({ count }) => {
    const md = reportToMarkdown(withDropped(count));
    expect(md).not.toContain(DROPPED_SUFFIX);
    expect(md).not.toContain('NaN');
  });
});
