import { afterEach, describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import i18n, { SUPPORTED_LANGUAGES } from '@/i18n';
import { LanguageSelect } from './LanguageSelect';

describe('LanguageSelect', () => {
  afterEach(async () => {
    await i18n.changeLanguage('en');
    localStorage.clear();
  });

  it('offers every supported language by its own name', async () => {
    const user = userEvent.setup();
    render(<LanguageSelect />);

    await user.click(screen.getByRole('combobox', { name: 'Language' }));
    for (const lang of SUPPORTED_LANGUAGES) {
      expect(screen.getByRole('option', { name: lang.label })).toBeInTheDocument();
    }
  });

  it('switches the app language and persists the choice', async () => {
    const user = userEvent.setup();
    render(<LanguageSelect />);

    await user.click(screen.getByRole('combobox', { name: 'Language' }));
    await user.click(screen.getByRole('option', { name: 'Español' }));

    expect(i18n.resolvedLanguage).toBe('es');
    expect(i18n.t('nav.dashboard')).toBe('Panel');
    // i18next's detector cache — this is what makes the choice stick and
    // outrank browser-language detection on the next visit.
    expect(localStorage.getItem('i18nextLng')).toBe('es');
  });
});
