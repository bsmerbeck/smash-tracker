import { useTranslation } from 'react-i18next';
import type { Match } from '@smash-tracker/shared';

/** RED-phase stub (plan 39.1-13, tdd="true") — replaced by the real bounded/drillable list in the GREEN commit. */
export function PairingOpponents({ matchupMatches: _matchupMatches }: { matchupMatches: Match[] }) {
  const { t } = useTranslation();
  return <p className="text-sm text-muted-foreground">{t('matchups.opponentSplit.empty')}</p>;
}
