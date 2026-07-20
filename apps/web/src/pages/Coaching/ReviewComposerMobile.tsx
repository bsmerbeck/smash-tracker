import { useState } from 'react';
import type { ReactNode, RefObject } from 'react';
import { useTranslation } from 'react-i18next';
import { Pause, Play } from 'lucide-react';
import type { CitationToken, Match, ReviewSection, ReviewSectionKind } from '@smash-tracker/shared';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Button } from '@/components/ui/button';
import { VodPlayer } from '@/pages/VodManager/components/VodPlayer';
import { ReviewSourcesDrawer } from './components/ReviewSourcesDrawer';
import { ReviewSectionEditor } from './components/ReviewSectionEditor';
import { ReviewPrivateNotesPane } from './components/ReviewPrivateNotesPane';
import { ReviewEvidenceList } from './components/ReviewEvidenceList';

type MobileTab = 'watch' | 'evidence' | 'review';
type DocTab = 'client-review' | 'private-notes';

export interface ReviewComposerMobileProps {
  vodSources: Match[];
  currentSourceId: string | null;
  currentSource: Match | null;
  onSelectSource: (matchId: string) => void;
  playerSeekRef: RefObject<((seconds: number) => void) | null>;
  playerPauseRef: RefObject<(() => void) | null>;
  getCurrentTimeRef: RefObject<(() => number) | null>;

  sections: ReviewSection[];
  onCite: (token: CitationToken) => void;

  coachPrivateNotes: string | null;
  onChangeSectionBody: (sectionId: string, body: string) => void;
  onChangePrivateNotes: (value: string) => void;
  onHideSection: (sectionId: string) => void;
  onShowSection: (sectionId: string) => void;
  onAddSection: (kind: ReviewSectionKind) => void;
  registerTextareaRef: (sectionId: string, el: HTMLTextAreaElement | null) => void;

  autosaveIndicator: ReactNode;
  onPreview: () => void;
  onPublish: () => void;
  isPublishing: boolean;
}

/**
 * D-12/D-16/D-17: the mobile composer — Watch / Evidence / Review tabs
 * (Private notes lives INSIDE Review as a segmented sub-control, never a
 * fourth top-level tab). ALL THREE top-level `TabsContent` panels render
 * with `forceMount` and rely on `tabs.tsx`'s existing
 * `data-[state=inactive]:hidden` class (plain CSS `display:none`, never
 * conditional JSX) so:
 *
 * 1. State preservation (D-12/Pitfall 6/T-12-27): the `<VodPlayer>` instance
 *    — mounted exactly ONCE, inside the Watch panel — and every section
 *    editor's `<textarea>` DOM node survive a Watch -> Evidence -> Review
 *    round trip. Playback position is never lost (the iframe is hidden, not
 *    destroyed) and unsaved draft text is safe regardless (it's already
 *    React state owned by the parent composer, not local DOM state) — but
 *    forceMount additionally protects native textarea state (cursor
 *    position, browser undo history) that a remount WOULD lose.
 * 2. Accessibility (D-17): `display:none` already removes an inactive
 *    panel's contents from both the keyboard tab order and the
 *    accessibility tree — no separate manual `aria-hidden`/`tabindex`
 *    bookkeeping needed on top of the CSS the shared `tabs.tsx` already
 *    ships.
 *
 * The player itself is rendered ONLY inside the Watch panel (never
 * duplicated into Evidence/Review) — those two panels instead show a
 * compact "mini-controller" strip (D-16: source title, current time, a
 * play/pause toggle, and `⏱ Cite current moment`) that drives the SAME
 * mounted player via the refs threaded down from `ReviewComposerPage`, so
 * the coach never has to switch back to Watch for basic playback control.
 *
 * All state/handlers are owned by the PARENT (`ReviewComposerPage`) and
 * passed down as props — this component is purely presentational, so
 * desktop and mobile share exactly ONE edit buffer (sections,
 * coachPrivateNotes, autosave) with no duplicate fetch/mutation wiring.
 */
export function ReviewComposerMobile({
  vodSources,
  currentSourceId,
  currentSource,
  onSelectSource,
  playerSeekRef,
  playerPauseRef,
  getCurrentTimeRef,
  sections,
  onCite,
  coachPrivateNotes,
  onChangeSectionBody,
  onChangePrivateNotes,
  onHideSection,
  onShowSection,
  onAddSection,
  registerTextareaRef,
  autosaveIndicator,
  onPreview,
  onPublish,
  isPublishing,
}: ReviewComposerMobileProps) {
  const { t } = useTranslation();
  const [mobileTab, setMobileTab] = useState<MobileTab>('watch');
  const [docTab, setDocTab] = useState<DocTab>('client-review');

  const sourceLabel = currentSource
    ? t('coaching.reviews.composer.sourcesDrawer.vsOpponent', {
        opponent: currentSource.opponent || t('common.unknown'),
      })
    : t('coaching.reviews.composer.sourceBar.none');

  return (
    <div className="flex flex-col gap-3 p-3">
      <div className="flex items-center gap-2">
        {autosaveIndicator}
        <div className="ml-auto flex items-center gap-2">
          <Button type="button" variant="outline" size="sm" onClick={onPreview}>
            {t('coaching.reviews.composer.preview.title')}
          </Button>
          <Button
            type="button"
            variant="default"
            size="sm"
            onClick={onPublish}
            disabled={isPublishing}
          >
            {t('coaching.reviews.composer.publish')}
          </Button>
        </div>
      </div>

      <Tabs value={mobileTab} onValueChange={(value) => setMobileTab(value as MobileTab)}>
        <TabsList className="grid w-full grid-cols-3">
          <TabsTrigger value="watch">
            {t('coaching.reviews.composer.mobile.tabs.watch')}
          </TabsTrigger>
          <TabsTrigger value="evidence">
            {t('coaching.reviews.composer.mobile.tabs.evidence')}
          </TabsTrigger>
          <TabsTrigger value="review">
            {t('coaching.reviews.composer.mobile.tabs.review')}
          </TabsTrigger>
        </TabsList>

        <TabsContent value="watch" forceMount className="flex flex-col gap-3">
          <div className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
            <span>
              {t('coaching.reviews.composer.sourceBar.label')}{' '}
              <span className="font-medium text-foreground">{sourceLabel}</span>
            </span>
            <ReviewSourcesDrawer
              sources={vodSources}
              currentSourceId={currentSourceId}
              onSelect={onSelectSource}
            />
          </div>
          {currentSource?.vodUrl ? (
            <VodPlayer
              vodUrl={currentSource.vodUrl}
              startSeconds={currentSource.vodStartSeconds}
              seekRef={playerSeekRef}
              pauseRef={playerPauseRef}
              getCurrentTimeRef={getCurrentTimeRef}
            />
          ) : (
            <div className="flex aspect-video items-center justify-center rounded-lg border bg-muted text-sm text-muted-foreground">
              {t('coaching.reviews.composer.sourceBar.noPlayer')}
            </div>
          )}
        </TabsContent>

        <TabsContent value="evidence" forceMount className="flex flex-col gap-3">
          {/* No `onCite`/cite action here — `ReviewEvidenceList` below
              already renders its OWN toolbar `⏱ Cite current moment`
              button on this tab (D-04); duplicating it in the mini-
              controller here would be a redundant second control for the
              exact same action. */}
          <MiniController
            sourceLabel={sourceLabel}
            playerSeekRef={playerSeekRef}
            playerPauseRef={playerPauseRef}
          />
          <ReviewEvidenceList
            timestamps={currentSource?.vodTimestamps ?? []}
            sourceMatchId={currentSourceId}
            sections={sections}
            getCurrentTimeRef={getCurrentTimeRef}
            onCite={onCite}
          />
        </TabsContent>

        <TabsContent value="review" forceMount className="flex flex-col gap-3">
          <MiniController
            sourceLabel={sourceLabel}
            playerSeekRef={playerSeekRef}
            playerPauseRef={playerPauseRef}
            getCurrentTimeRef={getCurrentTimeRef}
            sourceMatchId={currentSourceId}
            onCite={onCite}
          />

          {/* D-12: Private notes lives INSIDE Review as a segmented sub-control
              — never a fourth top-level mobile tab. */}
          <Tabs value={docTab} onValueChange={(value) => setDocTab(value as DocTab)}>
            <TabsList className="grid w-full grid-cols-2">
              <TabsTrigger value="client-review">
                {t('coaching.reviews.composer.tabs.clientReview')}
              </TabsTrigger>
              <TabsTrigger
                value="private-notes"
                className="data-[state=active]:border-amber-500 data-[state=active]:text-amber-600 dark:data-[state=active]:text-amber-400"
              >
                {t('coaching.reviews.composer.tabs.privateNotes')}
              </TabsTrigger>
            </TabsList>

            <TabsContent value="client-review" forceMount className="pt-3">
              <ReviewSectionEditor
                sections={sections}
                onChangeBody={onChangeSectionBody}
                onHide={onHideSection}
                onShow={onShowSection}
                onAdd={onAddSection}
                registerTextareaRef={registerTextareaRef}
              />
            </TabsContent>

            <TabsContent value="private-notes" forceMount className="pt-3">
              <ReviewPrivateNotesPane value={coachPrivateNotes} onChange={onChangePrivateNotes} />
            </TabsContent>
          </Tabs>
        </TabsContent>
      </Tabs>
    </div>
  );
}

/**
 * D-16: the persistent mini-controller strip shown on Evidence/Review —
 * source title, a play/pause toggle, and `⏱ Cite current moment`. The
 * play/pause toggle is LOCAL, optimistic UI state (never polled — matches
 * `useVodPlayer.ts`'s own "on-demand read, never polled on an interval"
 * discipline for `getCurrentTime`): `useVodPlayer`/`VodPlayer` expose no
 * live "is this player currently playing" signal or a generic `play()`
 * call to build a fully server-of-truth toggle from, only `pause()` and
 * `seek()` (which resumes playback as a side effect) — extending that
 * shared, heavily-tested hook is out of this plan's scope. A manual
 * play/pause via the embedded platform's OWN chrome (rare — this is a
 * compact secondary control, not a replacement for the real player) can
 * drift this toggle's label out of sync; documented as a known limitation.
 */
function MiniController({
  sourceLabel,
  playerSeekRef,
  playerPauseRef,
  getCurrentTimeRef,
  sourceMatchId,
  onCite,
}: {
  sourceLabel: string;
  playerSeekRef: RefObject<((seconds: number) => void) | null>;
  playerPauseRef: RefObject<(() => void) | null>;
  /** Omit entirely on the Evidence tab — `ReviewEvidenceList` already renders its own toolbar `⏱ Cite current moment` action there (never duplicate the same control twice). */
  getCurrentTimeRef?: RefObject<(() => number) | null>;
  sourceMatchId?: string | null;
  onCite?: (token: CitationToken) => void;
}) {
  const { t } = useTranslation();
  const [isPlaying, setIsPlaying] = useState(false);

  function handleTogglePlayback() {
    if (isPlaying) {
      playerPauseRef.current?.();
      setIsPlaying(false);
    } else {
      const current = getCurrentTimeRef?.current?.() ?? 0;
      playerSeekRef.current?.(current);
      setIsPlaying(true);
    }
  }

  function handleCiteCurrentMoment() {
    if (!sourceMatchId || !onCite) return;
    const seconds = getCurrentTimeRef?.current?.() ?? 0;
    onCite({ sourceVodRef: sourceMatchId, seconds, label: '' });
  }

  return (
    <div className="flex items-center gap-2 rounded-md border bg-muted/40 px-2.5 py-1.5 text-xs">
      <span className="min-w-0 flex-1 truncate font-medium">{sourceLabel}</span>
      <Button
        type="button"
        variant="ghost"
        size="icon-sm"
        aria-label={t('coaching.reviews.composer.mobile.miniController.playPauseAria')}
        onClick={handleTogglePlayback}
      >
        {isPlaying ? <Pause className="size-3.5" /> : <Play className="size-3.5" />}
      </Button>
      {onCite && (
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="h-7 px-2"
          disabled={!sourceMatchId}
          onMouseDown={(event) => event.preventDefault()}
          onClick={handleCiteCurrentMoment}
        >
          {t('coaching.reviews.composer.evidence.citeCurrentMoment')}
        </Button>
      )}
    </div>
  );
}
