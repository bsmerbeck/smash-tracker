import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router';
import { useOwnedWorkspaceSubject } from './useOwnedWorkspaceSubject';

function Probe() {
  const subject = useOwnedWorkspaceSubject();
  return <div>tenantId: {subject.tenantId ?? 'null'}</div>;
}

function renderAt(path: string) {
  render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/workspace/:tenantId/*" element={<Probe />} />
        <Route path="*" element={<Probe />} />
      </Routes>
    </MemoryRouter>,
  );
}

describe('useOwnedWorkspaceSubject', () => {
  it('resolves the route tenantId on a /workspace/:tenantId route', () => {
    renderAt('/workspace/t1/vods');
    expect(screen.getByText('tenantId: t1')).toBeInTheDocument();
  });

  it('resolves null on a personal route', () => {
    renderAt('/dashboard');
    expect(screen.getByText('tenantId: null')).toBeInTheDocument();
  });

  it('resolves null on a /coach route', () => {
    renderAt('/coach');
    expect(screen.getByText('tenantId: null')).toBeInTheDocument();
  });

  it('resolves null on a /coach/:clientId route (never picks up a coach client param)', () => {
    renderAt('/coach/c1/vods');
    expect(screen.getByText('tenantId: null')).toBeInTheDocument();
  });

  it('resolves null on the bare /workspace route with no tenantId', () => {
    renderAt('/workspace');
    expect(screen.getByText('tenantId: null')).toBeInTheDocument();
  });
});
