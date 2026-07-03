import { CharacterSelectScreen } from './CharacterSelectScreen';

/** Ports legacy/src/screens/CharacterSelect/PrimarySelect. */
export function ChoosePrimaryPage() {
  return (
    <CharacterSelectScreen
      slot="primary"
      heading="Choose Your Primaries"
      description={
        'Begin by selecting your primary fighters. You can search using the input below. ' +
        "To remove a character, simply click it again. When you're finished, press Save."
      }
      destinations={[
        { label: 'Save and Choose Secondaries', href: '/choose-secondary' },
        { label: 'Save and go to Dashboard', href: '/dashboard' },
      ]}
    />
  );
}
