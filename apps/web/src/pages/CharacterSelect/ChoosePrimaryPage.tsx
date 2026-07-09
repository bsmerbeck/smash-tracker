import { useTranslation } from 'react-i18next';
import { CharacterSelectScreen } from './CharacterSelectScreen';

/** Ports legacy/src/screens/CharacterSelect/PrimarySelect. */
export function ChoosePrimaryPage() {
  const { t } = useTranslation();
  return (
    <CharacterSelectScreen
      slot="primary"
      heading={t('characterSelect.primaryHeading')}
      description={t('characterSelect.primaryDescription')}
      destinations={[
        { label: t('characterSelect.saveAndSecondaries'), href: '/choose-secondary' },
        { label: t('characterSelect.saveAndDashboard'), href: '/dashboard' },
      ]}
    />
  );
}
