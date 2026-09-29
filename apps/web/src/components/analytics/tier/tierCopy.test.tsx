import { afterEach, describe, expect, it } from 'vitest';
import { render } from '@testing-library/react';
import {
  resolveTournamentTier,
  type TierEntryFields,
  type TierResolution,
} from '@smash-tracker/shared';
import i18n from '@/i18n';
import { TooltipProvider } from '@/components/ui/tooltip';
import { TierBadge } from './TierBadge';
import { TierProvenanceLine } from './TierProvenanceLine';
import { tierProvenanceKey, useTierProvenanceText } from './tierProvenance';

/**
 * G4, part 1 (UI-SPEC §13, CONTEXT lesson "copy-params render test"): every
 * basis / reason a tier can carry is rendered through the REAL six locale
 * files, and no interpolation placeholder may survive into the DOM, no raw
 * entry key may appear where a name belongs, and the estimated sentence must
 * show its grouped figure. A key whose translation drops or renames a
 * `{{token}}` would leave a literal placeholder behind and fail here.
 */

const LOCALES = ['en', 'es', 'fr', 'de', 'pt', 'ja'] as const;
const RAW_ENTRY_KEY = 'startgg-99001-1581';

const OFFLINE: TierEntryFields = { eventName: 'Supernova 2026', isOnline: false };

const CASES: { name: string; resolution: TierResolution }[] = [
  {
    name: 'estimated, many entrants',
    resolution: resolveTournamentTier({ entry: { ...OFFLINE, numEntrants: 1581 } }),
  },
  {
    name: 'estimated, one entrant',
    resolution: resolveTournamentTier({ entry: { ...OFFLINE, numEntrants: 1 } }),
  },
  {
    name: 'manual',
    resolution: resolveTournamentTier({
      entry: {
        ...OFFLINE,
        numEntrants: 412,
        tierOverride: { contractVersion: 1, tier: 'major', setAtMs: 1 },
      },
    }),
  },
  {
    name: 'manual set to unknown',
    resolution: resolveTournamentTier({
      entry: {
        ...OFFLINE,
        numEntrants: 412,
        tierOverride: { contractVersion: 1, tier: 'unknown', setAtMs: 1 },
      },
    }),
  },
  {
    name: 'recorded on Liquipedia (typed for Phase 42)',
    resolution: resolveTournamentTier({
      entry: OFFLINE,
      externalTierRow: { tier: 'supermajor', source: 'liquipedia' },
    }),
  },
  {
    name: 'unknown, online',
    resolution: resolveTournamentTier({
      entry: { eventName: 'Weekly', isOnline: true, numEntrants: 5605 },
    }),
  },
  {
    name: 'unknown, side event',
    resolution: resolveTournamentTier({
      entry: { eventName: 'Squad Strike', isOnline: false, numEntrants: 300 },
    }),
  },
  {
    name: 'unknown, no entrant count',
    resolution: resolveTournamentTier({ entry: { eventName: 'Weekly', isOnline: false } }),
  },
  {
    name: 'unknown, setting unknown',
    resolution: resolveTournamentTier({ entry: { eventName: 'Weekly', numEntrants: 100 } }),
  },
];

function Probe({ resolution }: { resolution: TierResolution }) {
  const provenance = useTierProvenanceText(resolution) ?? '';
  return (
    <TooltipProvider>
      <TierBadge
        tier={resolution.tier}
        basis={resolution.basis}
        source={resolution.source}
        provenance={provenance}
      />
      <TierProvenanceLine resolution={resolution} />
    </TooltipProvider>
  );
}

describe('tier copy through the real locale files (G4)', () => {
  afterEach(async () => {
    await i18n.changeLanguage('en');
  });

  it('exercises every reason and basis the resolver can produce (non-vacuity)', () => {
    const bases = new Set(CASES.map((item) => item.resolution.basis));
    expect([...bases].sort()).toEqual(['estimated', 'manual', 'recorded', 'unknown']);
    const reasons = new Set(CASES.map((item) => item.resolution.reason));
    for (const reason of ['online', 'sideEvent', 'noEntrants', 'settingUnknown', 'manual']) {
      expect(reasons.has(reason as TierResolution['reason']), reason).toBe(true);
    }
  });

  for (const locale of LOCALES) {
    describe(locale, () => {
      for (const { name, resolution } of CASES) {
        it(`${name}: no placeholder survives and no raw entry key appears`, async () => {
          await i18n.changeLanguage(locale);
          const { container } = render(<Probe resolution={resolution} />);
          const text = container.textContent ?? '';
          expect(text).not.toContain('{{');
          expect(text).not.toContain('}}');
          expect(text).not.toContain(RAW_ENTRY_KEY);
          expect(text.trim()).not.toBe('');
          const line = container.querySelector('[data-slot="tier-provenance"]');
          // The recorded tier renders a Liquipedia sentence; every other case names its basis.
          expect(line, `${locale} ${name} renders a provenance line`).not.toBeNull();
          expect(line?.textContent?.trim()).not.toBe('');
        });
      }

      it('the estimated line carries the grouped entrant figure in this locale', async () => {
        await i18n.changeLanguage(locale);
        const estimated = CASES[0]!.resolution;
        const { container } = render(<Probe resolution={estimated} />);
        const line = container.querySelector('[data-slot="tier-provenance"]')?.textContent ?? '';
        const grouped = new Intl.NumberFormat(locale).format(1581);
        expect(line).toContain(grouped);
        if (locale === 'en') {
          expect(line).toBe('Estimated from 1,581 entrants');
        }
      });
    });
  }

  it('en: the singular and plural estimated sentences select their own form', async () => {
    await i18n.changeLanguage('en');
    const one = tierProvenanceKey(CASES[1]!.resolution, 'en');
    const many = tierProvenanceKey(CASES[0]!.resolution, 'en');
    expect(i18n.t(one!.key, one!.values)).toBe('Estimated from 1 entrant');
    expect(i18n.t(many!.key, many!.values)).toBe('Estimated from 1,581 entrants');
  });

  it('a tier badge never leaks the tier word key of another tier (the word is the localised label)', async () => {
    await i18n.changeLanguage('de');
    const { container } = render(<Probe resolution={CASES[0]!.resolution} />);
    expect(container.querySelector('[data-slot="tier-badge"]')?.textContent).toBe('Supermajor');
    await i18n.changeLanguage('ja');
    const { container: jaContainer } = render(<Probe resolution={CASES[0]!.resolution} />);
    expect(jaContainer.querySelector('[data-slot="tier-badge"]')?.textContent).toBe(
      'スーパーメジャー',
    );
  });
});
