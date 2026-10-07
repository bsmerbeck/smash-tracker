import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import en from '@/i18n/locales/en.json';
import { ScoutSearchForm } from './ScoutSearchForm';

/** The card description the form renders under its title. */
function cardDescription(container: HTMLElement): string {
  return container.querySelector('[data-slot="card-description"]')?.textContent ?? '';
}

describe('ScoutSearchForm', () => {
  it('submits with source: startgg by default, and hides the toggle when parrygg is disabled', async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn();
    render(<ScoutSearchForm onSubmit={onSubmit} isPending={false} parryggEnabled={false} />);

    expect(screen.queryByRole('radiogroup', { name: /Scouting source/ })).not.toBeInTheDocument();

    await user.type(screen.getByLabelText(/start\.gg profile URL/), 'user/07dc2239');
    await user.click(screen.getByRole('button', { name: 'Scout' }));

    expect(onSubmit).toHaveBeenCalledWith({ query: 'user/07dc2239', source: 'startgg' });
  });

  it('shows the source toggle when parrygg is enabled, and submits the selected source', async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn();
    render(<ScoutSearchForm onSubmit={onSubmit} isPending={false} parryggEnabled />);

    await user.type(screen.getByLabelText(/start\.gg profile URL/), 'PowPow');
    await user.click(screen.getByRole('radio', { name: 'parry.gg' }));
    await user.click(screen.getByRole('button', { name: 'Scout' }));

    expect(onSubmit).toHaveBeenCalledWith({ query: 'PowPow', source: 'parrygg' });
  });

  it('auto-detects a pasted parry.gg profile URL and overrides the toggle', async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn();
    render(<ScoutSearchForm onSubmit={onSubmit} isPending={false} parryggEnabled />);

    // Toggle starts on start.gg...
    expect(screen.getByRole('radio', { name: 'start.gg' })).toHaveAttribute('aria-checked', 'true');

    await user.type(
      screen.getByLabelText(/start\.gg profile URL/),
      'https://parry.gg/profile/019ce9ba-debd-7e11-84a2-77258f52644e',
    );

    // ...but flips to parry.gg once the URL is unambiguous, and disables manual toggling.
    expect(screen.getByRole('radio', { name: 'parry.gg' })).toHaveAttribute('aria-checked', 'true');
    expect(screen.getByRole('radio', { name: 'start.gg' })).toBeDisabled();
    expect(screen.getByRole('radio', { name: 'parry.gg' })).toBeDisabled();

    await user.click(screen.getByRole('button', { name: 'Scout' }));
    expect(onSubmit).toHaveBeenCalledWith({
      query: 'https://parry.gg/profile/019ce9ba-debd-7e11-84a2-77258f52644e',
      source: 'parrygg',
    });
  });

  it('does not submit an empty query', async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn();
    render(<ScoutSearchForm onSubmit={onSubmit} isPending={false} />);

    expect(screen.getByRole('button', { name: 'Scout' })).toBeDisabled();
    await user.click(screen.getByRole('button', { name: 'Scout' }));
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('V13: "Both" mode submits a combined request when both fields are filled', async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn();
    render(<ScoutSearchForm onSubmit={onSubmit} isPending={false} parryggEnabled />);

    await user.click(screen.getByRole('radio', { name: 'Both' }));
    await user.type(screen.getByLabelText(/start\.gg profile URL/), 'user/07dc2239');
    await user.type(screen.getByLabelText(/parry\.gg profile URL/), 'Pandem1c');
    await user.click(screen.getByRole('button', { name: 'Scout' }));

    expect(onSubmit).toHaveBeenCalledWith({
      query: 'user/07dc2239',
      source: 'startgg',
      combineWith: { query: 'Pandem1c', source: 'parrygg' },
    });
  });

  it('V13: "Both" mode with only one field filled submits a single-source request', async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn();
    render(<ScoutSearchForm onSubmit={onSubmit} isPending={false} parryggEnabled />);

    await user.click(screen.getByRole('radio', { name: 'Both' }));
    await user.type(screen.getByLabelText(/parry\.gg profile URL/), 'Pandem1c');
    await user.click(screen.getByRole('button', { name: 'Scout' }));

    expect(onSubmit).toHaveBeenCalledWith({ query: 'Pandem1c', source: 'parrygg' });
    expect(onSubmit).not.toHaveBeenCalledWith(
      expect.objectContaining({ combineWith: expect.anything() }),
    );
  });

  // Plan 41-16 (UAT 41-8 / F14): the help text matches what the SELECTED source accepts — start.gg
  // never takes a bare gamer tag, so nothing on the start.gg source says one works.
  describe('source-aware help text (UAT 41-8 F14)', () => {
    it('start.gg source (parry.gg enabled): no description, placeholder or aria label says a gamer tag works', () => {
      const { container } = render(
        <ScoutSearchForm onSubmit={vi.fn()} isPending={false} parryggEnabled />,
      );
      const description = cardDescription(container);
      expect(description).not.toMatch(/gamer tag|tag/i);
      expect(description).toMatch(/profile URL/);
      expect(description).toContain('user/<slug>');
      expect(description).toMatch(/numeric player id/);
      const input = screen.getByRole('textbox');
      expect(input.getAttribute('aria-label') ?? '').not.toMatch(/tag/i);
      expect(input.getAttribute('placeholder') ?? '').not.toMatch(/tag/i);
    });

    it('parry.gg source: the description names a parry.gg profile URL or gamer tag', async () => {
      const user = userEvent.setup();
      const { container } = render(
        <ScoutSearchForm onSubmit={vi.fn()} isPending={false} parryggEnabled />,
      );
      await user.click(screen.getByRole('radio', { name: 'parry.gg' }));
      expect(cardDescription(container)).toBe(en.scout.form.descriptionParry);
      expect(cardDescription(container)).toMatch(/parry\.gg profile URL or a gamer tag/);
    });

    it('a pasted parry.gg profile URL shows the parry.gg description too', async () => {
      const user = userEvent.setup();
      const { container } = render(
        <ScoutSearchForm onSubmit={vi.fn()} isPending={false} parryggEnabled />,
      );
      await user.type(screen.getByRole('textbox'), 'https://parry.gg/profile/019ce9ba');
      expect(cardDescription(container)).toBe(en.scout.form.descriptionParry);
    });

    it('Both mode points at the two fields', async () => {
      const user = userEvent.setup();
      const { container } = render(
        <ScoutSearchForm onSubmit={vi.fn()} isPending={false} parryggEnabled />,
      );
      await user.click(screen.getByRole('radio', { name: 'Both' }));
      expect(cardDescription(container)).toBe(en.scout.form.descriptionBoth);
    });

    it('parry.gg disabled: the start.gg description is unchanged', () => {
      const { container } = render(<ScoutSearchForm onSubmit={vi.fn()} isPending={false} />);
      expect(cardDescription(container)).toBe(en.scout.form.description);
    });
  });
});
