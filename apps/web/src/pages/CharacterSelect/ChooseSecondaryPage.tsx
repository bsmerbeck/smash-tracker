import { useTranslation } from 'react-i18next';
import { CharacterSelectScreen } from './CharacterSelectScreen';

/** Ports legacy/src/screens/CharacterSelect/SecondarySelect. */
export function ChooseSecondaryPage() {
  const { t } = useTranslation();
  return (
    <CharacterSelectScreen
      slot="secondary"
      heading={t('characterSelect.secondaryHeading')}
      description={t('characterSelect.secondaryDescription')}
      destinations={[
        { label: t('characterSelect.saveAndDashboard'), href: '/dashboard' },
        { label: t('characterSelect.saveAndPrimaries'), href: '/choose-primary' },
      ]}
    />
  );
}
