import { describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import { resolve } from 'node:path';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { RecordBar, ShareBar, MiniStrip, type ShareBarSegment } from './inlineMarks';

function segment(key: string, count: number, label = key): ShareBarSegment {
  return {
    key,
    label,
    count,
    record: <span>{`record-${key}`}</span>,
    delta: <span>{`delta-${key}`}</span>,
  };
}

describe('RecordBar', () => {
  it('flexes the two segments by wins and losses and is decorative', () => {
    const { container } = render(<RecordBar wins={3} losses={1} />);
    const root = container.querySelector('[data-slot="record-bar"]') as HTMLElement;
    const win = container.querySelector('[data-slot="record-bar-win"]') as HTMLElement;
    const loss = container.querySelector('[data-slot="record-bar-loss"]') as HTMLElement;
    expect(root.getAttribute('aria-hidden')).toBe('true');
    expect(win.style.width).toBe('75%');
    expect(loss.style.width).toBe('25%');
  });

  it('renders a different ratio for a different record', () => {
    const { container } = render(<RecordBar wins={1} losses={4} />);
    const win = container.querySelector('[data-slot="record-bar-win"]') as HTMLElement;
    const loss = container.querySelector('[data-slot="record-bar-loss"]') as HTMLElement;
    expect(win.style.width).toBe('20%');
    expect(loss.style.width).toBe('80%');
  });
});

describe('ShareBar', () => {
  it('renders one segment and one row per category up to 4', () => {
    const { container } = render(
      <ShareBar
        segments={[segment('a', 10), segment('b', 10), segment('c', 10), segment('d', 10)]}
        total={40}
        headerLabel="Match type mix"
        shareSuffix={(pct) => `${pct}% of games`}
        emptyNode={<p>empty</p>}
        ariaSummary="Share of games by match type"
      />,
    );
    expect(container.querySelectorAll('[data-slot="share-bar-segment"]')).toHaveLength(4);
    expect(container.querySelectorAll('[data-slot="share-bar-row"]')).toHaveLength(4);
  });

  it('folds a 5th category into the 4th, rendering exactly 4 segments and 4 rows', () => {
    const { container } = render(
      <ShareBar
        segments={[
          segment('a', 10),
          segment('b', 10),
          segment('c', 10),
          segment('d', 5),
          segment('e', 5),
        ]}
        total={40}
        headerLabel="Match type mix"
        shareSuffix={(pct) => `${pct}% of games`}
        emptyNode={<p>empty</p>}
        ariaSummary="Share of games by match type"
        foldedLabel="Other"
      />,
    );
    expect(container.querySelectorAll('[data-slot="share-bar-segment"]')).toHaveLength(4);
    expect(container.querySelectorAll('[data-slot="share-bar-row"]')).toHaveLength(4);
    expect(screen.getByText('Other')).toBeInTheDocument();
  });

  it('renders a category alongside 1 sibling and alongside 3 siblings with the identical fill', () => {
    const { container: c1 } = render(
      <ShareBar
        segments={[segment('shared', 5), segment('other1', 5)]}
        total={10}
        headerLabel="h"
        shareSuffix={(pct) => `${pct}%`}
        emptyNode={<p>e</p>}
        ariaSummary="s"
      />,
    );
    const { container: c2 } = render(
      <ShareBar
        segments={[
          segment('shared', 5),
          segment('other2', 5),
          segment('other3', 5),
          segment('other4', 5),
        ]}
        total={20}
        headerLabel="h"
        shareSuffix={(pct) => `${pct}%`}
        emptyNode={<p>e</p>}
        ariaSummary="s"
      />,
    );
    const fill1 = (c1.querySelectorAll('[data-slot="share-bar-segment"]')[0] as HTMLElement).style
      .backgroundColor;
    const fill2 = (c2.querySelectorAll('[data-slot="share-bar-segment"]')[0] as HTMLElement).style
      .backgroundColor;
    expect(fill1).toBe(fill2);
    expect(fill1).not.toBe('');
  });

  it('renders a fractional share below the minimum width at the minimum width while printing the computed integer share', () => {
    const { container } = render(
      <ShareBar
        segments={[segment('big', 97), segment('tiny', 3)]}
        total={100}
        headerLabel="h"
        shareSuffix={(pct) => `${pct}% of games`}
        emptyNode={<p>e</p>}
        ariaSummary="s"
      />,
    );
    const segments = container.querySelectorAll('[data-slot="share-bar-segment"]');
    const tinySegment = segments[1] as HTMLElement;
    expect(tinySegment.style.minWidth).toBe('6px');
    expect(screen.getByText('3% of games')).toBeInTheDocument();
  });

  it('prints shares that sum to 100 for counts that do not divide evenly', () => {
    render(
      <ShareBar
        segments={[segment('a', 1), segment('b', 1), segment('c', 1)]}
        total={3}
        headerLabel="h"
        shareSuffix={(pct) => `SHARE:${pct}`}
        emptyNode={<p>e</p>}
        ariaSummary="s"
      />,
    );
    const matches = screen.getAllByText(/^SHARE:\d+$/);
    const sum = matches.reduce(
      (acc, node) => acc + Number(node.textContent!.replace('SHARE:', '')),
      0,
    );
    expect(sum).toBe(100);
  });

  it('renders zero segments, zero rows, the header line and the empty node at 0 games', () => {
    const { container } = render(
      <ShareBar
        segments={[]}
        total={0}
        headerLabel="Match type mix"
        shareSuffix={(pct) => `${pct}%`}
        emptyNode={<p>No games in this view yet.</p>}
        ariaSummary="s"
      />,
    );
    expect(container.querySelectorAll('[data-slot="share-bar-segment"]')).toHaveLength(0);
    expect(container.querySelectorAll('[data-slot="share-bar-row"]')).toHaveLength(0);
    expect(screen.getByText('Match type mix')).toBeInTheDocument();
    expect(screen.getByText('No games in this view yet.')).toBeInTheDocument();
  });

  it('renders exactly 1 segment and 1 row for a single category at 100%', () => {
    const { container } = render(
      <ShareBar
        segments={[segment('only', 10)]}
        total={10}
        headerLabel="h"
        shareSuffix={(pct) => `${pct}% of games`}
        emptyNode={<p>e</p>}
        ariaSummary="s"
      />,
    );
    expect(container.querySelectorAll('[data-slot="share-bar-segment"]')).toHaveLength(1);
    expect(container.querySelectorAll('[data-slot="share-bar-row"]')).toHaveLength(1);
    expect(screen.getByText('100% of games')).toBeInTheDocument();
  });

  it('renders segments and rows as links when onSelectSegment is given, with the row (not the segment) as the tab stop', async () => {
    const user = userEvent.setup();
    const onSelectSegment = vi.fn();
    const { container } = render(
      <ShareBar
        segments={[segment('a', 5), segment('b', 5)]}
        total={10}
        headerLabel="h"
        shareSuffix={(pct) => `${pct}%`}
        emptyNode={<p>e</p>}
        ariaSummary="s"
        onSelectSegment={onSelectSegment}
      />,
    );
    const rowButtons = screen.getAllByRole('button');
    expect(rowButtons).toHaveLength(2);
    expect(rowButtons[0]!.tabIndex).toBe(0);
    const segmentEl = container.querySelector('[data-slot="share-bar-segment"]') as HTMLElement;
    expect(segmentEl.tabIndex).toBe(-1);
    await user.click(rowButtons[0]!);
    expect(onSelectSegment).toHaveBeenCalledWith(expect.objectContaining({ key: 'a' }));
  });
});

describe('MiniStrip', () => {
  it('renders nothing at 0 games', () => {
    const { container } = render(<MiniStrip games={[]} ariaLabel="no games" />);
    expect(container.firstChild).toBeNull();
  });

  it('renders one tick per game with an image role summary label', () => {
    const { container } = render(
      <MiniStrip
        games={[
          { key: 'g1', won: true },
          { key: 'g2', won: false },
        ]}
        ariaLabel="Recent form: 1-1"
      />,
    );
    expect(screen.getByRole('img', { name: 'Recent form: 1-1' })).toBeInTheDocument();
    expect(container.querySelectorAll('[data-slot^="mini-strip-tick"]')).toHaveLength(2);
  });
});

describe('inlineMarks source-tree guards (UIX-05, VIZ-02)', () => {
  const source = fs.readFileSync(
    resolve(process.cwd(), 'src/components/charts/inlineMarks.tsx'),
    'utf8',
  );
  const codeOnly = source
    .split('\n')
    .filter((line) => !/^\s*(\*|\/\/|\/\*)/.test(line))
    .join('\n');

  it('imports only from ./tokens within the kit, and never the charting library or i18n', () => {
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

  it("ShareBar's fixed fills draw from CHART_TOKENS.series1/series2/deemphasis/deemphasisStrong", () => {
    expect(codeOnly).toMatch(/CHART_TOKENS\.series1/);
    expect(codeOnly).toMatch(/CHART_TOKENS\.series2/);
    expect(codeOnly).toMatch(/CHART_TOKENS\.deemphasis\b/);
    expect(codeOnly).toMatch(/CHART_TOKENS\.deemphasisStrong/);
  });
});
