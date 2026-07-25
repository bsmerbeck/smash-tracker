import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router';
import { subjectScope } from '@/lib/subjectQueryKey';
import { useEffectiveSubject } from './useEffectiveSubject';

function Probe() {
  const subject = useEffectiveSubject();
  return (
    <div>
      <div>
        mode: {subject.mode}, clientId: {subject.clientId ?? 'null'}
      </div>
      {/* Rendered synchronously in the SAME pass as `subject` above — proves
          the cache-key shape is correct on first render, not after an effect
          fires (24-05-CACHEFIX). */}
      <div>cacheKey: {JSON.stringify(subjectScope(subject))}</div>
    </div>
  );
}

function renderAt(path: string) {
  render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/coach/:clientId/*" element={<Probe />} />
        <Route path="/workspace/:tenantId/*" element={<Probe />} />
        <Route path="*" element={<Probe />} />
      </Routes>
    </MemoryRouter>,
  );
}

describe('useEffectiveSubject', () => {
  it('yields the ["client", tenantId] cache key namespace on FIRST render under /workspace/:tenantId', () => {
    renderAt('/workspace/tenant-abc/dashboard');
    expect(screen.getByText('mode: personal, clientId: tenant-abc')).toBeInTheDocument();
    expect(screen.getByText('cacheKey: ["client","tenant-abc"]')).toBeInTheDocument();
  });

  it('yields the ["personal"] cache key namespace outside any subject-owning route', () => {
    renderAt('/dashboard');
    expect(screen.getByText('mode: personal, clientId: null')).toBeInTheDocument();
    expect(screen.getByText('cacheKey: ["personal"]')).toBeInTheDocument();
  });

  it('still yields the ["client", clientId] cache key namespace on /coach/:clientId routes (regression, TEN-04)', () => {
    renderAt('/coach/tenant-xyz/vods');
    expect(screen.getByText('mode: coaching, clientId: tenant-xyz')).toBeInTheDocument();
    expect(screen.getByText('cacheKey: ["client","tenant-xyz"]')).toBeInTheDocument();
  });

  it('still yields the ["client", null-safe] hub cache key on the /coach hub route (regression, walkthrough fix FB-1)', () => {
    renderAt('/coach');
    expect(screen.getByText('mode: coaching, clientId: null')).toBeInTheDocument();
    expect(screen.getByText('cacheKey: ["personal"]')).toBeInTheDocument();
  });
});
