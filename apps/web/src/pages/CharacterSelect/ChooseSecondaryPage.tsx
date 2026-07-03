import { CharacterSelectScreen } from './CharacterSelectScreen';

/** Ports legacy/src/screens/CharacterSelect/SecondarySelect. */
export function ChooseSecondaryPage() {
  return (
    <CharacterSelectScreen
      slot="secondary"
      heading="Choose Your Secondaries"
      description={
        'Begin by selecting your secondary fighters. You can search using the input below. ' +
        "To remove a character, simply click it again. When you're finished, press Save " +
        'to begin using Smash Tracker!'
      }
      destinations={[
        { label: 'Save and go to Dashboard', href: '/dashboard' },
        { label: 'Save and choose Primary Fighters', href: '/choose-primary' },
      ]}
    />
  );
}
