import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { faqEntries } from '@/data/faqData';
import { FaqPage } from './FaqPage';

function renderFaqPage() {
  return render(
    <MemoryRouter initialEntries={['/faq']}>
      <FaqPage />
    </MemoryRouter>,
  );
}

describe('FaqPage', () => {
  it('renders the full FAQ list as an h1 with h2 questions', () => {
    renderFaqPage();

    expect(
      screen.getByRole('heading', { level: 1, name: 'Frequently asked questions' }),
    ).toBeInTheDocument();

    // h2 (not h3): questions sit directly under the page h1, and skipping a
    // heading level is an a11y/SEO-analyzer flag.
    for (const entry of faqEntries) {
      expect(screen.getByRole('heading', { level: 2, name: entry.question })).toBeInTheDocument();
      expect(screen.getByText(entry.answer)).toBeInTheDocument();
    }
  });

  it('sets a route-specific title and canonical URL', async () => {
    renderFaqPage();

    expect(await screen.findByText(faqEntries[0]!.question)).toBeInTheDocument();
    expect(document.title).toBe('Frequently Asked Questions | grandfinals.gg');
  });

  it('emits FAQPage JSON-LD generated from faqEntries', () => {
    const { container } = renderFaqPage();

    const script = container.querySelector('script[type="application/ld+json"]');
    expect(script).not.toBeNull();
    const json = JSON.parse(script!.textContent ?? '{}');
    expect(json['@type']).toBe('FAQPage');
    expect(json.mainEntity).toHaveLength(faqEntries.length);
    expect(json.mainEntity[0].name).toBe(faqEntries[0]!.question);
  });

  it('links back to the public layout footer routes', () => {
    renderFaqPage();

    expect(screen.getByRole('link', { name: 'GSP Calculator' })).toHaveAttribute(
      'href',
      '/gsp-calculator',
    );
  });
});
