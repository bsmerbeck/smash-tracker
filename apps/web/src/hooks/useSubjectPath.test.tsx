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
        <Route path="/workspace/:tenantId/*" element={<Probe path={probePath} />} />
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

  // Plan 38-02 (D-03): the defect this task closes — the builder used to
  // derive its subject from the coach-only hook alone, so it silently
  // returned the PERSONAL path on every /workspace/:tenantId route.
  describe('owned-workspace family (D-03 defect fix)', () => {
    it('rewrites /dashboard to the workspace equivalent', () => {
      renderAt('/workspace/w1/matchups', '/dashboard');
      expect(screen.getByText('resolved: /workspace/w1/dashboard')).toBeInTheDocument();
    });

    it('rewrites /matchups to the workspace equivalent', () => {
      renderAt('/workspace/w1/dashboard', '/matchups');
      expect(screen.getByText('resolved: /workspace/w1/matchups')).toBeInTheDocument();
    });

    it('rewrites /fighter-analysis to the workspace equivalent', () => {
      renderAt('/workspace/w1/dashboard', '/fighter-analysis');
      expect(screen.getByText('resolved: /workspace/w1/fighter-analysis')).toBeInTheDocument();
    });

    it('rewrites /opponents to the workspace equivalent', () => {
      renderAt('/workspace/w1/dashboard', '/opponents');
      expect(screen.getByText('resolved: /workspace/w1/opponents')).toBeInTheDocument();
    });

    it('preserves a query string when rewriting on a workspace route', () => {
      renderAt('/workspace/w1/match-data', '/vod?match=m1');
      expect(screen.getByText('resolved: /workspace/w1/vods?match=m1')).toBeInTheDocument();
    });

    it('never emits a coach prefix on a workspace route', () => {
      renderAt('/workspace/w1/dashboard', '/matchups');
      const resolved = screen.getByText('resolved: /workspace/w1/matchups');
      expect(resolved).toBeInTheDocument();
      expect(resolved.textContent ?? '').not.toContain('/coach/');
    });
  });

  // Two distinct senses of "pass-through" — conflating them silently drops
  // the subject prefix from a param-bearing path like /stages/<id>.
  describe('pass-through senses', () => {
    it('an UNMAPPED pathname under a coach entry still comes back prefixed (prefix + unchanged path)', () => {
      renderAt('/coach/tetra/dashboard', '/stages/118');
      expect(screen.getByText('resolved: /coach/tetra/stages/118')).toBeInTheDocument();
    });

    it('an UNMAPPED pathname under a workspace entry still comes back prefixed', () => {
      renderAt('/workspace/w1/dashboard', '/stages/118');
      expect(screen.getByText('resolved: /workspace/w1/stages/118')).toBeInTheDocument();
    });

    it('the personal and coach-hub NO-SUBJECT cases still return the input completely unchanged', () => {
      renderAt('/dashboard', '/stages/118');
      expect(screen.getByText('resolved: /stages/118')).toBeInTheDocument();
    });
  });

  describe('first-segment rewrite with a trailing id', () => {
    it('rewrites the first segment of /opponents/<tag> under a coach entry, preserving the tag', () => {
      renderAt('/coach/tetra/dashboard', '/opponents/rival');
      expect(screen.getByText('resolved: /coach/tetra/opponents/rival')).toBeInTheDocument();
    });

    it('rewrites the first segment of /opponents/<tag> under a workspace entry, preserving the tag', () => {
      renderAt('/workspace/w1/dashboard', '/opponents/rival');
      expect(screen.getByText('resolved: /workspace/w1/opponents/rival')).toBeInTheDocument();
    });
  });
});
