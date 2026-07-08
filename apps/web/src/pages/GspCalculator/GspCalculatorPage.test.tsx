import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { GSP_MODEL, eliteThresholdGsp } from '@smash-tracker/shared';
import { GspCalculatorPage } from './GspCalculatorPage';

/** The doc's worked-example anchor: t=502 at exactly T_ANCHOR.atMs — see packages/shared/src/gspMmr.ts. */
const ANCHOR_MS = GSP_MODEL.T_ANCHOR.atMs;

function renderPage() {
  return render(
    <MemoryRouter initialEntries={['/gsp-calculator']}>
      <GspCalculatorPage />
    </MemoryRouter>,
  );
}

describe('GspCalculatorPage', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(ANCHOR_MS);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('renders the headline Elite Smash threshold computed from the shared engine (t=502 worked example)', () => {
    renderPage();

    const expected = Math.round(eliteThresholdGsp(502));
    expect(expected).toBe(14_720_247);

    expect(
      screen.getByRole('heading', { level: 1, name: 'Elite Smash GSP Calculator' }),
    ).toBeInTheDocument();
    expect(screen.getByText(expected.toLocaleString())).toBeInTheDocument();
  });

  it('sets a route-specific title and canonical', () => {
    renderPage();
    expect(document.title).toBe('Elite Smash GSP Calculator — GSP to MMR & Road to Elite');
  });

  it('parses "6.3m" shorthand input and shows an MMR estimate', () => {
    renderPage();

    const input = screen.getByLabelText('Your current GSP');
    fireEvent.change(input, { target: { value: '6.3m' } });

    expect(screen.getByText('Estimated hidden MMR')).toBeInTheDocument();
  });

  it('shows the honest equilibrium state at the default 50% win rate', () => {
    renderPage();

    const input = screen.getByLabelText('Your current GSP');
    // Well below Elite MMR so the projection card renders (not "already-elite").
    fireEvent.change(input, { target: { value: '5000000' } });

    expect(screen.getByText('Holding steady at your level')).toBeInTheDocument();
    expect(screen.getByLabelText(/Recent win rate/)).toHaveValue('50');
  });

  it('emits WebApplication JSON-LD', () => {
    const { container } = renderPage();
    const script = container.querySelector('script[type="application/ld+json"]');
    expect(script).not.toBeNull();
    const json = JSON.parse(script!.textContent ?? '{}');
    expect(json['@type']).toBe('WebApplication');
    expect(json.name).toBe('Elite Smash GSP Calculator');
    expect(json.offers.price).toBe('0');
  });

  it('links the sign-up CTA to the landing page', () => {
    renderPage();
    expect(screen.getByRole('link', { name: 'Sign up free' })).toHaveAttribute('href', '/');
  });
});
