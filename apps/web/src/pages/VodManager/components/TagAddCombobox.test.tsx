import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MATCH_PRESET_TAGS } from '@/lib/tags';
import { TagAddCombobox } from './TagAddCombobox';

function renderCombobox(overrides: Partial<React.ComponentProps<typeof TagAddCombobox>> = {}) {
  const onAdd = vi.fn();
  render(
    <TagAddCombobox
      presets={MATCH_PRESET_TAGS}
      existingTags={[]}
      vocabulary={[]}
      onAdd={onAdd}
      ariaLabel="Add a tag"
      {...overrides}
    />,
  );
  return { onAdd };
}

describe('TagAddCombobox', () => {
  it('renders preset labels (not raw slugs)', async () => {
    const user = userEvent.setup();
    renderCombobox();

    await user.click(screen.getByRole('combobox', { name: 'Add a tag' }));

    expect(await screen.findByRole('option', { name: 'Tournament Set' })).toBeInTheDocument();
    expect(screen.queryByText('tournament-set')).not.toBeInTheDocument();
  });

  it('filters out a preset already in existingTags', async () => {
    const user = userEvent.setup();
    renderCombobox({ existingTags: ['tournament-set'] });

    await user.click(screen.getByRole('combobox', { name: 'Add a tag' }));

    expect(await screen.findByRole('option', { name: 'Practice/Friendlies' })).toBeInTheDocument();
    expect(screen.queryByRole('option', { name: 'Tournament Set' })).not.toBeInTheDocument();
  });

  it('shows a Create row for unmatched typed text', async () => {
    const user = userEvent.setup();
    renderCombobox();

    await user.click(screen.getByRole('combobox', { name: 'Add a tag' }));
    await user.type(screen.getByPlaceholderText('Search or create a tag...'), 'my new tag');

    expect(await screen.findByRole('option', { name: 'Create "my new tag"' })).toBeInTheDocument();
  });

  it('fires onAdd with the preset slug when a preset is selected', async () => {
    const user = userEvent.setup();
    const { onAdd } = renderCombobox();

    await user.click(screen.getByRole('combobox', { name: 'Add a tag' }));
    await user.click(await screen.findByRole('option', { name: 'Practice/Friendlies' }));

    expect(onAdd).toHaveBeenCalledWith('practice-friendlies');
  });

  it('fires onAdd with the trimmed raw text when creating a custom tag', async () => {
    const user = userEvent.setup();
    const { onAdd } = renderCombobox();

    await user.click(screen.getByRole('combobox', { name: 'Add a tag' }));
    await user.type(screen.getByPlaceholderText('Search or create a tag...'), '  my new tag  ');
    await user.click(await screen.findByRole('option', { name: 'Create "my new tag"' }));

    expect(onAdd).toHaveBeenCalledWith('my new tag');
  });

  it('fires onAdd with the preset slug when Create text normalizes onto a preset label', async () => {
    const user = userEvent.setup();
    const { onAdd } = renderCombobox();

    await user.click(screen.getByRole('combobox', { name: 'Add a tag' }));
    await user.type(
      screen.getByPlaceholderText('Search or create a tag...'),
      'practice/friendlies',
    );

    // Exact-match on the preset label means no Create row and selecting the
    // filtered preset item itself adds the slug.
    expect(screen.queryByText('Create "practice/friendlies"')).not.toBeInTheDocument();
    await user.click(await screen.findByRole('option', { name: 'Practice/Friendlies' }));
    expect(onAdd).toHaveBeenCalledWith('practice-friendlies');
  });

  it('renders custom vocabulary entries not already present', async () => {
    const user = userEvent.setup();
    renderCombobox({ vocabulary: ['my custom tag'] });

    await user.click(screen.getByRole('combobox', { name: 'Add a tag' }));

    expect(await screen.findByRole('option', { name: 'my custom tag' })).toBeInTheDocument();
  });
});
