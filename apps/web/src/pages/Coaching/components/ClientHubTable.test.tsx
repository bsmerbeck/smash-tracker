import { describe, expect, it, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router';
import type { ClientHubRow } from '@smash-tracker/shared';
import { ClientHubTable } from './ClientHubTable';

function makeClient(overrides: Partial<ClientHubRow> = {}): ClientHubRow {
  return {
    clientId: 'tetra',
    label: 'Tetra',
    lastActivityAt: null,
    draftCount: 0,
    deliveryState: null,
    archivedAt: null,
    ...overrides,
  };
}

function renderTable(clients: ClientHubRow[]) {
  return render(
    <MemoryRouter initialEntries={['/coach']}>
      <Routes>
        <Route
          path="/coach"
          element={
            <ClientHubTable
              clients={clients}
              onArchiveToggle={vi.fn()}
              onExport={vi.fn()}
              onDeleteRequest={vi.fn()}
            />
          }
        />
        <Route path="/coach/:clientId/overview" element={<div>Client overview page</div>} />
        {/* The per-row actions menu's own "Open workspace" item is unchanged
            by FB-4 — it still deep-links straight to the VOD Manager. */}
        <Route path="/coach/:clientId/vods" element={<div>Client VOD Manager page</div>} />
      </Routes>
    </MemoryRouter>,
  );
}

describe('ClientHubTable', () => {
  // Phase 11 fix round 3 (FB-4): "Hub rows stay clickable too (make
  // row-click affordance obvious)" — clicking anywhere on a row (not just
  // the per-row actions menu) opens that client's workspace.
  it("FB-4: clicking a row navigates to that client's overview", async () => {
    const user = userEvent.setup();
    renderTable([makeClient({ clientId: 'tetra', label: 'Tetra' })]);

    await user.click(screen.getByRole('button', { name: "Open Tetra's workspace" }));

    expect(await screen.findByText('Client overview page')).toBeInTheDocument();
  });

  it('FB-4: the row is keyboard-activatable (Enter)', async () => {
    const user = userEvent.setup();
    renderTable([makeClient({ clientId: 'tetra', label: 'Tetra' })]);

    const row = screen.getByRole('button', { name: "Open Tetra's workspace" });
    row.focus();
    await user.keyboard('{Enter}');

    expect(await screen.findByText('Client overview page')).toBeInTheDocument();
  });

  it('opening the per-row actions menu does not also trigger the row navigation', async () => {
    const user = userEvent.setup();
    renderTable([makeClient({ clientId: 'tetra', label: 'Tetra' })]);

    await user.click(screen.getByRole('button', { name: 'Actions for Tetra' }));
    const menu = await screen.findByRole('menu');
    expect(within(menu).getByRole('menuitem', { name: 'Open workspace' })).toBeInTheDocument();

    // Row navigation did NOT fire just from opening the menu.
    expect(screen.queryByText('Client overview page')).not.toBeInTheDocument();
  });

  it('the actions menu\'s own "Open workspace" item still navigates (unchanged by FB-4)', async () => {
    const user = userEvent.setup();
    renderTable([makeClient({ clientId: 'tetra', label: 'Tetra' })]);

    await user.click(screen.getByRole('button', { name: 'Actions for Tetra' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Open workspace' }));

    expect(await screen.findByText('Client VOD Manager page')).toBeInTheDocument();
  });
});
