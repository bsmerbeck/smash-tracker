import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { DEFAULT_RULESET, resolveRuleset, type ResolvedRuleset } from '@smash-tracker/shared';
import { getStageById } from '@/data/stages';
import { RulesetDetailList } from './RulesetDetailList';

describe('RulesetDetailList', () => {
  it('renders the default strike order on its own row, never interpolated into another sentence', () => {
    const { container } = render(<RulesetDetailList resolved={resolveRuleset(undefined)} />);
    expect(screen.getByText('Strike order')).toBeInTheDocument();
    expect(screen.getByText(DEFAULT_RULESET.strikeOrder)).toBeInTheDocument();
    expect(container.textContent).not.toMatch(/is played\. strike/);
    expect(container.textContent).not.toMatch(/ strike, /);
  });

  it('lists starters and counterpicks by name, each list on its own row', () => {
    render(<RulesetDetailList resolved={resolveRuleset(undefined)} />);
    const starterNames = DEFAULT_RULESET.starterStageIds.map((id) => getStageById(id)?.name);
    expect(screen.getByText(starterNames.join(', '))).toBeInTheDocument();
    const counterpickNames = DEFAULT_RULESET.counterpickStageIds.map(
      (id) => getStageById(id)?.name,
    );
    expect(screen.getByText(counterpickNames.join(', '))).toBeInTheDocument();
  });

  it('renders a non-default strike order verbatim and an empty counterpick list as None', () => {
    const resolved: ResolvedRuleset = {
      ...resolveRuleset(undefined),
      source: 'event-override',
      ruleset: { ...DEFAULT_RULESET, counterpickStageIds: [], strikeOrder: 'Custom 1-2 strike.' },
    };
    render(<RulesetDetailList resolved={resolved} />);
    expect(screen.getByText('Custom 1-2 strike.')).toBeInTheDocument();
    expect(screen.getByText('None')).toBeInTheDocument();
    expect(
      screen.getByText('Custom ruleset for this event; unchanged rules follow the house default.'),
    ).toBeInTheDocument();
    expect(screen.queryByText(/House convention/)).not.toBeInTheDocument();
  });

  it('never names a tournament organiser official ruleset (D-17)', () => {
    const { container } = render(<RulesetDetailList resolved={resolveRuleset(undefined)} />);
    expect(container.textContent).not.toMatch(/official|sanctioned/i);
  });
});
