import { describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import { resolve } from 'node:path';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { FormStrip, SetStrip, type FormStripEvent, type FormStripGame } from './FormStrip';

function game(key: string, won: boolean): FormStripGame {
  return { key, won, label: `${won ? 'win' : 'loss'} ${key}` };
}

function twoEventFixture(inRecentWindow = true): FormStripEvent[] {
  return [
    {
      key: 'evt-1',
      label: 'Genesis 10',
      record: '2-1',
      sets: [
        {
          key: 'set-1',
          label: 'Genesis 10, vs Alice, 2-1',
          inRecentWindow,
          games: [game('g1', true), game('g2', false), game('g3', true)],
        },
      ],
    },
    {
      key: 'evt-2',
      label: 'Weekly #12',
      record: '1-0',
      sets: [
        {
          key: 'set-2',
          label: 'Weekly #12, vs Bob, 1-0',
          inRecentWindow,
          games: [game('g4', true)],
        },
      ],
    },
  ];
}

function ninetyGameFixture(): FormStripEvent[] {
  const sets = [];
  for (let s = 0; s < 18; s++) {
    const games: FormStripGame[] = [];
    for (let g = 0; g < 5; g++) {
      games.push(game(`s${s}-g${g}`, (s + g) % 2 === 0));
    }
    sets.push({
      key: `set-${s}`,
      label: `set ${s}`,
      inRecentWindow: true,
      games,
    });
  }
  return [{ key: 'evt-1', label: 'Long Event', record: '45-45', sets }];
}

const emptyLabels = {
  summary: 'summary',
  legend: 'legend',
  empty: <p>No games in this view yet.</p>,
};

describe('FormStrip', () => {
  it('renders tick count, group boundaries and event labels for a two-event fixture', () => {
    const { container } = render(
      <FormStrip events={twoEventFixture()} limit={60} labels={emptyLabels} />,
    );
    const ticks = container.querySelectorAll('[data-slot="form-strip-tick"]');
    expect(ticks).toHaveLength(4);
    const eventGroups = container.querySelectorAll('[data-slot="form-strip-event"]');
    expect(eventGroups).toHaveLength(2);
    expect(screen.getByText('Genesis 10')).toBeInTheDocument();
    expect(screen.getByText('Weekly #12')).toBeInTheDocument();
  });

  it('renders exactly 60 ticks and the shown-of-total label for a 90-game fixture at limit 60', () => {
    const { container } = render(
      <FormStrip
        events={ninetyGameFixture()}
        limit={60}
        labels={{ ...emptyLabels, shownOfTotal: '60 of 90 games shown' }}
      />,
    );
    const ticks = container.querySelectorAll('[data-slot="form-strip-tick"]');
    expect(ticks).toHaveLength(60);
    expect(screen.getByText('60 of 90 games shown')).toBeInTheDocument();
  });

  it('distinguishes win and loss ticks by vertical position, not colour', () => {
    const { container } = render(
      <FormStrip events={twoEventFixture()} limit={60} labels={emptyLabels} />,
    );
    const winTick = container.querySelector('[data-slot="form-strip-tick"][title^="win"]');
    const lossTick = container.querySelector('[data-slot="form-strip-tick"][title^="loss"]');
    expect((winTick as HTMLElement).style.alignItems).toBe('flex-start');
    expect((lossTick as HTMLElement).style.alignItems).toBe('flex-end');
    // No assertion in this suite depends on a colour value.
  });

  it('renders the empty node, zero ticks, no legend and no group role at 0 games', () => {
    const { container } = render(<FormStrip events={[]} limit={60} labels={emptyLabels} />);
    expect(container.querySelectorAll('[data-slot="form-strip-tick"]')).toHaveLength(0);
    expect(screen.queryByText('legend')).not.toBeInTheDocument();
    expect(screen.queryByRole('group')).not.toBeInTheDocument();
    expect(screen.getByText('No games in this view yet.')).toBeInTheDocument();
  });

  it('renders exactly 1 real tick at 1 game, no padding', () => {
    const events: FormStripEvent[] = [
      {
        key: 'evt-1',
        label: 'Solo Event',
        record: '1-0',
        sets: [
          { key: 'set-1', label: 'solo set', inRecentWindow: true, games: [game('g1', true)] },
        ],
      },
    ];
    const { container } = render(<FormStrip events={events} limit={30} labels={emptyLabels} />);
    expect(container.querySelectorAll('[data-slot="form-strip-tick"]')).toHaveLength(1);
  });

  it('renders exactly 2 real ticks at 2 games, no padding', () => {
    const events: FormStripEvent[] = [
      {
        key: 'evt-1',
        label: 'Duo Event',
        record: '1-1',
        sets: [
          {
            key: 'set-1',
            label: 'duo set',
            inRecentWindow: true,
            games: [game('g1', true), game('g2', false)],
          },
        ],
      },
    ];
    const { container } = render(<FormStrip events={events} limit={30} labels={emptyLabels} />);
    expect(container.querySelectorAll('[data-slot="form-strip-tick"]')).toHaveLength(2);
  });

  it('dims every tick and highlights nothing when games exist but none are in the recent window', () => {
    const { container } = render(
      <FormStrip
        events={twoEventFixture(false)}
        limit={60}
        labels={{ ...emptyLabels, windowEmpty: 'No games in the last 90 days — all games shown.' }}
      />,
    );
    const ticks = Array.from(container.querySelectorAll('[data-slot="form-strip-tick"]'));
    expect(ticks.length).toBeGreaterThan(0);
    for (const tick of ticks) {
      expect((tick as HTMLElement).style.opacity).toBe('0.32');
    }
    expect(screen.getByText('No games in the last 90 days — all games shown.')).toBeInTheDocument();
  });

  it('makes a set a tab stop and a tick not a tab stop', () => {
    const { container } = render(
      <FormStrip events={twoEventFixture()} limit={60} labels={emptyLabels} />,
    );
    const set = container.querySelector('[data-slot="form-strip-set"]') as HTMLElement;
    const tick = container.querySelector('[data-slot="form-strip-tick"]') as HTMLElement;
    expect(set.tabIndex).toBe(0);
    expect(tick.tabIndex).toBe(-1);
  });

  it('fires onSelectSet with the set key on activation', async () => {
    const user = userEvent.setup();
    const onSelectSet = vi.fn();
    const { container } = render(
      <FormStrip
        events={twoEventFixture()}
        limit={60}
        labels={emptyLabels}
        onSelectSet={onSelectSet}
      />,
    );
    const set = container.querySelector('[data-slot="form-strip-set"]') as HTMLElement;
    await user.click(set);
    expect(onSelectSet).toHaveBeenCalledWith('set-1');
  });

  it('SetStrip renders nothing at 0 sets', () => {
    const { container } = render(<SetStrip sets={[]} ariaLabel="no sets" />);
    expect(container.firstChild).toBeNull();
  });

  it('SetStrip renders one tick per set', () => {
    render(
      <SetStrip
        sets={[
          { key: 's1', won: true, label: 'set 1 won' },
          { key: 's2', won: false, label: 'set 2 lost' },
        ]}
        ariaLabel="Sets: 1-1"
      />,
    );
    expect(screen.getByRole('img', { name: 'Sets: 1-1' })).toBeInTheDocument();
  });
});

describe('FormStrip source-tree guards (UIX-05, VIZ-02)', () => {
  const source = fs.readFileSync(
    resolve(process.cwd(), 'src/components/charts/FormStrip.tsx'),
    'utf8',
  );
  const codeOnly = source
    .split('\n')
    .filter((line) => !/^\s*(\*|\/\/|\/\*)/.test(line))
    .join('\n');

  it('imports only from ./tokens within the kit, and never the charting library', () => {
    expect(source).not.toMatch(/from\s+['"]recharts['"]/);
    const kitImports = [...source.matchAll(/from\s+['"](\.\/[^'"]+)['"]/g)].map((m) => m[1]);
    expect(kitImports).toEqual(['./tokens']);
  });

  it('contains no hex colour literal and no useTranslation call', () => {
    expect(source).not.toMatch(/#[0-9a-fA-F]{6}\b/);
    expect(source).not.toMatch(/useTranslation/);
  });

  it('references CHART_TOKENS.win and CHART_TOKENS.loss (positive consumption scan)', () => {
    expect(codeOnly).toMatch(/CHART_TOKENS\.win/);
    expect(codeOnly).toMatch(/CHART_TOKENS\.loss/);
  });

  it('declares no colour/fill/tint member on its exported prop types', () => {
    const propBlocks = source.match(/export interface FormStrip\w*Props[\s\S]*?\n}/g) ?? [];
    for (const block of propBlocks) {
      expect(block).not.toMatch(/\b(colou?r|fill|tint)\??:/i);
    }
  });
});
