import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import type { StageRecord } from '@/lib/stats';
import { ScoutingStagesCard } from './ScoutingStagesCard';

function makeRecord(overrides: Partial<StageRecord> = {}): StageRecord {
  return { stageId: 1, wins: 3, losses: 1, total: 4, winRate: 75, ...overrides };
}

describe('ScoutingStagesCard', () => {
  it('renders the empty state when there are no stage records', () => {
    render(<ScoutingStagesCard byStage={[]} />);
    expect(screen.getByText('No stage data recorded yet.')).toBeInTheDocument();
  });

  it("a row's destination is the stage detail path for that stage id", () => {
    const records = [makeRecord({ stageId: 1 })];
    render(
      <MemoryRouter>
        <ScoutingStagesCard byStage={records} stageHref={(id) => `/stages/${id}`} />
      </MemoryRouter>,
    );
    const link = screen.getByRole('link');
    expect(link).toHaveAttribute('href', '/stages/1');
  });

  it('the unknown-stage row (stageId 0) renders plain text — no chevron, no link', () => {
    const records = [makeRecord({ stageId: 0 })];
    render(
      <MemoryRouter>
        <ScoutingStagesCard byStage={records} stageHref={(id) => `/stages/${id}`} />
      </MemoryRouter>,
    );
    expect(screen.getByText('unknown')).toBeInTheDocument();
    expect(screen.queryByRole('link')).not.toBeInTheDocument();
  });

  it('renders plain rows when no stageHref is supplied', () => {
    const records = [makeRecord({ stageId: 1 })];
    render(<ScoutingStagesCard byStage={records} />);
    expect(screen.queryByRole('link')).not.toBeInTheDocument();
  });

  it('keeps the top-six cap and the order given by the caller', () => {
    const records = Array.from({ length: 8 }, (_, i) =>
      makeRecord({ stageId: i + 1, total: 8 - i }),
    );
    render(<ScoutingStagesCard byStage={records} />);
    expect(screen.getAllByRole('row')).toHaveLength(7); // header + top 6
  });
});
