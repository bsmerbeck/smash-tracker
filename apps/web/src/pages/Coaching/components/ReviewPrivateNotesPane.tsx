import { useTranslation } from 'react-i18next';
import { Lock } from 'lucide-react';
import { Textarea } from '@/components/ui/textarea';

export interface ReviewPrivateNotesPaneProps {
  value: string | null;
  onChange: (value: string) => void;
}

/**
 * The `🔒 Private notes` document-pane tab (D-02, D-15): a FULL-WIDTH amber
 * editor that replaces the client document entirely while this tab is
 * active — the left footage/evidence pane stays mounted and usable, but
 * this pane owns the whole right side. Private notes are REVIEW-scoped
 * (D-15) — "for this review, not the current source VOD" — and structurally
 * never render in any client/preview/delivery surface (REV-03): this
 * component is the ONLY place `coachPrivateNotes` is ever read or written on
 * the web side.
 */
export function ReviewPrivateNotesPane({ value, onChange }: ReviewPrivateNotesPaneProps) {
  const { t } = useTranslation();

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center gap-2 rounded-md border border-amber-300 bg-amber-50 px-3.5 py-2.5 text-sm font-semibold text-amber-900 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-200">
        <Lock className="size-4 shrink-0" />
        <span>{t('coaching.reviews.composer.privateNotes.banner')}</span>
      </div>
      <Textarea
        value={value ?? ''}
        onChange={(event) => onChange(event.target.value)}
        aria-label={t('coaching.reviews.composer.privateNotes.textareaAria')}
        placeholder={t('coaching.reviews.composer.privateNotes.placeholder')}
        className="min-h-64 border-amber-300 bg-amber-50/60 dark:border-amber-800 dark:bg-amber-950/40"
      />
      <p className="text-xs text-muted-foreground">
        {t('coaching.reviews.composer.privateNotes.scopeHint')}
      </p>
    </div>
  );
}
