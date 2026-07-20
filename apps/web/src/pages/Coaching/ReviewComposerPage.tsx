import { useEffect, useMemo, useRef, useState } from 'react';
import { useParams } from 'react-router';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import type { ReviewDraft, ReviewSection } from '@smash-tracker/shared';
import { formatTimestamp } from '@/lib/vod';
import { useMatches } from '@/hooks/useMatches';
import {
  useAddReviewSection,
  useCoachingReviewDraft,
  useHideReviewSection,
  usePublishCoachingReview,
  useShowReviewSection,
} from '@/hooks/useCoachingReviews';
import { useReviewAutosave } from '@/hooks/useReviewAutosave';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Button } from '@/components/ui/button';
import { VodPlayer } from '@/pages/VodManager/components/VodPlayer';
import { ReviewSourcesDrawer } from './components/ReviewSourcesDrawer';
import { ReviewSectionEditor } from './components/ReviewSectionEditor';
import { ReviewPrivateNotesPane } from './components/ReviewPrivateNotesPane';
import { AutosaveConflictDialog } from './components/AutosaveConflictDialog';
import { describeCoachingError } from './describeCoachingError';

type DocTab = 'client-review' | 'private-notes';

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
    setCurrentSourceId(vodSources[0]!.id);
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

  const currentSource = vodSources.find((match) => match.id === currentSourceId) ?? null;

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

  return (
    <div className="grid min-h-[calc(100vh-8rem)] grid-cols-1 lg:grid-cols-[400px_1fr]">
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
          <VodPlayer vodUrl={currentSource.vodUrl} startSeconds={currentSource.vodStartSeconds} />
        ) : (
          <div className="flex aspect-video items-center justify-center rounded-lg border bg-muted text-sm text-muted-foreground">
            {t('coaching.reviews.composer.sourceBar.noPlayer')}
          </div>
        )}

        <div>
          <h2 className="mb-2 text-sm font-semibold">
            {t('coaching.reviews.composer.evidence.heading', {
              count: currentSource?.vodTimestamps?.length ?? 0,
            })}
          </h2>
          {/* Placeholder — plan 12-07 replaces this with the real, citable ReviewEvidenceList (Cite / Cite current moment). */}
          {currentSource?.vodTimestamps && currentSource.vodTimestamps.length > 0 ? (
            <ul className="flex flex-col gap-1.5">
              {currentSource.vodTimestamps.map((entry) => (
                <li
                  key={entry.id}
                  className="rounded-md border bg-card px-2.5 py-1.5 text-xs text-muted-foreground"
                >
                  <span className="font-mono text-foreground">
                    {formatTimestamp(entry.seconds)}
                  </span>{' '}
                  {entry.note}
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-xs text-muted-foreground">
              {t('coaching.reviews.composer.evidence.empty')}
            </p>
          )}
        </div>
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
              onChangeBody={(sectionId, body) =>
                setSections((prev) =>
                  prev.map((section) =>
                    section.id === sectionId ? { ...section, body } : section,
                  ),
                )
              }
              onHide={(sectionId) =>
                hideSection.mutate(sectionId, { onSuccess: applySectionMutationResult })
              }
              onShow={(sectionId) =>
                showSection.mutate(sectionId, { onSuccess: applySectionMutationResult })
              }
              onAdd={(kind) =>
                addSection.mutate({ kind }, { onSuccess: applySectionMutationResult })
              }
            />
          </TabsContent>

          <TabsContent value="private-notes" className="pt-4">
            <ReviewPrivateNotesPane value={coachPrivateNotes} onChange={setCoachPrivateNotes} />
          </TabsContent>
        </Tabs>
      </div>

      <AutosaveConflictDialog
        open={autosave.status === 'conflict'}
        mine={{ sections, coachPrivateNotes }}
        serverDraft={autosave.conflictServerDraft}
        onKeepMine={autosave.resolveKeepMine}
        onSeeTheirs={handleSeeTheirs}
      />
    </div>
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
