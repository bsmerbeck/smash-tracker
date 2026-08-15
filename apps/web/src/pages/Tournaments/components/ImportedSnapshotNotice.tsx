import { useTranslation } from 'react-i18next';
import { Archive } from 'lucide-react';
import type { TournamentEntry } from '@smash-tracker/shared';
import { getHistoricalFields, importedProviderDisplayName } from '@/lib/historicalTournament';

function formatDate(time: number, locale: string): string {
  return new Date(time).toLocaleDateString(locale, {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });
}

/**
 * Phase 30.3 (Gate 4): the truthful-provenance banner rendered on an
 * admin-imported historical tournament's detail page. States plainly that
 * the event is an imported snapshot of public data (never a live-synced
 * registration), names the source site (untranslated provider name), and —
 * only when the import recorded them — the imported-at and data-as-of
 * dates. Renders nothing for manual/linked entries.
 */
export function ImportedSnapshotNotice({ entry }: { entry: TournamentEntry }) {
  const { t, i18n } = useTranslation();
  const historical = getHistoricalFields(entry);
  if (!historical) {
    return null;
  }
  const provider = importedProviderDisplayName(entry);
  const provenance = historical.provenance;

  return (
    <div
      className="flex items-start gap-3 rounded-lg border border-dashed p-4"
      data-testid="imported-snapshot-notice"
    >
      <Archive className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
      <div className="flex flex-col gap-0.5">
        <p className="text-sm font-medium">{t('tournaments.imported.noticeTitle')}</p>
        <p className="text-sm text-muted-foreground">
          {t('tournaments.imported.noticeBody', { provider })}
        </p>
        <p className="text-xs text-muted-foreground">
          {t('tournaments.imported.sourceLine', { provider })}
          {provenance != null && (
            <>
              {' · '}
              {t('tournaments.imported.importedAt', {
                date: formatDate(provenance.importedAtMs, i18n.language),
              })}
            </>
          )}
          {provenance?.asOfMs != null && (
            <>
              {' · '}
              {t('tournaments.imported.asOf', {
                date: formatDate(provenance.asOfMs, i18n.language),
              })}
            </>
          )}
        </p>
      </div>
    </div>
  );
}
