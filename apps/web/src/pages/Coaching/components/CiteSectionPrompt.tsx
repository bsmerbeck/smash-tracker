import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import type { ReviewSection } from '@smash-tracker/shared';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';

function sectionLabel(t: TFunction, section: ReviewSection): string {
  if (section.kind === 'general') {
    return section.title?.trim() || t('coaching.reviews.composer.sections.kinds.general');
  }
  return t(`coaching.reviews.composer.sections.kinds.${section.kind}`);
}

export interface CiteSectionPromptProps {
  open: boolean;
  /** The review's currently-VISIBLE sections (hidden sections are never offered — a coach can't see the result). */
  sections: ReviewSection[];
  onPick: (sectionId: string) => void;
  onOpenChange: (open: boolean) => void;
}

/**
 * D-04: "if nothing has focus → ASK which section (never silently choose)".
 * Opened by `ReviewComposerPage` whenever a `Cite`/`⏱ Cite current moment`
 * action fires with no section textarea currently focused. Picking a
 * section inserts the pending citation at the END of that section's body
 * (there's no cursor position to speak of when nothing was focused).
 */
export function CiteSectionPrompt({
  open,
  sections,
  onPick,
  onOpenChange,
}: CiteSectionPromptProps) {
  const { t } = useTranslation();

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t('coaching.reviews.composer.citeSectionPrompt.title')}</DialogTitle>
          <DialogDescription>
            {t('coaching.reviews.composer.citeSectionPrompt.description')}
          </DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-1.5">
          {sections.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              {t('coaching.reviews.composer.citeSectionPrompt.empty')}
            </p>
          ) : (
            sections.map((section) => (
              <Button
                key={section.id}
                type="button"
                variant="outline"
                className="justify-start"
                onClick={() => onPick(section.id)}
              >
                {sectionLabel(t, section)}
              </Button>
            ))
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
