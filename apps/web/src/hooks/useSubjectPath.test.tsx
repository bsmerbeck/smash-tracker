import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router';
import { useSubjectPath } from './useSubjectPath';

function Probe({ path }: { path: string }) {
  const subjectPath = useSubjectPath();
  return <div>resolved: {subjectPath(path)}</div>;
}

function renderAt(initialPath: string, probePath: string) {
  render(
    <MemoryRouter initialEntries={[initialPath]}>
      <Routes>
        <Route path="/coach/:clientId/*" element={<Probe path={probePath} />} />
        <Route path="*" element={<Probe path={probePath} />} />
      </Routes>
    </MemoryRouter>,
  );
}

describe('useSubjectPath', () => {
  it('returns the path unchanged in personal mode', () => {
    renderAt('/dashboard', '/matchups');
    expect(screen.getByText('resolved: /matchups')).toBeInTheDocument();
  });

  it('returns the path unchanged at the /coach hub (no clientId)', () => {
    renderAt('/coach', '/matchups');
    expect(screen.getByText('resolved: /matchups')).toBeInTheDocument();
  });

  it('FB-6: rewrites /matchups to the client workspace equivalent ("Open Matchup Lab" bug)', () => {
    renderAt('/coach/tetra/dashboard', '/matchups');
    expect(screen.getByText('resolved: /coach/tetra/matchups')).toBeInTheDocument();
  });

  it('rewrites /dashboard to the client workspace equivalent', () => {
    renderAt('/coach/tetra/matchups', '/dashboard');
    expect(screen.getByText('resolved: /coach/tetra/dashboard')).toBeInTheDocument();
  });

  it('rewrites /fighter-analysis to the client workspace equivalent', () => {
    renderAt('/coach/tetra/dashboard', '/fighter-analysis');
    expect(screen.getByText('resolved: /coach/tetra/fighter-analysis')).toBeInTheDocument();
  });

  it('rewrites /choose-primary and /choose-secondary to the single client Fighters page', () => {
    renderAt('/coach/tetra/dashboard', '/choose-primary');
    expect(screen.getByText('resolved: /coach/tetra/fighters')).toBeInTheDocument();
  });

  it('preserves a query string when rewriting (VOD Manager deep link)', () => {
    renderAt('/coach/tetra/match-data', '/vod?match=m1');
    expect(screen.getByText('resolved: /coach/tetra/vods?match=m1')).toBeInTheDocument();
  });
});
