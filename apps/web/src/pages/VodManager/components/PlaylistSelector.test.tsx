import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { Playlist } from '@smash-tracker/shared';
import { PlaylistSelector } from './PlaylistSelector';

function renderSelector(overrides: Partial<React.ComponentProps<typeof PlaylistSelector>> = {}) {
  const onSelect = vi.fn();
  const onCreate = vi.fn();
  render(
    <PlaylistSelector
      playlists={overrides.playlists ?? []}
      selectedPlaylistId={overrides.selectedPlaylistId ?? null}
      onSelect={overrides.onSelect ?? onSelect}
      onCreate={overrides.onCreate ?? onCreate}
      creating={overrides.creating ?? false}
    />,
  );
  return { onSelect, onCreate };
}

const playlist: Playlist = {
  id: 'p1',
  name: 'My Playlist',
  createdAt: 1,
  matchIds: ['m1'],
};

describe('PlaylistSelector', () => {
  it('shows an always-visible "New playlist" create row before the user types anything', async () => {
    const user = userEvent.setup();
    renderSelector({ playlists: [playlist] });

    await user.click(screen.getByRole('combobox', { name: 'Select playlist' }));

    // "Library" (the default view) plus the always-visible create CTA —
    // the popover must never present as a bare search box with nothing
    // to click.
    expect(screen.getByRole('option', { name: 'Library' })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: 'New playlist' })).toBeInTheDocument();
  });

  it('swaps the create row to "Create "{typed}"" once the user types a name, and fires onCreate with the trimmed text', async () => {
    const user = userEvent.setup();
    const { onCreate } = renderSelector({ playlists: [playlist] });

    await user.click(screen.getByRole('combobox', { name: 'Select playlist' }));
    await user.type(screen.getByPlaceholderText('Playlist name'), '  Grand Finals VODs  ');

    expect(screen.queryByRole('option', { name: 'New playlist' })).not.toBeInTheDocument();
    const createRow = await screen.findByRole('option', { name: 'Create "Grand Finals VODs"' });
    await user.click(createRow);

    expect(onCreate).toHaveBeenCalledWith('Grand Finals VODs');
  });

  it('disables the always-visible create row while no name is typed (nothing to create yet)', async () => {
    const user = userEvent.setup();
    renderSelector();

    await user.click(screen.getByRole('combobox', { name: 'Select playlist' }));

    expect(screen.getByRole('option', { name: 'New playlist' })).toHaveAttribute(
      'aria-disabled',
      'true',
    );
  });
});
