import { describe, expect, it } from 'vitest';
import type { ScoutReportRecord } from '@smash-tracker/shared';
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
