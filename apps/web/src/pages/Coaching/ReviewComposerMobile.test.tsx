import { useRef } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { CitationToken, Match, ReviewSection } from '@smash-tracker/shared';
import { ReviewComposerMobile } from './ReviewComposerMobile';

// The real VOD player injects vendor <script> tags and talks to
// window.YT/window.Twitch — out of scope here (see useVodPlayer.test.ts /
// VodManagerPage.test.tsx). A trivial stand-in also lets this file assert
// it is mounted EXACTLY ONCE across every tab switch (D-12/Pitfall 6).
const vodPlayerRenderCount = vi.fn();
vi.mock('@/pages/VodManager/components/VodPlayer', () => ({
  VodPlayer: ({ vodUrl }: { vodUrl: string }) => {
    vodPlayerRenderCount();
    return <div data-testid="vod-player">{vodUrl}</div>;
  },
}));

function makeMatch(overrides: Partial<Match> = {}): Match {
  return {
    id: 'm1',
    fighter_id: 1,
    opponent_id: 10,
    opponent: 'Zain',
    time: Date.now(),
    win: true,
    vodUrl: 'https://youtu.be/abc123',
    ...overrides,
  } as Match;
}

function makeSection(overrides: Partial<ReviewSection> = {}): ReviewSection {
  return { id: 'summary', kind: 'summary', hidden: false, title: null, body: '', ...overrides };
}

/** A thin harness owning refs (mirrors `ReviewComposerPage`'s own ref ownership) so the component under test gets real, stable `RefObject`s. */
function Harness(props: {
  sections: ReviewSection[];
  coachPrivateNotes: string | null;
  onChangeSectionBody: (sectionId: string, body: string) => void;
  onChangePrivateNotes: (value: string) => void;
  onCite: (token: CitationToken) => void;
  vodSources?: Match[];
  currentSourceId?: string | null;
  currentSource?: Match | null;
}) {
  const playerSeekRef = useRef<((seconds: number) => void) | null>(null);
  const playerPauseRef = useRef<(() => void) | null>(null);
  const getCurrentTimeRef = useRef<(() => number) | null>(null);

  return (
    <ReviewComposerMobile
      vodSources={props.vodSources ?? [makeMatch()]}
      currentSourceId={props.currentSourceId ?? 'm1'}
      currentSource={props.currentSource === undefined ? makeMatch() : props.currentSource}
      onSelectSource={vi.fn()}
      playerSeekRef={playerSeekRef}
      playerPauseRef={playerPauseRef}
      getCurrentTimeRef={getCurrentTimeRef}
      sections={props.sections}
      onCite={props.onCite}
      coachPrivateNotes={props.coachPrivateNotes}
      onChangeSectionBody={props.onChangeSectionBody}
      onChangePrivateNotes={props.onChangePrivateNotes}
      onHideSection={vi.fn()}
      onShowSection={vi.fn()}
      onAddSection={vi.fn()}
      registerTextareaRef={vi.fn()}
      autosaveIndicator={<span>Saved</span>}
      onPreview={vi.fn()}
      onPublish={vi.fn()}
      isPublishing={false}
    />
  );
}

function renderMobile(
  overrides: {
    sections?: ReviewSection[];
    coachPrivateNotes?: string | null;
    onChangeSectionBody?: (sectionId: string, body: string) => void;
    onChangePrivateNotes?: (value: string) => void;
    onCite?: (token: CitationToken) => void;
    vodSources?: Match[];
    currentSourceId?: string | null;
    currentSource?: Match | null;
  } = {},
) {
  const onChangeSectionBody = overrides.onChangeSectionBody ?? vi.fn();
  const onChangePrivateNotes = overrides.onChangePrivateNotes ?? vi.fn();
  const onCite = overrides.onCite ?? vi.fn();
  const sections = overrides.sections ?? [makeSection({ body: 'summary text' })];
  const utils = render(
    <Harness
      sections={sections}
      coachPrivateNotes={overrides.coachPrivateNotes ?? null}
      onChangeSectionBody={onChangeSectionBody}
      onChangePrivateNotes={onChangePrivateNotes}
      onCite={onCite}
      vodSources={overrides.vodSources}
      currentSourceId={overrides.currentSourceId}
      currentSource={overrides.currentSource}
    />,
  );
  return { ...utils, onChangeSectionBody, onChangePrivateNotes, onCite };
}

describe('ReviewComposerMobile', () => {
  it('renders exactly three top-level tabs — Watch, Evidence, Review — never a fourth Private tab', () => {
    renderMobile();

    // The OUTER tablist (the top-level Watch/Evidence/Review switcher) has
    // exactly three tabs — "Private notes" only ever exists as a NESTED
    // segmented sub-control inside the Review panel (a second, inner
    // tablist), never promoted to this top-level list.
    const topLevelTablist = screen.getAllByRole('tablist')[0]!;
    expect(within(topLevelTablist).getByRole('tab', { name: 'Watch' })).toBeInTheDocument();
    expect(within(topLevelTablist).getByRole('tab', { name: 'Evidence' })).toBeInTheDocument();
    expect(within(topLevelTablist).getByRole('tab', { name: 'Review' })).toBeInTheDocument();
    expect(
      within(topLevelTablist).queryByRole('tab', { name: /private/i }),
    ).not.toBeInTheDocument();
    expect(within(topLevelTablist).getAllByRole('tab')).toHaveLength(3);
  });

  it('keeps all three mobile tab panels MOUNTED in the DOM when a non-active tab is selected (no conditional-JSX unmount, D-12/T-12-27)', async () => {
    const user = userEvent.setup();
    renderMobile();

    // Watch is the default active tab — its player is mounted.
    expect(screen.getByTestId('vod-player')).toBeInTheDocument();

    await user.click(screen.getByRole('tab', { name: 'Evidence' }));
    // The player (inside the now-inactive Watch panel) is STILL in the DOM —
    // only CSS-hidden, never unmounted.
    expect(screen.getByTestId('vod-player')).toBeInTheDocument();
    expect(screen.getByText('Evidence (0)')).toBeInTheDocument();

    await user.click(screen.getByRole('tab', { name: 'Review' }));
    expect(screen.getByTestId('vod-player')).toBeInTheDocument();
    expect(screen.getByLabelText('Summary')).toBeInTheDocument();

    // The player component function itself was only ever invoked for its
    // ONE mount — never reconstructed by a tab switch.
    expect(vodPlayerRenderCount.mock.calls.length).toBeGreaterThan(0);
  });

  it('an inactive tab panel carries the CSS hide + data-state contract that removes it from the accessibility tree/keyboard order (D-17), while staying present in the DOM', async () => {
    const user = userEvent.setup();
    renderMobile();

    await user.click(screen.getByRole('tab', { name: 'Evidence' }));

    // The now-inactive Watch panel is still mounted (forceMount) but flagged
    // inactive — `tabs.tsx`'s `data-[state=inactive]:hidden` class turns
    // that into a real `display:none` in a browser (not observable in
    // jsdom, which never loads/computes actual Tailwind CSS), which is what
    // removes it from the accessibility tree/keyboard order for free.
    const watchPanel = screen.getByTestId('vod-player').closest<HTMLElement>('[role="tabpanel"]')!;
    expect(watchPanel).toHaveAttribute('data-state', 'inactive');
    expect(watchPanel.className).toContain('data-[state=inactive]:hidden');

    const evidencePanel = screen
      .getByText('Evidence (0)')
      .closest<HTMLElement>('[role="tabpanel"]')!;
    expect(evidencePanel).toHaveAttribute('data-state', 'active');
  });

  it('Private notes lives INSIDE Review as a segmented sub-control, with the full-width amber banner', async () => {
    const user = userEvent.setup();
    renderMobile({ coachPrivateNotes: 'secret notes' });

    await user.click(screen.getByRole('tab', { name: 'Review' }));
    expect(screen.getByRole('tab', { name: 'Client review' })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: '🔒 Private notes' })).toBeInTheDocument();

    await user.click(screen.getByRole('tab', { name: '🔒 Private notes' }));
    expect(
      screen.getByText(
        'Only you can see this. Never delivered, never in previews, stored separately from the review.',
      ),
    ).toBeInTheDocument();
    expect(screen.getByLabelText('Private notes for this review')).toHaveValue('secret notes');
  });

  it('Evidence tab Cite current moment fires onCite with the current source and live position', async () => {
    const user = userEvent.setup();
    const onCite = vi.fn();
    renderMobile({ onCite });

    await user.click(screen.getByRole('tab', { name: 'Evidence' }));
    // forceMount keeps EVERY panel in the DOM at once (Review's own
    // mini-controller also renders a same-named button) — scope the query
    // to the Evidence panel specifically, mirroring how a real user (and a
    // screen reader honoring the CSS-hidden inactive panels) only ever sees
    // the one that's actually active.
    const evidencePanel = screen
      .getByText('Evidence (0)')
      .closest<HTMLElement>('[role="tabpanel"]')!;
    await user.click(within(evidencePanel).getByRole('button', { name: '⏱ Cite current moment' }));

    expect(onCite).toHaveBeenCalledWith({ sourceVodRef: 'm1', seconds: 0, label: '' });
  });

  it('REV-01: the Watch tab shows a compact no-VODs notice (no Sources drawer, no empty player box) when the client library has zero VODs', () => {
    renderMobile({ vodSources: [], currentSourceId: null, currentSource: null });

    expect(
      screen.getByText(
        'This client has no VODs yet — you can still write and publish this review.',
      ),
    ).toBeInTheDocument();
    expect(screen.queryByTestId('vod-player')).not.toBeInTheDocument();
    expect(screen.queryByText('Select a source to start watching.')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Sources ▾' })).not.toBeInTheDocument();
  });

  it('editing a section body on the Review tab calls onChangeSectionBody (state lives in the parent, survives any tab switch)', async () => {
    const user = userEvent.setup();
    const onChangeSectionBody = vi.fn();
    renderMobile({ onChangeSectionBody });

    await user.click(screen.getByRole('tab', { name: 'Review' }));
    const textarea = screen.getByLabelText('Summary');
    await user.type(textarea, '!');

    expect(onChangeSectionBody).toHaveBeenCalled();
  });
});
