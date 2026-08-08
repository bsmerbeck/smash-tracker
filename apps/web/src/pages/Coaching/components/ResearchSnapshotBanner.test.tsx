import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import i18n from '@/i18n';
import { ResearchSnapshotBanner } from './ResearchSnapshotBanner';

const useResearchSubject = vi.fn();

vi.mock('@/hooks/useResearchSubject', () => ({
  useResearchSubject: () => useResearchSubject(),
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

describe('ResearchSnapshotBanner', () => {
  afterEach(async () => {
    await i18n.changeLanguage('en');
  });

  it('renders the localized unverified-snapshot text when the active subject is a research tenant', () => {
    useResearchSubject.mockReturnValue({
      isResearch: true,
      isPending: false,
      isError: false,
      retry: vi.fn(),
    });

    render(<ResearchSnapshotBanner />);

    const banner = screen.getByTestId('research-snapshot-banner');
    expect(banner).toHaveTextContent(EN_BANNER_TEXT);
    expect(banner).toHaveAttribute('role', 'status');
  });

  it('renders nothing when the subject is ordinary', () => {
    useResearchSubject.mockReturnValue({
      isResearch: false,
      isPending: false,
      isError: false,
      retry: vi.fn(),
    });

    render(<ResearchSnapshotBanner />);

    expect(screen.queryByTestId('research-snapshot-banner')).not.toBeInTheDocument();
  });

  it('renders nothing when there is no active workspace (all flags false)', () => {
    useResearchSubject.mockReturnValue({
      isResearch: false,
      isPending: false,
      isError: false,
      retry: vi.fn(),
    });

    render(<ResearchSnapshotBanner />);

    expect(screen.queryByTestId('research-snapshot-banner')).not.toBeInTheDocument();
  });

  it("renders nothing while pending or on error, even though those states are the layout's job to gate separately", () => {
    useResearchSubject.mockReturnValue({
      isResearch: false,
      isPending: true,
      isError: false,
      retry: vi.fn(),
    });
    const { rerender } = render(<ResearchSnapshotBanner />);
    expect(screen.queryByTestId('research-snapshot-banner')).not.toBeInTheDocument();

    useResearchSubject.mockReturnValue({
      isResearch: false,
      isPending: false,
      isError: true,
      retry: vi.fn(),
    });
    rerender(<ResearchSnapshotBanner />);
    expect(screen.queryByTestId('research-snapshot-banner')).not.toBeInTheDocument();
  });

  it.each(Object.keys(LOCALE_BANNER_TEXT))(
    'renders the correct translated text for locale %s, distinct from English for non-English locales',
    async (locale) => {
      useResearchSubject.mockReturnValue({
        isResearch: true,
        isPending: false,
        isError: false,
        retry: vi.fn(),
      });
      await i18n.changeLanguage(locale);

      render(<ResearchSnapshotBanner />);

      const banner = screen.getByTestId('research-snapshot-banner');
      expect(banner).toHaveTextContent(LOCALE_BANNER_TEXT[locale]!);
      if (locale !== 'en') {
        expect(banner.textContent).not.toBe(EN_BANNER_TEXT);
      }
    },
  );
});
