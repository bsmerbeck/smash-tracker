import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import {
  DrillableRow,
  DrillableRowChevron,
  DrillableRowStatic,
  type DrillableRowProps,
} from './DrillableRow';

/**
 * Type-level check (never called): `DrillableRowProps` is a discriminated
 * union over `{ to }` XOR `{ onActivate }` — passing both is a compile
 * error, verified by `pnpm typecheck`. This function's own body would fail
 * `tsc` if the union collapsed to an intersection.
 */
function _typeCheckMutuallyExclusive() {
  // @ts-expect-error — `to` and `onActivate` together must not typecheck.
  const _props: DrillableRowProps = { to: '/x', onActivate: () => {}, ariaLabel: 'x' };
  void _props;
}
void _typeCheckMutuallyExclusive;

function renderWithRouter(ui: React.ReactElement) {
  return render(<MemoryRouter>{ui}</MemoryRouter>);
}

describe('DrillableRow', () => {
  it('renders a real anchor when given a destination', () => {
    renderWithRouter(
      <DrillableRow to="/opponents/mkleo" ariaLabel="MkLeo — opens details">
        MkLeo
      </DrillableRow>,
    );
    const link = screen.getByRole('link', { name: 'MkLeo — opens details' });
    expect(link).toHaveAttribute('href', '/opponents/mkleo');
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });

  it('renders a real button when given a handler', () => {
    const onActivate = vi.fn();
    renderWithRouter(
      <DrillableRow onActivate={onActivate} ariaLabel="Session — opens details">
        Session
      </DrillableRow>,
    );
    const button = screen.getByRole('button', { name: 'Session — opens details' });
    expect(button).toHaveAttribute('type', 'button');
    expect(screen.queryByRole('link')).not.toBeInTheDocument();
  });

  it('never renders both an anchor and a button for one row', () => {
    renderWithRouter(
      <DrillableRow to="/opponents/mkleo" ariaLabel="MkLeo — opens details">
        MkLeo
      </DrillableRow>,
    );
    expect(screen.getAllByRole('link')).toHaveLength(1);
    expect(screen.queryAllByRole('button')).toHaveLength(0);
  });

  it('activates on both Enter and Space when given a handler', async () => {
    const user = userEvent.setup();
    const onActivate = vi.fn();
    renderWithRouter(
      <DrillableRow onActivate={onActivate} ariaLabel="Session — opens details">
        Session
      </DrillableRow>,
    );
    const button = screen.getByRole('button', { name: 'Session — opens details' });
    button.focus();
    await user.keyboard('{Enter}');
    expect(onActivate).toHaveBeenCalledTimes(1);
    await user.keyboard(' ');
    expect(onActivate).toHaveBeenCalledTimes(2);
  });

  it('renders the trailing chevron in the DOM with no hover interaction required', () => {
    renderWithRouter(
      <DrillableRow to="/opponents/mkleo" ariaLabel="MkLeo — opens details">
        MkLeo
      </DrillableRow>,
    );
    const link = screen.getByRole('link', { name: 'MkLeo — opens details' });
    // The chevron is an `aria-hidden` decorative icon rendered unconditionally
    // — no hover class gates its presence in the DOM.
    expect(link.querySelector('svg[aria-hidden="true"]')).toBeInTheDocument();
  });

  it('sets aria-expanded on a row that toggles an inline panel', () => {
    renderWithRouter(
      <DrillableRow onActivate={vi.fn()} ariaLabel="Session — opens details" expanded>
        Session
      </DrillableRow>,
    );
    expect(screen.getByRole('button', { name: 'Session — opens details' })).toHaveAttribute(
      'aria-expanded',
      'true',
    );
  });

  it('as="overlay" renders only the invisible interactive element, no visible children', () => {
    renderWithRouter(
      <DrillableRow to="/stages/1" ariaLabel="Battlefield — opens details" as="overlay">
        Battlefield
      </DrillableRow>,
    );
    const link = screen.getByRole('link', { name: 'Battlefield — opens details' });
    expect(link).toHaveClass('absolute', 'inset-0');
    expect(link).not.toHaveTextContent('Battlefield');
  });

  it('DrillableRowChevron renders a decorative, always-visible icon', () => {
    render(<DrillableRowChevron />);
    expect(document.querySelector('svg[aria-hidden="true"]')).toBeInTheDocument();
  });

  it('DrillableRowStatic renders plain text with no link/button semantics', () => {
    render(<DrillableRowStatic>Unknown</DrillableRowStatic>);
    expect(screen.getByText('Unknown')).toBeInTheDocument();
    expect(screen.queryByRole('link')).not.toBeInTheDocument();
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });
});
