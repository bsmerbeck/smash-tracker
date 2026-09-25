import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { GlickoExplainer } from './GlickoExplainer';

describe('GlickoExplainer', () => {
  it('renders an accessible info trigger that is closed by default', () => {
    render(<GlickoExplainer />);

    expect(screen.getByRole('button', { name: 'What is Glicko-2?' })).toBeInTheDocument();
    expect(screen.queryByText(/fixed, constant reference opponent/i)).not.toBeInTheDocument();
  });

  it('opens the popover with the revised fixed-reference explainer copy when the trigger is clicked', async () => {
    const user = userEvent.setup();
    render(<GlickoExplainer />);

    await user.click(screen.getByRole('button', { name: 'What is Glicko-2?' }));

    const dialog = await screen.findByRole('dialog');
    expect(dialog.textContent).toMatch(/Glicko-2 is the rating system/i);
    // Phase 36 (TRND-01, D-04): the rating no longer weighs WHO you beat —
    // it rates every session against a fixed, constant reference opponent.
    expect(dialog.textContent).toMatch(/fixed, constant reference opponent/i);
    expect(dialog.textContent).not.toMatch(/who you beat and how surprising/i);
    expect(dialog.textContent).toMatch(/±number \(RD\)/i);
    expect(dialog.textContent).toMatch(/bracket play is bursty/i);
    expect(dialog.textContent).toMatch(/rating-model version 2/i);
  });
});
