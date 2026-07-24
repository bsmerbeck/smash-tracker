import { useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { IncludedVod } from '@smash-tracker/shared';
import { VodPlayer } from '@/pages/VodManager/components/VodPlayer';
import { ShareTimestampRow } from '@/pages/Share/components/ShareTimestampRow';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';

export interface DeliveryVodNotesTabProps {
  /** The frozen VODs to render — either `snapshot.includedVods` directly, or
   * the back-compat `citationSources`-derived fallback `ReviewDeliveryPage`
   * builds for a pre-Phase-21 delivery (T-21-06). */
  vods: IncludedVod[];
}

/**
 * Phase 21 Plan 02 (DLVX-01/02/03): the "VOD Notes" tab body — a player plus
 * that VOD's timestamped notes with click-to-seek, and (when 2+ VODs are
 * included) a switcher between them. Mirrors `ReviewDeliveryPage`'s own
 * citation-source switch shape EXACTLY (`currentMatchId` seeded during
 * render, a generic activate handler that seeks in place for the current VOD
 * or re-keys `VodPlayer` by `vodUrl` for a different one) so the two
 * click-to-seek code paths on this page stay structurally identical.
 *
 * Deliberately reuses ONLY `VodPlayer` + `ShareTimestampRow` — never
 * `ShareViewPage`'s coach-edit machinery (`NoteComposer`,
 * `editingIndex`/`onUpdateTimestamps`, etc.), which has no place on this
 * read-only anonymous recipient page (RESEARCH.md Anti-Pattern).
 */
export function DeliveryVodNotesTab({ vods }: DeliveryVodNotesTabProps) {
  const { t } = useTranslation();

  const [currentMatchId, setCurrentMatchId] = useState<string | null>(null);
  const [startSecondsOverride, setStartSecondsOverride] = useState<number | undefined>(undefined);
  const [selectedSeconds, setSelectedSeconds] = useState<number | null>(null);
  const [isPlayerReady, setIsPlayerReady] = useState(false);
  const seekRef = useRef<((seconds: number) => void) | null>(null);

  // Seed the current VOD to the first entry the moment `vods` resolves —
  // same render-time-adjustment pattern as `ReviewDeliveryPage`'s
  // `currentSourceRef` seeding (never re-picked afterward except by an
  // explicit switcher/timestamp interaction below).
  if (currentMatchId == null && vods.length > 0) {
    setCurrentMatchId(vods[0]!.matchId);
  }

  if (vods.length === 0) {
    return <p className="text-sm text-muted-foreground">{t('reviewDelivery.vodNotes.empty')}</p>;
  }

  const currentIndex = vods.findIndex((vod) => vod.matchId === currentMatchId);
  const currentVod = currentIndex === -1 ? vods[0]! : vods[currentIndex]!;
  const resolvedIndex = currentIndex === -1 ? 0 : currentIndex;
  const timestamps = currentVod.timestamps ?? [];

  function vodDisplayLabel(vod: IncludedVod, index: number): string {
    return vod.label?.trim() || t('reviewDelivery.sourceFallback', { index: index + 1 });
  }

  // Generic activate handler mirroring `ReviewDeliveryPage.handleActivateCitation`:
  // a click for the CURRENT VOD seeks the already-mounted player in place; a
  // click referencing a DIFFERENT included VOD switches to it (re-keying
  // `VodPlayer` by `vodUrl`) and starts playback at the cited second.
  function handleActivate(matchId: string, seconds: number) {
    setSelectedSeconds(seconds);
    if (matchId === currentVod.matchId) {
      seekRef.current?.(seconds);
      return;
    }
    const target = vods.find((vod) => vod.matchId === matchId);
    if (!target) {
      return;
    }
    setStartSecondsOverride(seconds);
    setIsPlayerReady(false);
    setCurrentMatchId(matchId);
  }

  function handleSwitcherChange(matchId: string) {
    if (matchId === currentVod.matchId) {
      return;
    }
    setStartSecondsOverride(undefined);
    setSelectedSeconds(null);
    setIsPlayerReady(false);
    setCurrentMatchId(matchId);
  }

  return (
    <div className="flex flex-col gap-4">
      {vods.length > 1 && (
        <Select value={currentVod.matchId} onValueChange={handleSwitcherChange}>
          <SelectTrigger
            aria-label={t('reviewDelivery.vodNotes.switcherAria')}
            className="w-full sm:w-[240px]"
          >
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {vods.map((vod, index) => (
              <SelectItem key={vod.matchId} value={vod.matchId}>
                {vodDisplayLabel(vod, index)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      )}

      <div className="flex flex-col gap-1.5">
        <p className="text-[10.5px] font-medium tracking-wide text-muted-foreground uppercase">
          {t('reviewDelivery.nowPlaying')}
        </p>
        <p className="text-sm font-medium">{vodDisplayLabel(currentVod, resolvedIndex)}</p>
        <VodPlayer
          vodUrl={currentVod.vodUrl}
          startSeconds={startSecondsOverride ?? currentVod.startSeconds ?? undefined}
          seekRef={seekRef}
          onReady={() => setIsPlayerReady(true)}
        />
      </div>

      <div className="flex flex-col gap-2">
        <h3 className="text-sm font-semibold">{t('reviewDelivery.vodNotes.notesHeading')}</h3>
        {timestamps.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t('reviewDelivery.vodNotes.notesEmpty')}</p>
        ) : (
          <div className="flex flex-col gap-2">
            {timestamps.map((stamp, index) => (
              <ShareTimestampRow
                key={`${currentVod.matchId}-${stamp.seconds}-${index}`}
                stamp={stamp}
                isSelected={selectedSeconds === stamp.seconds}
                onSelect={(seconds) => handleActivate(currentVod.matchId, seconds)}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
