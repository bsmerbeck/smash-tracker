import { useEffect, useMemo, useRef, useState } from 'react';
import { useParams, useSearchParams } from 'react-router';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import type {
  CitationToken,
  ReviewDraft,
  ReviewSection,
  ReviewSectionKind,
} from '@smash-tracker/shared';
import { serializeCitationToken } from '@smash-tracker/shared';
import { useMatches } from '@/hooks/useMatches';
import {
  useAddReviewSection,
  useCoachingReviewDraft,
  useCoachingReviewPreview,
  useHideReviewSection,
  usePublishCoachingReview,
  useShowReviewSection,
} from '@/hooks/useCoachingReviews';
import { useReviewAutosave } from '@/hooks/useReviewAutosave';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { SafeMarkdown } from '@/lib/safeMarkdown';
import { VodPlayer } from '@/pages/VodManager/components/VodPlayer';
import { ReviewSourcesDrawer } from './components/ReviewSourcesDrawer';
import { ReviewSectionEditor } from './components/ReviewSectionEditor';
import { ReviewPrivateNotesPane } from './components/ReviewPrivateNotesPane';
import { ReviewEvidenceList } from './components/ReviewEvidenceList';
import { CiteSectionPrompt } from './components/CiteSectionPrompt';
import { AutosaveConflictDialog } from './components/AutosaveConflictDialog';
import { describeCoachingError } from './describeCoachingError';
import { ReviewComposerMobile } from './ReviewComposerMobile';

type DocTab = 'client-review' | 'private-notes';

/** Tailwind's `lg` breakpoint (1024px) — matches the desktop grid's own 480px-column `lg` switch, so the mobile/desktop composer split lines up with the same width the CSS grid itself would otherwise silently reflow at. */
const MOBILE_COMPOSER_QUERY = '(max-width: 1023px)';

/**
 * D-12: a plain `matchMedia`-backed breakpoint check — the SAME approach
 * `useVodPlayer.ts` uses for feature detection (guard-before-use, default
 * to the safe/existing behavior when the API is unavailable). Defaults to
 * `false` (desktop) when `window.matchMedia` doesn't exist at all — jsdom
 * (this repo's test environment) has no `matchMedia` implementation, so
 * every EXISTING desktop-focused test in `ReviewComposerPage.test.tsx`
 * keeps rendering the desktop grid unchanged; `ReviewComposerMobile.test.tsx`
 * tests the mobile component directly instead of forcing this hook's
 * branch (see that file's own doc comment).
 */
function useIsMobileComposer(): boolean {
  const [isMobile, setIsMobile] = useState(() =>
    typeof window !== 'undefined' && typeof window.matchMedia === 'function'
      ? window.matchMedia(MOBILE_COMPOSER_QUERY).matches
      : false,
  );
  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
      return;
    }
    const mql = window.matchMedia(MOBILE_COMPOSER_QUERY);
    const handler = () => setIsMobile(mql.matches);
    handler();
    mql.addEventListener('change', handler);
    return () => mql.removeEventListener('change', handler);
  }, []);
  return isMobile;
}

/**
 * The composer shell (D-01): a dedicated two-pane `/coach/:clientId/reviews/
 * :reviewId` page. LEFT pane (always visible, regardless of which document
 * tab is active — D-02): the current source's title + `Sources ▾` drawer,
 * the embedded player, and an Evidence placeholder (plan 12-07 replaces it
 * with the real, citable `ReviewEvidenceList`). RIGHT pane: `Client review |
 * 🔒 Private notes` tabs — selecting Private notes replaces the client
 * document with a full-width amber editor (D-02/D-15) while the left pane
 * stays mounted and usable. Edits feed a debounced, revision-checked
 * autosave (`useReviewAutosave`, REV-02); a stale write opens
 * `AutosaveConflictDialog` for explicit mine/theirs resolution rather than
 * silently overwriting newer text (T-12-18).
 */
export function ReviewComposerPage() {
  const { t } = useTranslation();
  const { clientId = '', reviewId = '' } = useParams<{ clientId: string; reviewId: string }>();
  // D-01: VOD Manager's "Start review / Continue review" preloads a source
  // via `?source={matchId}` — read once at seed time below, never re-read
  // after (switching sources afterward is the Sources drawer's job).
  const [searchParams] = useSearchParams();
  const requestedSourceId = searchParams.get('source');

  const draftQuery = useCoachingReviewDraft(clientId, reviewId);
  const { data: matchesData } = useMatches();
  const vodSources = useMemo(
    () => (matchesData ?? []).filter((match) => match.vodUrl != null),
    [matchesData],
  );

  const [sections, setSections] = useState<ReviewSection[]>([]);
  const [coachPrivateNotes, setCoachPrivateNotes] = useState<string | null>(null);
  const [docTab, setDocTab] = useState<DocTab>('client-review');
  const [currentSourceId, setCurrentSourceId] = useState<string | null>(null);
  const hasInitializedRef = useRef(false);
  // D-04: keyed by section id, populated by `ReviewSectionEditor`'s
  // `registerTextareaRef` — read against `document.activeElement` to
  // decide "insert at cursor" vs. "ask which section" on every Cite action.
  const sectionTextareaRefs = useRef(new Map<string, HTMLTextAreaElement>());
  // A citation awaiting a section pick (CiteSectionPrompt open) — `null`
  // means the prompt is closed. Set only when NO section textarea has
  // focus at the moment a Cite action fires (D-04: never silently choose).
  const [pendingCitation, setPendingCitation] = useState<CitationToken | null>(null);
  const [previewOpen, setPreviewOpen] = useState(false);
  const playerSeekRef = useRef<((seconds: number) => void) | null>(null);
  const playerPauseRef = useRef<(() => void) | null>(null);
  const getCurrentTimeRef = useRef<(() => number) | null>(null);
  // D-12: renders the mobile Watch/Evidence/Review composer at narrow
  // widths instead of the two-pane desktop grid below — see
  // `useIsMobileComposer`'s doc comment.
  const isMobileComposer = useIsMobileComposer();

  // Seed local edit-buffer state from the fetched draft exactly ONCE — a
  // background refetch of `draftQuery.data` (e.g. window refocus) must never
  // clobber in-progress local edits. Section hide/show/add mutations update
  // this state explicitly via their own `onSuccess` below instead.
  useEffect(() => {
    if (draftQuery.data && !hasInitializedRef.current) {
      hasInitializedRef.current = true;
      setSections(draftQuery.data.sections);
      setCoachPrivateNotes(draftQuery.data.coachPrivateNotes ?? null);
    }
  }, [draftQuery.data]);

  // D-01: "Start review / Continue review" preloads a source; absent that
  // wiring (VOD Manager's own entry point — a later plan), default to the
  // client's most recent VOD so the player never sits empty. React's
  // "adjusting state when a prop changes" render-time pattern (mirrors
  // useVodPlayer.ts) rather than an effect — this only ever fires the
  // setState once per empty->populated transition, since the next render
  // sees a non-null currentSourceId and the condition goes false.
  if (currentSourceId == null && vodSources.length > 0) {
    const preferred =
      requestedSourceId && vodSources.some((match) => match.id === requestedSourceId)
        ? requestedSourceId
        : vodSources[0]!.id;
    setCurrentSourceId(preferred);
  }

  const autosave = useReviewAutosave(
    clientId,
    reviewId,
    { sections, coachPrivateNotes },
    draftQuery.data?.revision ?? 0,
  );

  const hideSection = useHideReviewSection(clientId, reviewId);
  const showSection = useShowReviewSection(clientId, reviewId);
  const addSection = useAddReviewSection(clientId, reviewId);
  const publish = usePublishCoachingReview(clientId, reviewId);
  const preview = useCoachingReviewPreview(clientId, reviewId, { enabled: previewOpen });

  const currentSource = vodSources.find((match) => match.id === currentSourceId) ?? null;
  const visibleSections = sections.filter((section) => !section.hidden);

  function applySectionMutationResult(draft: ReviewDraft) {
    setSections(draft.sections);
  }

  function handleSeeTheirs() {
    const serverDraft = autosave.resolveWithServerDraft();
    if (serverDraft) {
      setSections(serverDraft.sections);
      setCoachPrivateNotes(serverDraft.coachPrivateNotes ?? null);
    }
  }

  function handlePublish() {
    publish.mutate(undefined, {
      onSuccess: (result) => {
        toast.success(t('coaching.reviews.composer.publishSuccess', { version: result.version }));
      },
      onError: (error) => {
        toast.error(describeCoachingError(error, t('coaching.reviews.composer.publishError')));
      },
    });
  }

  function registerSectionTextareaRef(sectionId: string, el: HTMLTextAreaElement | null) {
    if (el) {
      sectionTextareaRefs.current.set(sectionId, el);
    } else {
      sectionTextareaRefs.current.delete(sectionId);
    }
  }

  /** The section id whose `<textarea>` currently has focus, or `null` if none does (D-04). */
  function findFocusedSectionId(): string | null {
    const active = document.activeElement;
    for (const [sectionId, el] of sectionTextareaRefs.current) {
      if (el === active) {
        return sectionId;
      }
    }
    return null;
  }

  /** Splices `token`'s serialized form into `sectionId`'s body at `cursorPosition` (or the end, when `null`), padding with a space only where the surrounding text needs one. */
  function insertCitationIntoSection(
    sectionId: string,
    token: CitationToken,
    cursorPosition: number | null,
  ) {
    const tokenText = serializeCitationToken(token);
    setSections((prev) =>
      prev.map((section) => {
        if (section.id !== sectionId) {
          return section;
        }
        const body = section.body;
        const pos = cursorPosition ?? body.length;
        const before = body.slice(0, pos);
        const after = body.slice(pos);
        const leadingSpace = before.length > 0 && !/\s$/.test(before) ? ' ' : '';
        const trailingSpace = after.length > 0 && !/^\s/.test(after) ? ' ' : '';
        return { ...section, body: `${before}${leadingSpace}${tokenText}${trailingSpace}${after}` };
      }),
    );
  }

  // D-04: the Evidence list's Cite / ⏱ Cite current moment actions both
  // route through here. A focused section textarea wins (insert at its
  // cursor); otherwise the coach is ASKED which section — never a silent
  // choice.
  function handleCite(token: CitationToken) {
    const focusedSectionId = findFocusedSectionId();
    if (focusedSectionId) {
      const el = sectionTextareaRefs.current.get(focusedSectionId);
      insertCitationIntoSection(focusedSectionId, token, el?.selectionStart ?? null);
      return;
    }
    if (docTab !== 'client-review') {
      setDocTab('client-review');
    }
    setPendingCitation(token);
  }

  function handleCiteSectionPicked(sectionId: string) {
    if (!pendingCitation) return;
    insertCitationIntoSection(sectionId, pendingCitation, null);
    setPendingCitation(null);
  }

  // Preview-as-client (REV-05): clicking a citation there either seeks the
  // already-mounted player (same source) or switches the composer's active
  // source (cross-source) — the full "switch AND seek to the exact second"
  // experience belongs to the plan-08 delivery page, which owns its own
  // player lifecycle end to end.
  function handlePreviewCitationActivate(matchId: string, seconds: number) {
    if (matchId === currentSourceId) {
      playerSeekRef.current?.(seconds);
    } else {
      setCurrentSourceId(matchId);
    }
  }

  function resolvePreviewCitationSource(matchId: string) {
    if (matchId === currentSourceId) {
      return undefined;
    }
    const match = vodSources.find((source) => source.id === matchId);
    if (!match) {
      return undefined;
    }
    return {
      label: t('coaching.reviews.composer.sourcesDrawer.vsOpponent', {
        opponent: match.opponent || t('common.unknown'),
      }),
    };
  }

  if (draftQuery.isLoading) {
    return (
      <div className="flex min-h-[50vh] items-center justify-center text-sm text-muted-foreground">
        {t('chrome.loading')}
      </div>
    );
  }

  if (draftQuery.isError) {
    return (
      <div className="flex min-h-[50vh] items-center justify-center text-sm text-muted-foreground">
        {t('coaching.reviews.composer.loadError')}
      </div>
    );
  }

  function handleChangeSectionBody(sectionId: string, body: string) {
    setSections((prev) =>
      prev.map((section) => (section.id === sectionId ? { ...section, body } : section)),
    );
  }
  function handleHideSection(sectionId: string) {
    hideSection.mutate(sectionId, { onSuccess: applySectionMutationResult });
  }
  function handleShowSection(sectionId: string) {
    showSection.mutate(sectionId, { onSuccess: applySectionMutationResult });
  }
  function handleAddSection(kind: ReviewSectionKind) {
    addSection.mutate({ kind }, { onSuccess: applySectionMutationResult });
  }

  return (
    <>
      {isMobileComposer ? (
        // D-12: the mobile Watch/Evidence/Review composer — a PRESENTATIONAL
        // sibling of the desktop grid below, sharing this component's SAME
        // state/handlers (one edit buffer, one autosave instance).
        <ReviewComposerMobile
          vodSources={vodSources}
          currentSourceId={currentSourceId}
          currentSource={currentSource}
          onSelectSource={setCurrentSourceId}
          playerSeekRef={playerSeekRef}
          playerPauseRef={playerPauseRef}
          getCurrentTimeRef={getCurrentTimeRef}
          sections={sections}
          onCite={handleCite}
          coachPrivateNotes={coachPrivateNotes}
          onChangeSectionBody={handleChangeSectionBody}
          onChangePrivateNotes={setCoachPrivateNotes}
          onHideSection={handleHideSection}
          onShowSection={handleShowSection}
          onAddSection={handleAddSection}
          registerTextareaRef={registerSectionTextareaRef}
          autosaveIndicator={<AutosaveStatusIndicator status={autosave.status} />}
          onPreview={() => setPreviewOpen(true)}
          onPublish={handlePublish}
          isPublishing={publish.isPending}
        />
      ) : (
        <div className="grid min-h-[calc(100vh-8rem)] grid-cols-1 lg:grid-cols-[480px_1fr]">
          {/* Left pane (D-01): source bar + player + Evidence placeholder — always visible regardless of the right pane's active tab. */}
          <div className="flex flex-col gap-3 border-b p-4 lg:border-r lg:border-b-0">
            <div className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
              <span>
                {t('coaching.reviews.composer.sourceBar.label')}{' '}
                <span className="font-medium text-foreground">
                  {currentSource
                    ? t('coaching.reviews.composer.sourcesDrawer.vsOpponent', {
                        opponent: currentSource.opponent || t('common.unknown'),
                      })
                    : t('coaching.reviews.composer.sourceBar.none')}
                </span>
              </span>
              <ReviewSourcesDrawer
                sources={vodSources}
                currentSourceId={currentSourceId}
                onSelect={setCurrentSourceId}
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

            <ReviewEvidenceList
              timestamps={currentSource?.vodTimestamps ?? []}
              sourceMatchId={currentSource?.id ?? null}
              sections={sections}
              getCurrentTimeRef={getCurrentTimeRef}
              onCite={handleCite}
            />
          </div>

          {/* Right pane (D-02): Client review | Private notes tabs. */}
          <div className="flex flex-col p-4">
            <Tabs value={docTab} onValueChange={(value) => setDocTab(value as DocTab)}>
              <div className="flex flex-wrap items-center gap-3 border-b pb-0">
                <TabsList>
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
                <div className="ml-auto flex items-center gap-3 pb-2">
                  <AutosaveStatusIndicator status={autosave.status} />
                  <Button variant="outline" size="sm" onClick={() => setPreviewOpen(true)}>
                    {t('coaching.reviews.composer.preview.title')}
                  </Button>
                  <Button
                    variant="default"
                    size="sm"
                    onClick={handlePublish}
                    disabled={publish.isPending}
                  >
                    {t('coaching.reviews.composer.publish')}
                  </Button>
                </div>
              </div>

              <TabsContent value="client-review" className="pt-4">
                <ReviewSectionEditor
                  sections={sections}
                  onChangeBody={handleChangeSectionBody}
                  onHide={handleHideSection}
                  onShow={handleShowSection}
                  onAdd={handleAddSection}
                  registerTextareaRef={registerSectionTextareaRef}
                />
              </TabsContent>

              <TabsContent value="private-notes" className="pt-4">
                <ReviewPrivateNotesPane value={coachPrivateNotes} onChange={setCoachPrivateNotes} />
              </TabsContent>
            </Tabs>
          </div>
        </div>
      )}

      <AutosaveConflictDialog
        open={autosave.status === 'conflict'}
        mine={{ sections, coachPrivateNotes }}
        serverDraft={autosave.conflictServerDraft}
        onKeepMine={autosave.resolveKeepMine}
        onSeeTheirs={handleSeeTheirs}
      />

      <CiteSectionPrompt
        open={pendingCitation != null}
        sections={visibleSections}
        onPick={handleCiteSectionPicked}
        onOpenChange={(open) => {
          if (!open) setPendingCitation(null);
        }}
      />

      <Dialog open={previewOpen} onOpenChange={setPreviewOpen}>
        <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>{t('coaching.reviews.composer.preview.title')}</DialogTitle>
            <DialogDescription>
              {t('coaching.reviews.composer.preview.description')}
            </DialogDescription>
          </DialogHeader>
          {preview.isLoading ? (
            <p className="text-sm text-muted-foreground">{t('chrome.loading')}</p>
          ) : preview.isError ? (
            <p className="text-sm text-muted-foreground">
              {t('coaching.reviews.composer.preview.error')}
            </p>
          ) : preview.data && preview.data.sections.length > 0 ? (
            <div className="flex flex-col gap-4">
              {preview.data.sections.map((section) => (
                <div key={section.id}>
                  <h3 className="mb-1 text-sm font-semibold">
                    {section.kind === 'general'
                      ? section.title?.trim() ||
                        t('coaching.reviews.composer.sections.kinds.general')
                      : t(`coaching.reviews.composer.sections.kinds.${section.kind}`)}
                  </h3>
                  <SafeMarkdown
                    body={section.body}
                    onActivateCitation={handlePreviewCitationActivate}
                    resolveCitationSource={resolvePreviewCitationSource}
                  />
                </div>
              ))}
            </div>
          ) : (
            <p className="text-sm text-muted-foreground">
              {t('coaching.reviews.composer.preview.empty')}
            </p>
          )}
        </DialogContent>
      </Dialog>
    </>
  );
}

function AutosaveStatusIndicator({ status }: { status: string }) {
  const { t } = useTranslation();
  if (status === 'saving') {
    return (
      <span className="text-xs text-muted-foreground">
        {t('coaching.reviews.composer.autosave.saving')}
      </span>
    );
  }
  if (status === 'saved') {
    return (
      <span className="text-xs text-green-600 dark:text-green-400">
        {t('coaching.reviews.composer.autosave.saved')}
      </span>
    );
  }
  if (status === 'error') {
    return (
      <span className="text-xs text-destructive">
        {t('coaching.reviews.composer.autosave.error')}
      </span>
    );
  }
  return null;
}
