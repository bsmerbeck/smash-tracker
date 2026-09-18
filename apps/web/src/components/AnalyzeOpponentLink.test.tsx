import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router';
import { AnalyzeOpponentLink } from './AnalyzeOpponentLink';

/**
 * Plan 38-02 (D-03/OPP-04): three-family harness, in the shape of
 * `matchupsCoachParity.test.tsx` — a `MemoryRouter` declaring a personal
 * route, a coach client route and an owned-workspace tenant route, each
 * rendering the SAME component with the SAME identity. Before this plan the
 * component suppressed itself for a coach/workspace subject entirely
 * (`/opponents` had no workspace-equivalent route); now it renders in all
 * three families, with the destination built through the subject-aware
 * `useSubjectPath` builder fixed in this same plan's Task 1.
 */
function renderAt(initialEntry: string, ui: React.ReactElement) {
  return render(
    <MemoryRouter initialEntries={[initialEntry]}>
      <Routes>
        <Route path="/match-data" element={ui} />
        <Route path="/vod" element={ui} />
        <Route path="/coach/:clientId/match-data" element={ui} />
        <Route path="/workspace/:tenantId/match-data" element={ui} />
      </Routes>
    </MemoryRouter>,
  );
}

describe('AnalyzeOpponentLink', () => {
  it('renders an icon link preferring the provider player id on a personal route', () => {
    renderAt(
      '/match-data',
      <AnalyzeOpponentLink identity={{ opponentUserSlug: 'user/9fb774ae', opponent: 'rival' }} />,
    );
    const link = screen.getByRole('link', { name: 'Analyze opponent rival' });
    expect(link).toHaveAttribute('href', '/opponents?player=sgg%3Auser%2F9fb774ae&opponent=rival');
  });

  it('renders the labeled button variant', () => {
    renderAt('/vod', <AnalyzeOpponentLink variant="button" identity={{ opponent: 'rival' }} />);
    const link = screen.getByRole('link', { name: 'Analyze opponent rival' });
    expect(link).toHaveAttribute('href', '/opponents?opponent=rival');
    expect(link).toHaveTextContent('Analyze opponent');
  });

  it('renders nothing when nothing identifies the opponent, on a personal route', () => {
    const { container } = renderAt('/match-data', <AnalyzeOpponentLink identity={{}} />);
    expect(container.querySelector('a')).toBeNull();
  });

  // Plan 38-02 (D-03/OPP-04): the defect closure this task exists to prove.
  // /opponents is now mounted under both the coach and owned-workspace
  // families from the shared subjectAnalyticsRoutes list (this plan's
  // Task 1), so the affordance renders here instead of suppressing itself.
  it('renders inside a coach client workspace, with the destination carrying the coach prefix and client id', () => {
    renderAt(
      '/coach/client-1/match-data',
      <AnalyzeOpponentLink identity={{ opponent: 'rival' }} />,
    );
    const link = screen.getByRole('link', { name: 'Analyze opponent rival' });
    expect(link).toHaveAttribute('href', '/coach/client-1/opponents?opponent=rival');
  });

  it('renders inside a client-owned workspace, with the destination carrying the workspace prefix and tenant id', () => {
    renderAt(
      '/workspace/tenant-1/match-data',
      <AnalyzeOpponentLink identity={{ opponent: 'rival' }} />,
    );
    const link = screen.getByRole('link', { name: 'Analyze opponent rival' });
    expect(link).toHaveAttribute('href', '/workspace/tenant-1/opponents?opponent=rival');
  });

  it('renders nothing when nothing identifies the opponent, inside a coach client workspace', () => {
    const { container } = renderAt(
      '/coach/client-1/match-data',
      <AnalyzeOpponentLink identity={{}} />,
    );
    expect(container.querySelector('a')).toBeNull();
  });

  it('renders nothing when nothing identifies the opponent, inside a client-owned workspace', () => {
    const { container } = renderAt(
      '/workspace/tenant-1/match-data',
      <AnalyzeOpponentLink identity={{}} />,
    );
    expect(container.querySelector('a')).toBeNull();
  });

  it('the button variant keeps its accessible label inside a coach client workspace', () => {
    renderAt(
      '/coach/client-1/match-data',
      <AnalyzeOpponentLink variant="button" identity={{ opponent: 'rival' }} />,
    );
    const link = screen.getByRole('link', { name: 'Analyze opponent rival' });
    expect(link).toHaveTextContent('Analyze opponent');
  });
});
