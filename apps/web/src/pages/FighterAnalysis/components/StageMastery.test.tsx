import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import type { Match } from '@smash-tracker/shared';
import { StageMastery } from './StageMastery';
import { useSubjectPath } from '@/hooks/useSubjectPath';

/**
 * Plan 38-06 Task 2 (ADV-03/H-01/H-05): the pre-plan tree has NO test file
 * anywhere under `apps/web/src/pages/FighterAnalysis/components/` — this
 * file is that home. Asserts the caption now reads gated engine output with
 * a sample cue and an abstention sentence (ADV-03), and that the
 * `stageHref` opt-in is genuinely optional: supplied, it produces a real
 * (and subject-aware) link; omitted, the component renders with NO Router
 * in scope at all — the exact shape `Scout/components/FullAnalysisSection`'s
 * six bare renders require (H-01).
 */

function makeMatch(
  overrides: Partial<Match> & Pick<Match, 'id' | 'time' | 'win'> & { map: Match['map'] },
): Match {
  return {
    fighter_id: 1,
    opponent_id: 2,
    opponent: '',
    notes: '',
    matchType: 'none',
    ...overrides,
  };
}

const BATTLEFIELD = { id: 1, name: 'Battlefield' };
const FD = { id: 2, name: 'Final Destination' };

/** 4 wins on FD, 3 losses on Battlefield — both stages clear the abstention floor. */
function twoStageFixture(): Match[] {
  return [
    ...Array.from({ length: 4 }, (_, i) =>
      makeMatch({ id: `fd${i}`, time: i, win: true, map: FD }),
    ),
    makeMatch({ id: 'bf1', time: 10, win: false, map: BATTLEFIELD }),
    makeMatch({ id: 'bf2', time: 11, win: false, map: BATTLEFIELD }),
    makeMatch({ id: 'bf3', time: 12, win: false, map: BATTLEFIELD }),
  ];
}

/** Composes `stageHref` through `useSubjectPath()`, exactly as `FighterAnalysisPage.tsx` does. */
function Harness({ matches }: { matches: Match[] }) {
  const subjectPath = useSubjectPath();
  return (
    <StageMastery
      fighterMatches={matches}
      stageHref={(stageId) => subjectPath(`/stages/${stageId}`)}
    />
  );
}

describe('StageMastery', () => {
  it('renders a sample cue beside each of the best-pick and ban-worthy claims', () => {
    render(
      <MemoryRouter>
        <StageMastery fighterMatches={twoStageFixture()} />
      </MemoryRouter>,
    );

    expect(screen.getAllByText(/games · low confidence/)).toHaveLength(2);
  });

  it('renders the shared games-needed sentence — not a claim — for a fixture below the abstention floor', () => {
    const matches: Match[] = [makeMatch({ id: 'fd1', time: 1, win: true, map: FD })];
    render(
      <MemoryRouter>
        <StageMastery fighterMatches={matches} />
      </MemoryRouter>,
    );

    expect(screen.getByText(/Not enough data yet/)).toBeInTheDocument();
    expect(screen.queryByText(/Best pick/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/Ban-worthy/i)).not.toBeInTheDocument();
  });

  it('when the host supplies stageHref, a stage tile is an anchor to the stage detail path — coach-prefixed under a coach entry', () => {
    const matches = twoStageFixture();
    const { unmount } = render(
      <MemoryRouter initialEntries={['/fighter-analysis']}>
        <Harness matches={matches} />
      </MemoryRouter>,
    );
    const personalLinks = screen.getAllByRole('link');
    expect(personalLinks.length).toBeGreaterThan(0);
    expect(personalLinks.some((link) => link.getAttribute('href') === `/stages/${FD.id}`)).toBe(
      true,
    );
    unmount();

    render(
      <MemoryRouter initialEntries={['/coach/test-client/fighter-analysis']}>
        <Harness matches={matches} />
      </MemoryRouter>,
    );
    const coachLinks = screen.getAllByRole('link');
    expect(
      coachLinks.some((link) => link.getAttribute('href') === `/coach/test-client/stages/${FD.id}`),
    ).toBe(true);
  });

  it('with no stageHref supplied, a stage tile renders no anchor and no button — and needs no Router at all', () => {
    // Deliberately NO <MemoryRouter> here — this is the exact shape
    // `FullAnalysisSection.test.tsx`'s six bare renders require (H-01).
    render(<StageMastery fighterMatches={twoStageFixture()} />);

    expect(screen.queryAllByRole('link')).toHaveLength(0);
    expect(screen.queryAllByRole('button')).toHaveLength(0);
  });
});
