import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ScoutSearchForm } from './ScoutSearchForm';

describe('ScoutSearchForm', () => {
  it('submits with source: startgg by default, and hides the toggle when parrygg is disabled', async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn();
    render(<ScoutSearchForm onSubmit={onSubmit} isPending={false} parryggEnabled={false} />);

    expect(screen.queryByRole('radiogroup', { name: /Scouting source/ })).not.toBeInTheDocument();

    await user.type(screen.getByLabelText(/start\.gg profile URL/), 'user/07dc2239');
    await user.click(screen.getByRole('button', { name: 'Scout' }));

    expect(onSubmit).toHaveBeenCalledWith('user/07dc2239', 'startgg');
  });

  it('shows the source toggle when parrygg is enabled, and submits the selected source', async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn();
    render(<ScoutSearchForm onSubmit={onSubmit} isPending={false} parryggEnabled />);

    await user.type(screen.getByLabelText(/start\.gg or parry\.gg profile URL/), 'PowPow');
    await user.click(screen.getByRole('radio', { name: 'parry.gg' }));
    await user.click(screen.getByRole('button', { name: 'Scout' }));

    expect(onSubmit).toHaveBeenCalledWith('PowPow', 'parrygg');
  });

  it('auto-detects a pasted parry.gg profile URL and overrides the toggle', async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn();
    render(<ScoutSearchForm onSubmit={onSubmit} isPending={false} parryggEnabled />);

    // Toggle starts on start.gg...
    expect(screen.getByRole('radio', { name: 'start.gg' })).toHaveAttribute('aria-checked', 'true');

    await user.type(
      screen.getByLabelText(/start\.gg or parry\.gg profile URL/),
      'https://parry.gg/profile/019ce9ba-debd-7e11-84a2-77258f52644e',
    );

    // ...but flips to parry.gg once the URL is unambiguous, and disables manual toggling.
    expect(screen.getByRole('radio', { name: 'parry.gg' })).toHaveAttribute('aria-checked', 'true');
    expect(screen.getByRole('radio', { name: 'start.gg' })).toBeDisabled();
    expect(screen.getByRole('radio', { name: 'parry.gg' })).toBeDisabled();

    await user.click(screen.getByRole('button', { name: 'Scout' }));
    expect(onSubmit).toHaveBeenCalledWith(
      'https://parry.gg/profile/019ce9ba-debd-7e11-84a2-77258f52644e',
      'parrygg',
    );
  });

  it('does not submit an empty query', async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn();
    render(<ScoutSearchForm onSubmit={onSubmit} isPending={false} />);

    expect(screen.getByRole('button', { name: 'Scout' })).toBeDisabled();
    await user.click(screen.getByRole('button', { name: 'Scout' }));
    expect(onSubmit).not.toHaveBeenCalled();
  });
});
