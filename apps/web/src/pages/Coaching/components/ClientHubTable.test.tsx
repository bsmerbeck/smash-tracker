import { describe, expect, it, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router';
import type { ClientHubRow } from '@smash-tracker/shared';
import { ClientHubTable, type ClientHubTableProps } from './ClientHubTable';

function makeClient(overrides: Partial<ClientHubRow> = {}): ClientHubRow {
  return {
    clientId: 'tetra',
    label: 'Tetra',
    lastActivityAt: null,
    draftCount: 0,
    deliveryState: null,
    archivedAt: null,
    claimedAt: null,
    pendingInvitationExpiresAt: null,
    // Phase 29 (Research Tenancy, Isolation & Governance Gate): tri-state
    // resolution field, required on ClientHubRow — ordinary default,
    // overridable per test.
    kind: 'ordinary',
    ...overrides,
  };
}

function renderTable(clients: ClientHubRow[], overrides: Partial<ClientHubTableProps> = {}) {
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
              onIssueClaimCode={vi.fn()}
              {...overrides}
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

  // Phase 24 (Coach Issuance & Client Claim Experience, CTRL-03/ENTRY-02): a
  // claimStatus column header renders, and its row action invokes
  // onIssueClaimCode with the row so the parent can open the issuance dialog.
  it('renders a claimStatus column and invokes onIssueClaimCode from the row action', async () => {
    const user = userEvent.setup();
    const onIssueClaimCode = vi.fn();
    renderTable([makeClient({ clientId: 'tetra', label: 'Tetra' })], { onIssueClaimCode });

    expect(screen.getByText('Claim status')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Actions for Tetra' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Generate claim code' }));

    expect(onIssueClaimCode).toHaveBeenCalledWith(
      expect.objectContaining({ clientId: 'tetra', label: 'Tetra' }),
    );
  });
});

/**
 * Phase 29 (Research Tenancy, Isolation & Governance Gate, review finding
 * 29-07 HIGH): the research badge renders per row's tri-state kind, and
 * claim-issuance/export row actions are hidden for research and unresolved
 * rows (a UI affordance only — plan 29-04's server-side refusal is the real
 * boundary).
 */
describe('ClientHubTable research badge and fail-closed row actions (Phase 29, RTEN-01/RTEN-02)', () => {
  it('renders the research badge for a research row', () => {
    renderTable([makeClient({ clientId: 'tetra', label: 'Tetra', kind: 'research' })]);

    expect(screen.getByText('Research')).toBeInTheDocument();
  });

  it('renders the unresolved badge for an unresolved row', () => {
    renderTable([makeClient({ clientId: 'tetra', label: 'Tetra', kind: 'unresolved' })]);

    expect(screen.getByText('Unresolved')).toBeInTheDocument();
  });

  it('renders neither badge for a coaching (ordinary) row', () => {
    renderTable([makeClient({ clientId: 'tetra', label: 'Tetra', kind: 'ordinary' })]);

    expect(screen.queryByText('Research')).not.toBeInTheDocument();
    expect(screen.queryByText('Unresolved')).not.toBeInTheDocument();
  });

  it('hides claim-issuance and export actions for a research row', async () => {
    const user = userEvent.setup();
    renderTable([makeClient({ clientId: 'tetra', label: 'Tetra', kind: 'research' })]);

    await user.click(screen.getByRole('button', { name: 'Actions for Tetra' }));
    const menu = await screen.findByRole('menu');
    expect(
      within(menu).queryByRole('menuitem', { name: 'Generate claim code' }),
    ).not.toBeInTheDocument();
    expect(
      within(menu).queryByRole('menuitem', { name: 'Export workspace' }),
    ).not.toBeInTheDocument();
    // The workspace/archive/delete actions are unaffected.
    expect(within(menu).getByRole('menuitem', { name: 'Open workspace' })).toBeInTheDocument();
  });

  it('hides claim-issuance and export actions for an unresolved row', async () => {
    const user = userEvent.setup();
    renderTable([makeClient({ clientId: 'tetra', label: 'Tetra', kind: 'unresolved' })]);

    await user.click(screen.getByRole('button', { name: 'Actions for Tetra' }));
    const menu = await screen.findByRole('menu');
    expect(
      within(menu).queryByRole('menuitem', { name: 'Generate claim code' }),
    ).not.toBeInTheDocument();
    expect(
      within(menu).queryByRole('menuitem', { name: 'Export workspace' }),
    ).not.toBeInTheDocument();
  });

  it('keeps claim-issuance and export actions present for a coaching (ordinary) row', async () => {
    const user = userEvent.setup();
    renderTable([makeClient({ clientId: 'tetra', label: 'Tetra', kind: 'ordinary' })]);

    await user.click(screen.getByRole('button', { name: 'Actions for Tetra' }));
    const menu = await screen.findByRole('menu');
    expect(within(menu).getByRole('menuitem', { name: 'Generate claim code' })).toBeInTheDocument();
    expect(within(menu).getByRole('menuitem', { name: 'Export workspace' })).toBeInTheDocument();
  });
});
