import { describe, expect, it } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import { TOURNAMENT_LEGAL_STAGE_IDS } from '@smash-tracker/shared';
import { Select, SelectContent } from '@/components/ui/select';
import { StageSelectGroups } from '@/components/StageSelectGroups';
import { getGroupedStageOptions } from '@/lib/stageOptions';

// Same literal used in stageOptions.test.ts — kept independent of the
// constant under test so a typo'd id or renamed stage is actually caught.
const EXPECTED_TOURNAMENT_LEGAL_STAGE_NAMES = [
  'Battlefield',
  'Final Destination',
  'Hollow Bastion',
  'Kalos Pokémon League',
  'Lylat Cruise',
  'Northern Cave',
  'Pokémon Stadium 2',
  'Small Battlefield',
  'Smashville',
  'Town and City',
  "Yoshi's Story",
];

function renderStandardStagePicker() {
  const groups = getGroupedStageOptions([], [], TOURNAMENT_LEGAL_STAGE_IDS);
  render(
    <Select open defaultValue={String(TOURNAMENT_LEGAL_STAGE_IDS[0])}>
      <SelectContent>
        <StageSelectGroups groups={groups} />
      </SelectContent>
    </Select>,
  );
}

describe('StageSelectGroups — Standard section', () => {
  it('shows a Standard section label', () => {
    renderStandardStagePicker();

    expect(screen.getByText('Standard')).toBeInTheDocument();
  });

  it('lists exactly the 11 tournament-legal stages, in order, under Standard', () => {
    renderStandardStagePicker();

    const standardLabel = screen.getByText('Standard');
    const standardGroup = standardLabel.closest('[role="group"]');
    expect(standardGroup).not.toBeNull();

    // Exact accessible name match — a substring/regex match on "Battlefield"
    // would also catch "Big Battlefield", "Small Battlefield" and
    // "(Gen. Battlefield)"; same trap for "Final Destination" vs
    // "(Gen. Final Destination)".
    const optionNames = within(standardGroup as HTMLElement)
      .getAllByRole('option')
      .map((option) => option.textContent?.trim());

    expect(optionNames).toEqual(EXPECTED_TOURNAMENT_LEGAL_STAGE_NAMES);
  });

  it('renders a legal stage twice overall — once under Standard, once under All stages', () => {
    renderStandardStagePicker();

    // Pokémon Stadium 2 is the stage that motivated this task and has an
    // unambiguous exact name (no "Big"/"Small"/"(Gen. ...)" sibling).
    const matches = screen.getAllByRole('option', { name: 'Pokémon Stadium 2' });

    expect(matches).toHaveLength(2);
  });
});
