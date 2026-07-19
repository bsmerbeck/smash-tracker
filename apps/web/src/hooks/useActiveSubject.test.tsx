import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router';
import { useActiveSubject } from './useActiveSubject';

function Probe() {
  const subject = useActiveSubject();
  return (
    <div>
      mode: {subject.mode}, clientId: {subject.clientId ?? 'null'}
    </div>
  );
}

function renderAt(path: string) {
  render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/coach/:clientId/*" element={<Probe />} />
        <Route path="*" element={<Probe />} />
      </Routes>
    </MemoryRouter>,
  );
}

describe('useActiveSubject', () => {
  it('resolves personal mode on a non-coaching route', () => {
    renderAt('/dashboard');
    expect(screen.getByText('mode: personal, clientId: null')).toBeInTheDocument();
  });

  it('resolves coaching mode with the route clientId on a /coach/:clientId route', () => {
    renderAt('/coach/tenant-123/vods');
    expect(screen.getByText('mode: coaching, clientId: tenant-123')).toBeInTheDocument();
  });

  it('resolves personal mode on the /coach hub route with no clientId param', () => {
    renderAt('/coach');
    expect(screen.getByText('mode: personal, clientId: null')).toBeInTheDocument();
  });
});
