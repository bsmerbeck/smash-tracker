import { describe, expect, it, vi } from 'vitest';
import { render } from '@testing-library/react';
import type { GspPoint, GspSettings, Match } from '@smash-tracker/shared';
import { chartColors } from '@/lib/chartTheme';
import { GspVsGlicko } from './GspVsGlicko';

/**
 * Plan 39.1-39 (OWNER DECISION 2026-09-25, DD-11 extended to GSP): the MMR
 * line takes the series ink; the Glicko comparison line keeps its neutral
 * tick grey. The vitest alias stub for react-chartjs-2 drops every prop, so
 * this file mocks the module locally with a Line that records its `data`
 * prop (no builder export is added to the component file — that would add
 * a react-refresh lint warning).
 */
type ChartData = { datasets: Array<Record<string, unknown>> };
const captured: { data: ChartData | null } = { data: null };

vi.mock('react-chartjs-2', () => ({
  Line: (props: { data: ChartData }) => {
    captured.data = props.data;
    return <div data-testid="gsp-vs-glicko-line" />;
  },
}));

vi.mock('@/hooks/useGspLive', () => ({
  useGspLive: () => ({ data: undefined }),
}));

const DAY_MS = 24 * 60 * 60 * 1000;
const START_MS = Date.UTC(2025, 0, 6, 18);

const matches: Match[] = Array.from({ length: 12 }, (_, i) => ({
  id: `g${i}`,
  fighter_id: 8,
  opponent_id: 1,
  map: { id: 1, name: 'Battlefield' },
  opponent: 'rival',
  notes: '',
  matchType: 'quickplay',
  win: i % 3 !== 0,
  time: START_MS + i * DAY_MS,
  gsp: 9_800_000 + i * 40_000,
}));

const gspSeries: GspPoint[] = matches.map((m) => ({ time: m.time, gsp: m.gsp!, win: m.win }));
const settings: GspSettings = { eliteThreshold: 10_500_000, updatedAt: START_MS };

describe('GspVsGlicko dataset colours (DD-11, owner decision 2026-09-25)', () => {
  it('the MMR line is the series blue; the Glicko line stays the neutral tick grey', () => {
    captured.data = null;
    render(<GspVsGlicko gspSeries={gspSeries} allMatches={matches} settings={settings} />);
    expect(captured.data).not.toBeNull();
    const [mmr, glicko] = captured.data!.datasets;
    expect(mmr!.borderColor).toBe(chartColors.series);
    expect(mmr!.pointBorderColor).toBe(chartColors.series);
    expect(mmr!.borderColor).not.toBe(chartColors.red);
    expect(glicko!.borderColor).toBe(chartColors.tick);
    expect(glicko!.pointBorderColor).toBe(chartColors.tick);
  });
});
