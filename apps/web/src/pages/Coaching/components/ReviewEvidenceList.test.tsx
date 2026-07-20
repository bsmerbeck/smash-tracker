import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReviewSection, VodTimestamp } from '@smash-tracker/shared';
import { ReviewEvidenceList } from './ReviewEvidenceList';

function makeTimestamp(overrides: Partial<VodTimestamp> = {}): VodTimestamp {
  return { id: 't1', seconds: 42, note: 'missed ledgetrap', ...overrides } as VodTimestamp;
}

function makeSection(overrides: Partial<ReviewSection> = {}): ReviewSection {
  return { id: 'summary', kind: 'summary', hidden: false, title: null, body: '', ...overrides };
}

describe('ReviewEvidenceList', () => {
  it('renders each note as an evidence row with its timestamp and text', () => {
    render(
      <ReviewEvidenceList
        timestamps={[makeTimestamp()]}
        sourceMatchId="m1"
        sections={[]}
        getCurrentTimeRef={{ current: null }}
        onCite={vi.fn()}
      />,
    );

    expect(screen.getByText('missed ledgetrap')).toBeInTheDocument();
    expect(screen.getByText('0:42')).toBeInTheDocument();
  });

  it('shows the empty state when there are no timestamps', () => {
    render(
      <ReviewEvidenceList
        timestamps={[]}
        sourceMatchId="m1"
        sections={[]}
        getCurrentTimeRef={{ current: null }}
        onCite={vi.fn()}
      />,
    );

    expect(screen.getByText('No timestamped notes on this source yet.')).toBeInTheDocument();
  });

  it('Cite fires onCite with a snapshot token built from the note current seconds/text', async () => {
    const user = userEvent.setup();
    const onCite = vi.fn();
    render(
      <ReviewEvidenceList
        timestamps={[makeTimestamp({ seconds: 90, note: 'panic airdodge' })]}
        sourceMatchId="m1"
        sections={[]}
        getCurrentTimeRef={{ current: null }}
        onCite={onCite}
      />,
    );

    await user.click(screen.getByRole('button', { name: 'Cite' }));

    expect(onCite).toHaveBeenCalledWith({
      sourceVodRef: 'm1',
      seconds: 90,
      label: 'panic airdodge',
    });
  });

  it('⏱ Cite current moment fires onCite with the live playback position and an empty label', async () => {
    const user = userEvent.setup();
    const onCite = vi.fn();
    render(
      <ReviewEvidenceList
        timestamps={[]}
        sourceMatchId="m1"
        sections={[]}
        getCurrentTimeRef={{ current: () => 222 }}
        onCite={onCite}
      />,
    );

    await user.click(screen.getByRole('button', { name: '⏱ Cite current moment' }));

    expect(onCite).toHaveBeenCalledWith({ sourceVodRef: 'm1', seconds: 222, label: '' });
  });

  it('disables Cite actions when no source is selected', () => {
    render(
      <ReviewEvidenceList
        timestamps={[makeTimestamp()]}
        sourceMatchId={null}
        sections={[]}
        getCurrentTimeRef={{ current: null }}
        onCite={vi.fn()}
      />,
    );

    expect(screen.getByRole('button', { name: 'Cite' })).toBeDisabled();
    expect(screen.getByRole('button', { name: '⏱ Cite current moment' })).toBeDisabled();
  });

  it('shows an already-cited indicator when a section body carries a matching citation token', () => {
    render(
      <ReviewEvidenceList
        timestamps={[makeTimestamp({ seconds: 42, note: 'missed ledgetrap' })]}
        sourceMatchId="m1"
        sections={[
          makeSection({
            body: 'Look here {{cite:matchId=m1;seconds=42;label=missed%20ledgetrap}} again',
          }),
        ]}
        getCurrentTimeRef={{ current: null }}
        onCite={vi.fn()}
      />,
    );

    expect(screen.getByText('cited')).toBeInTheDocument();
  });

  it('does not show a cited indicator for a note that has not been cited yet', () => {
    render(
      <ReviewEvidenceList
        timestamps={[makeTimestamp({ seconds: 42 })]}
        sourceMatchId="m1"
        sections={[makeSection({ body: 'no citations here' })]}
        getCurrentTimeRef={{ current: null }}
        onCite={vi.fn()}
      />,
    );

    expect(screen.queryByText('cited')).not.toBeInTheDocument();
  });
});
