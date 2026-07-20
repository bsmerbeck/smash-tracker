import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { IntentOptionCard } from './IntentOptionCard';

describe('IntentOptionCard', () => {
  it('renders title/description and fires onSelect with its intent on click', async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn();
    render(
      <IntentOptionCard
        intent="scout"
        icon="🔍"
        title="Scout an opponent"
        description="Build a report before you play them"
        onSelect={onSelect}
      />,
    );

    expect(screen.getByText('Scout an opponent')).toBeInTheDocument();
    expect(screen.getByText('Build a report before you play them')).toBeInTheDocument();

    await user.click(screen.getByTestId('intent-option-scout'));
    expect(onSelect).toHaveBeenCalledWith('scout');
  });

  it('shows the "Suggested for you" badge and aria-pressed=true only when preselected', () => {
    render(
      <IntentOptionCard
        intent="review_vod"
        icon="🎬"
        title="Review a VOD"
        description="Watch and annotate a recorded set"
        preselected
        onSelect={vi.fn()}
      />,
    );

    expect(screen.getByText('Suggested for you')).toBeInTheDocument();
    expect(screen.getByTestId('intent-option-review_vod')).toHaveAttribute('aria-pressed', 'true');
  });

  it('is disabled and does not fire onSelect when disabled', async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn();
    render(
      <IntentOptionCard
        intent="prepare"
        icon="🏆"
        title="Prepare for a tournament"
        description="Get ready for an upcoming event"
        disabled
        onSelect={onSelect}
      />,
    );

    await user.click(screen.getByTestId('intent-option-prepare'));
    expect(onSelect).not.toHaveBeenCalled();
  });
});
