import { describe, expect, it } from 'vitest';
import { render } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router';
import { getActiveSubjectHeader, setActiveSubject } from '@/lib/subjectQueryKey';
import { ClientOwnedWorkspaceLayout } from './ClientOwnedWorkspaceLayout';

function renderAt(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/workspace/:tenantId" element={<ClientOwnedWorkspaceLayout />}>
          <Route index element={<div>owned workspace content</div>} />
        </Route>
        <Route path="/dashboard" element={<div>dashboard</div>} />
      </Routes>
    </MemoryRouter>,
  );
}

describe('ClientOwnedWorkspaceLayout', () => {
  it('sets the active-subject header to client:{tenantId} on mount', () => {
    setActiveSubject({ mode: 'personal', clientId: null });
    renderAt('/workspace/t1');
    expect(getActiveSubjectHeader()).toBe('client:t1');
  });

  it('resets the active-subject header to personal on unmount', () => {
    setActiveSubject({ mode: 'personal', clientId: null });
    const { unmount } = renderAt('/workspace/t1');
    expect(getActiveSubjectHeader()).toBe('client:t1');

    unmount();

    expect(getActiveSubjectHeader()).toBe('personal');
  });
});
