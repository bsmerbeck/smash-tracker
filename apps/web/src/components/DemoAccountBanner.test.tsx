import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import i18n from '@/i18n';
import { DemoAccountBanner } from './DemoAccountBanner';

const useIsDemoAccount = vi.fn();

vi.mock('@/hooks/useIsDemoAccount', () => ({
  useIsDemoAccount: () => useIsDemoAccount(),
}));

const EN_BANNER_TEXT = 'Public-data research snapshot — unverified, not player-owned or endorsed.';

const LOCALE_BANNER_TEXT: Record<string, string> = {
  en: EN_BANNER_TEXT,
  es: 'Instantánea de investigación con datos públicos — no verificada, no es propiedad del jugador ni cuenta con su respaldo.',
  fr: 'Instantané de recherche à partir de données publiques — non vérifié, ni détenu ni approuvé par le joueur.',
  de: 'Forschungs-Snapshot aus öffentlichen Daten — unverifiziert, nicht im Besitz des Spielers und nicht von ihm unterstützt.',
  pt: 'Instantâneo de pesquisa com dados públicos — não verificado, não pertence nem é endossado pelo jogador.',
  ja: 'これは公開データによるリサーチスナップショットです。未検証であり、選手本人が所有・承認したものではありません。',
};

describe('DemoAccountBanner', () => {
  afterEach(async () => {
    await i18n.changeLanguage('en');
  });

  it('renders the localized unverified-snapshot text when the signed-in account is a demo account', () => {
    useIsDemoAccount.mockReturnValue(true);

    render(<DemoAccountBanner />);

    const banner = screen.getByTestId('demo-account-banner');
    expect(banner).toHaveTextContent(EN_BANNER_TEXT);
    expect(banner).toHaveAttribute('role', 'status');
  });

  it('positive control: renders nothing for an ordinary (non-demo) account', () => {
    useIsDemoAccount.mockReturnValue(false);

    render(<DemoAccountBanner />);

    expect(screen.queryByTestId('demo-account-banner')).not.toBeInTheDocument();
  });

  it.each(Object.keys(LOCALE_BANNER_TEXT))(
    'renders the correct translated text for locale %s, distinct from English for non-English locales',
    async (locale) => {
      useIsDemoAccount.mockReturnValue(true);
      await i18n.changeLanguage(locale);

      render(<DemoAccountBanner />);

      const banner = screen.getByTestId('demo-account-banner');
      expect(banner).toHaveTextContent(LOCALE_BANNER_TEXT[locale]!);
      if (locale !== 'en') {
        expect(banner.textContent).not.toBe(EN_BANNER_TEXT);
      }
    },
  );

  it('has no dismiss/close control — persistent, never a toast', () => {
    useIsDemoAccount.mockReturnValue(true);

    render(<DemoAccountBanner />);

    const banner = screen.getByTestId('demo-account-banner');
    expect(banner.querySelector('button')).toBeNull();
  });
});
