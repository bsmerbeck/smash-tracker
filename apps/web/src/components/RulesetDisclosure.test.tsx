import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { resolveRuleset, DEFAULT_RULESET } from '@smash-tracker/shared';
import { TooltipProvider } from '@/components/ui/tooltip';
import { RulesetDisclosure } from './RulesetDisclosure';

function renderDisclosure(resolved: ReturnType<typeof resolveRuleset>) {
  return render(
    <TooltipProvider>
      <RulesetDisclosure resolved={resolved} />
    </TooltipProvider>,
  );
}

describe('RulesetDisclosure', () => {
  it('opening the control renders the preset display name and a detail line with the starter/ban counts, DSR, set format, source and date', async () => {
    const user = userEvent.setup();
    const resolved = resolveRuleset(undefined);
    renderDisclosure(resolved);

    const trigger = screen.getByRole('button', {
      name: 'View the ruleset assumption behind these stage recommendations',
    });
    expect(trigger.textContent).toContain('House default (SSBU)');
    await user.click(trigger);

    const detail = screen.getByText(
      new RegExp(`${DEFAULT_RULESET.starterStageIds.length} starters`),
    );
    expect(detail.textContent).toContain(
      `${DEFAULT_RULESET.banCounts[DEFAULT_RULESET.setFormat.default]} ban`,
    );
    expect(detail.textContent).toContain('modified DSR');
    expect(detail.textContent).toContain('Best of 3');
    expect(detail.textContent).toContain(DEFAULT_RULESET.source.url);
    expect(detail.textContent).toContain(DEFAULT_RULESET.source.retrievedAt);
  });

  it('renders zero override badges for the default-preset source', () => {
    renderDisclosure(resolveRuleset(undefined));
    expect(screen.queryByText('Event override')).not.toBeInTheDocument();
  });

  it('renders exactly one override badge when the resolved source is an event override', () => {
    const resolved = resolveRuleset({ contractVersion: 1, dsr: 'none' });
    renderDisclosure(resolved);
    expect(screen.getAllByText('Event override')).toHaveLength(1);
  });

  it('renders the ignored-override sentence when the resolver reported an ignored override', async () => {
    const user = userEvent.setup();
    const resolved = resolveRuleset({ contractVersion: 999 });
    expect(resolved.ignoredOverrideReason).toBe('unsupported-contract-version');
    renderDisclosure(resolved);

    await user.click(screen.getByRole('button'));
    expect(
      screen.getByText(
        "This event's saved ruleset was written by a newer version of the app and is not being applied.",
      ),
    ).toBeInTheDocument();
  });
});
