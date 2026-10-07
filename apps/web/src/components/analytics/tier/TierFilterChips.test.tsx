import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, useLocation } from 'react-router';
import { TooltipProvider } from '@/components/ui/tooltip';
import type { TierWord } from '@smash-tracker/shared';
import { TierFilterChips } from './TierFilterChips';

const navigateSpy = vi.fn();

// Wraps the real navigate so the URL still changes while the call arguments stay observable.
vi.mock('react-router', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react-router')>();
  return {
    ...actual,
    useNavigate: () => {
      const real = actual.useNavigate();
      return (...args: Parameters<typeof real>) => {
        navigateSpy(...args);
        return real(...args);
      };
    },
  };
});

const COUNTS: Record<TierWord, number> = {
  supermajor: 1,
  major: 2,
  minor: 0,
  regional: 0,
  local: 0,
  unknown: 13,
};
const SETTING_COUNTS = { offline: 4, online: 12 };

function LocationProbe() {
  const location = useLocation();
  return <output data-testid="search">{location.search}</output>;
}

function renderChips(
  initialEntry = '/tournaments',
  props: Partial<Parameters<typeof TierFilterChips>[0]> = {},
) {
  return render(
    <MemoryRouter initialEntries={[initialEntry]}>
      <TooltipProvider>
        <TierFilterChips
          tierCounts={COUNTS}
          settingCounts={SETTING_COUNTS}
          layout="table"
          {...props}
        />
        <LocationProbe />
      </TooltipProvider>
    </MemoryRouter>,
  );
}

const search = () => screen.getByTestId('search').textContent;

describe('TierFilterChips (D-13, DD-04)', () => {
  beforeEach(() => {
    navigateSpy.mockClear();
    window.localStorage.clear();
    window.sessionStorage.clear();
  });

  describe('E2 populated: the chips reflect the URL on every render', () => {
    it('renders the six tier chips in vocabulary order with faceted counts, Unknown last', () => {
      renderChips();
      const group = screen.getByRole('toolbar', { name: 'Tier' });
      expect(
        within(group)
          .getAllByRole('button')
          .map((b) => b.textContent),
      ).toEqual([
        'Supermajor (1)',
        'Major (2)',
        'Minor (0)',
        'Regional (0)',
        'Local (0)',
        'Tier unknown (13)',
      ]);
    });

    it('renders the setting chips and the side-event toggle', () => {
      renderChips();
      const group = screen.getByRole('toolbar', { name: 'Setting' });
      expect(
        within(group)
          .getAllByRole('button')
          .map((b) => b.textContent),
      ).toEqual(['Offline (4)', 'Online (12)']);
      expect(screen.getByRole('button', { name: 'Hide side events' })).toHaveAttribute(
        'aria-pressed',
        'false',
      );
    });

    it('presses exactly the chips the URL names', () => {
      renderChips('/tournaments?tier=major,unknown&setting=online&side=hide');
      const pressed = screen
        .getAllByRole('button')
        .filter((b) => b.getAttribute('aria-pressed') === 'true')
        .map((b) => b.textContent);
      expect(pressed).toEqual([
        'Major (2)',
        'Tier unknown (13)',
        'Online (12)',
        'Hide side events',
      ]);
    });

    it('an unknown param value reads as the filter being absent', () => {
      renderChips('/tournaments?tier=foo&setting=x&side=y');
      expect(
        screen.getAllByRole('button').filter((b) => b.getAttribute('aria-pressed') === 'true'),
      ).toHaveLength(0);
      expect(screen.queryByRole('button', { name: 'Clear filters' })).not.toBeInTheDocument();
    });
  });

  describe('E2 partial: tier=foo,major applies major only', () => {
    it('shows exactly the applied state and offers Clear filters', () => {
      renderChips('/tournaments?tier=foo,major');
      const pressed = screen
        .getAllByRole('button')
        .filter((b) => b.getAttribute('aria-pressed') === 'true');
      expect(pressed.map((b) => b.textContent)).toEqual(['Major (2)']);
      expect(screen.getByRole('button', { name: 'Clear filters' })).toBeInTheDocument();
    });
  });

  describe('E2 empty: a zero-count tier is disabled with its count, never hidden', () => {
    it('renders Regional (0) present and aria-disabled', () => {
      renderChips();
      const regional = screen.getByRole('button', { name: 'Regional (0)' });
      expect(regional).toHaveAttribute('aria-disabled', 'true');
      expect(regional).toBeDisabled();
      expect(regional.className).toMatch(/opacity-50/);
    });

    it('an account with only unknown events shows five disabled chips', () => {
      renderChips('/tournaments', {
        tierCounts: { supermajor: 0, major: 0, minor: 0, regional: 0, local: 0, unknown: 13 },
      });
      const group = screen.getByRole('toolbar', { name: 'Tier' });
      const disabled = within(group)
        .getAllByRole('button')
        .filter((b) => b.getAttribute('aria-disabled') === 'true');
      expect(disabled).toHaveLength(5);
      expect(screen.getByRole('button', { name: 'Tier unknown (13)' })).not.toBeDisabled();
    });

    it('a pressed chip whose count fell to zero stays enabled so it can be un-pressed', async () => {
      renderChips('/tournaments?tier=regional');
      const regional = screen.getByRole('button', { name: 'Regional (0)' });
      expect(regional).not.toBeDisabled();
      const user = userEvent.setup();
      await user.click(regional);
      expect(search()).toBe('');
    });

    it('does nothing when a disabled chip is pressed', async () => {
      renderChips();
      const user = userEvent.setup();
      await user.click(screen.getByRole('button', { name: 'Minor (0)' }));
      expect(navigateSpy).not.toHaveBeenCalled();
    });
  });

  describe('presses write the URL through the single builder, replacing history', () => {
    it('pressing Major while Online is selected keeps both params and replaces the entry', async () => {
      renderChips('/tournaments?setting=online');
      const user = userEvent.setup();
      await user.click(screen.getByRole('button', { name: 'Major (2)' }));

      expect(navigateSpy).toHaveBeenCalledTimes(1);
      expect(navigateSpy.mock.calls[0]?.[1]).toEqual({ replace: true });
      expect(search()).toBe('?tier=major&setting=online');
    });

    it('a second tier press adds to the list in vocabulary order', async () => {
      renderChips('/tournaments?tier=unknown');
      const user = userEvent.setup();
      await user.click(screen.getByRole('button', { name: 'Supermajor (1)' }));
      expect(search()).toBe('?tier=supermajor%2Cunknown');
    });

    it('pressing a pressed tier removes it', async () => {
      renderChips('/tournaments?tier=major,unknown');
      const user = userEvent.setup();
      await user.click(screen.getByRole('button', { name: 'Major (2)' }));
      expect(search()).toBe('?tier=unknown');
    });

    it('the setting group is single-select and deselecting clears it (both settings)', async () => {
      renderChips('/tournaments');
      const user = userEvent.setup();
      await user.click(screen.getByRole('button', { name: 'Online (12)' }));
      expect(search()).toBe('?setting=online');
      await user.click(screen.getByRole('button', { name: 'Offline (4)' }));
      expect(search()).toBe('?setting=offline');
      await user.click(screen.getByRole('button', { name: 'Offline (4)' }));
      expect(search()).toBe('');
      expect(navigateSpy.mock.calls.every((call) => call[1]?.replace === true)).toBe(true);
    });

    it('Hide side events writes side=hide and removes it again', async () => {
      renderChips('/tournaments');
      const user = userEvent.setup();
      await user.click(screen.getByRole('button', { name: 'Hide side events' }));
      expect(search()).toBe('?side=hide');
      await user.click(screen.getByRole('button', { name: 'Hide side events' }));
      expect(search()).toBe('');
    });

    it('keeps unrelated params on every press', async () => {
      renderChips('/tournaments?claim=tierGap%3Aall&from=10');
      const user = userEvent.setup();
      await user.click(screen.getByRole('button', { name: 'Major (2)' }));
      const params = new URLSearchParams(search() ?? '');
      expect(params.get('claim')).toBe('tierGap:all');
      expect(params.get('from')).toBe('10');
      expect(params.get('tier')).toBe('major');
    });

    it('never writes to device-local storage (D-13)', async () => {
      const setItem = vi.spyOn(Storage.prototype, 'setItem');
      renderChips('/tournaments');
      const user = userEvent.setup();
      await user.click(screen.getByRole('button', { name: 'Major (2)' }));
      await user.click(screen.getByRole('button', { name: 'Online (12)' }));
      await user.click(screen.getByRole('button', { name: 'Hide side events' }));
      expect(setItem).not.toHaveBeenCalled();
      setItem.mockRestore();
    });
  });

  describe('Clear filters', () => {
    it('is absent with no chip on', () => {
      renderChips();
      expect(screen.queryByRole('button', { name: 'Clear filters' })).not.toBeInTheDocument();
    });

    it('removes tier, setting and side but keeps unrelated params', async () => {
      renderChips('/tournaments?tier=major&setting=online&side=hide&claim=x');
      const user = userEvent.setup();
      await user.click(screen.getByRole('button', { name: 'Clear filters' }));
      expect(search()).toBe('?claim=x');
      expect(navigateSpy.mock.calls.at(-1)?.[1]).toEqual({ replace: true });
      expect(screen.queryByRole('button', { name: 'Clear filters' })).not.toBeInTheDocument();
    });
  });

  describe('chip anatomy (UI-SPEC §4.2 rule 10, §7.3)', () => {
    it('a pressed chip is neutral, never the brand colour', () => {
      renderChips('/tournaments?tier=major');
      const major = screen.getByRole('button', { name: 'Major (2)' });
      expect(major).toHaveAttribute('data-state', 'on');
      expect(major.className).toMatch(/data-\[state=on\]:bg-muted/);
      expect(major.className).toMatch(/data-\[state=on\]:border-foreground\/40/);
      expect(major.className).not.toMatch(/primary/);
      expect(major.className).toMatch(/h-8/);
      expect(major.className).toMatch(/rounded-full/);
    });

    it('each chip group is a labelled toolbar (radix roving focus), named by its overline label', () => {
      renderChips();
      expect(screen.getByRole('toolbar', { name: 'Tier' })).toBeInTheDocument();
      expect(screen.getByRole('toolbar', { name: 'Setting' })).toBeInTheDocument();
    });

    it('the count is a tabular figure inside the chip label', () => {
      renderChips();
      expect(screen.getByRole('button', { name: 'Major (2)' }).innerHTML).toMatch(/tabular-nums/);
    });
  });

  describe('E2 overflow: below 640px the groups live in the Sheet behind "Filters (n)"', () => {
    it('renders only the Filters button with no active-count badge when nothing is on', () => {
      renderChips('/tournaments', { layout: 'stack' });
      const button = screen.getByRole('button', { name: /^Filters/ });
      expect(button).toBeInTheDocument();
      expect(within(button).queryByText(/^\d+$/)).not.toBeInTheDocument();
      expect(screen.queryByRole('toolbar', { name: 'Tier' })).not.toBeInTheDocument();
    });

    it('carries the active-filter count as a badge', () => {
      renderChips('/tournaments?tier=major,unknown&setting=online', { layout: 'stack' });
      const button = screen.getByRole('button', { name: /^Filters/ });
      expect(within(button).getByText('3')).toBeInTheDocument();
    });

    it('opens the Sheet with all three groups and Clear filters in the footer', async () => {
      renderChips('/tournaments?tier=major', { layout: 'stack' });
      const user = userEvent.setup();
      await user.click(screen.getByRole('button', { name: /^Filters/ }));

      const dialog = await screen.findByRole('dialog');
      expect(within(dialog).getByRole('toolbar', { name: 'Tier' })).toBeInTheDocument();
      expect(within(dialog).getByRole('toolbar', { name: 'Setting' })).toBeInTheDocument();
      expect(within(dialog).getByRole('button', { name: 'Hide side events' })).toBeInTheDocument();

      await user.click(within(dialog).getByRole('button', { name: 'Clear filters' }));
      expect(search()).toBe('');
    });

    it('a press inside the Sheet writes the URL like the inline chips', async () => {
      renderChips('/tournaments', { layout: 'stack' });
      const user = userEvent.setup();
      await user.click(screen.getByRole('button', { name: /^Filters/ }));
      const dialog = await screen.findByRole('dialog');
      await user.click(within(dialog).getByRole('button', { name: 'Major (2)' }));
      expect(search()).toBe('?tier=major');
      expect(navigateSpy.mock.calls.at(-1)?.[1]).toEqual({ replace: true });
    });
  });
});
