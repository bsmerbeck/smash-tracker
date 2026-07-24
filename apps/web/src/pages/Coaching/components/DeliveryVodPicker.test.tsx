import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { Match } from '@smash-tracker/shared';
import { MAX_DELIVERY_VODS } from '@smash-tracker/shared';
import { DeliveryVodPicker } from './DeliveryVodPicker';

function makeMatch(overrides: Partial<Match> = {}): Match {
  return {
    id: 'm1',
    fighter_id: 1,
    opponent_id: 10,
    opponent: 'Zain',
    time: 1_700_000_000_000,
    win: true,
    vodUrl: 'https://youtu.be/abc123',
    ...overrides,
  } as Match;
}

describe('DeliveryVodPicker', () => {
  it('pre-checks the default-selected matchIds when it opens', () => {
    const vods = [makeMatch({ id: 'm1' }), makeMatch({ id: 'm2' })];
    render(
      <DeliveryVodPicker
        open
        onOpenChange={vi.fn()}
        vods={vods}
        defaultSelectedMatchIds={['m1']}
        onConfirm={vi.fn()}
        isPending={false}
      />,
    );

    const rows = screen.getAllByRole('button', { name: /Mario/ });
    expect(rows[0]).toHaveAttribute('aria-pressed', 'true');
    expect(rows[1]).toHaveAttribute('aria-pressed', 'false');
    expect(screen.getByText('1 VOD selected')).toBeInTheDocument();
  });

  it('toggling a row adds/removes it from the selection', async () => {
    const user = userEvent.setup();
    const vods = [makeMatch({ id: 'm1' }), makeMatch({ id: 'm2' })];
    render(
      <DeliveryVodPicker
        open
        onOpenChange={vi.fn()}
        vods={vods}
        defaultSelectedMatchIds={[]}
        onConfirm={vi.fn()}
        isPending={false}
      />,
    );

    const rows = screen.getAllByRole('button', { name: /Mario/ });
    expect(screen.getByText('0 VODs selected')).toBeInTheDocument();

    await user.click(rows[0]!);
    expect(rows[0]).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByText('1 VOD selected')).toBeInTheDocument();

    await user.click(rows[0]!);
    expect(rows[0]).toHaveAttribute('aria-pressed', 'false');
    expect(screen.getByText('0 VODs selected')).toBeInTheDocument();
  });

  it('prevents selecting beyond MAX_DELIVERY_VODS — further rows disable and the cap message shows', async () => {
    const user = userEvent.setup();
    const vods = Array.from({ length: MAX_DELIVERY_VODS + 1 }, (_, index) =>
      makeMatch({ id: `m${index}` }),
    );
    render(
      <DeliveryVodPicker
        open
        onOpenChange={vi.fn()}
        vods={vods}
        defaultSelectedMatchIds={vods.slice(0, MAX_DELIVERY_VODS).map((match) => match.id)}
        onConfirm={vi.fn()}
        isPending={false}
      />,
    );

    const rows = screen.getAllByRole('button', { name: /Mario/ });
    const lastRow = rows[rows.length - 1]!;
    expect(lastRow).toBeDisabled();
    expect(
      screen.getByText(`Up to ${MAX_DELIVERY_VODS} VODs can be included.`),
    ).toBeInTheDocument();

    // A selected row stays clickable (deselect must always work, even at cap).
    await user.click(rows[0]!);
    expect(rows[0]).toHaveAttribute('aria-pressed', 'false');
  });

  it('Confirm invokes onConfirm with the selected matchId list', async () => {
    const user = userEvent.setup();
    const onConfirm = vi.fn();
    const vods = [makeMatch({ id: 'm1' }), makeMatch({ id: 'm2' })];
    render(
      <DeliveryVodPicker
        open
        onOpenChange={vi.fn()}
        vods={vods}
        defaultSelectedMatchIds={['m1']}
        onConfirm={onConfirm}
        isPending={false}
      />,
    );

    await user.click(screen.getByRole('button', { name: 'Deliver' }));

    expect(onConfirm).toHaveBeenCalledWith(['m1']);
  });

  it('Cancel closes without minting', async () => {
    const user = userEvent.setup();
    const onConfirm = vi.fn();
    const onOpenChange = vi.fn();
    render(
      <DeliveryVodPicker
        open
        onOpenChange={onOpenChange}
        vods={[makeMatch()]}
        defaultSelectedMatchIds={[]}
        onConfirm={onConfirm}
        isPending={false}
      />,
    );

    await user.click(screen.getByRole('button', { name: 'Cancel' }));

    expect(onConfirm).not.toHaveBeenCalled();
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it('shows an empty-state for an empty client VOD library, with Confirm still allowed', () => {
    const onConfirm = vi.fn();
    render(
      <DeliveryVodPicker
        open
        onOpenChange={vi.fn()}
        vods={[]}
        defaultSelectedMatchIds={[]}
        onConfirm={onConfirm}
        isPending={false}
      />,
    );

    expect(
      screen.getByText(
        'This client has no VODs yet — you can still send this delivery without any footage.',
      ),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Deliver' })).not.toBeDisabled();
  });

  it('shows a pending state on the confirm button while the mint runs', () => {
    render(
      <DeliveryVodPicker
        open
        onOpenChange={vi.fn()}
        vods={[makeMatch()]}
        defaultSelectedMatchIds={[]}
        onConfirm={vi.fn()}
        isPending
      />,
    );

    expect(screen.getByRole('button', { name: 'Deliver' })).toBeDisabled();
  });
});
