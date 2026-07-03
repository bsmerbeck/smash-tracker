import { describe, expect, it, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { AnalyticsFilterProvider, ANALYTICS_FILTER_STORAGE_KEY } from './AnalyticsFilterContext';
import { useAnalyticsFilter } from '@/hooks/useAnalyticsFilter';

function Probe() {
  const { source, range, setSource, setRange, resetFilters } = useAnalyticsFilter();
  return (
    <div>
      <span data-testid="source">{source}</span>
      <span data-testid="range">{range}</span>
      <button onClick={() => setSource('startgg')}>set-source</button>
      <button onClick={() => setRange('6m')}>set-range</button>
      <button onClick={resetFilters}>reset</button>
    </div>
  );
}

function renderProbe() {
  return render(
    <AnalyticsFilterProvider>
      <Probe />
    </AnalyticsFilterProvider>,
  );
}

describe('AnalyticsFilterContext', () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it('defaults to all/all when nothing is persisted', () => {
    renderProbe();
    expect(screen.getByTestId('source')).toHaveTextContent('all');
    expect(screen.getByTestId('range')).toHaveTextContent('all');
  });

  it('persists source and range changes to localStorage', async () => {
    const user = userEvent.setup();
    renderProbe();

    await user.click(screen.getByText('set-source'));
    await user.click(screen.getByText('set-range'));

    expect(screen.getByTestId('source')).toHaveTextContent('startgg');
    expect(screen.getByTestId('range')).toHaveTextContent('6m');
    const stored = JSON.parse(window.localStorage.getItem(ANALYTICS_FILTER_STORAGE_KEY) ?? '{}');
    expect(stored).toEqual({ source: 'startgg', range: '6m' });
  });

  it('hydrates initial state from a previously persisted value (lazy init)', () => {
    window.localStorage.setItem(
      ANALYTICS_FILTER_STORAGE_KEY,
      JSON.stringify({ source: 'manual', range: '3m' }),
    );
    renderProbe();
    expect(screen.getByTestId('source')).toHaveTextContent('manual');
    expect(screen.getByTestId('range')).toHaveTextContent('3m');
  });

  it('falls back to defaults for malformed JSON in localStorage', () => {
    window.localStorage.setItem(ANALYTICS_FILTER_STORAGE_KEY, '{not valid json');
    renderProbe();
    expect(screen.getByTestId('source')).toHaveTextContent('all');
    expect(screen.getByTestId('range')).toHaveTextContent('all');
  });

  it('falls back to defaults for a value with an invalid shape', () => {
    window.localStorage.setItem(
      ANALYTICS_FILTER_STORAGE_KEY,
      JSON.stringify({ source: 'not-a-real-source', range: 42 }),
    );
    renderProbe();
    expect(screen.getByTestId('source')).toHaveTextContent('all');
    expect(screen.getByTestId('range')).toHaveTextContent('all');
  });

  it('resetFilters restores defaults and persists them', async () => {
    const user = userEvent.setup();
    renderProbe();

    await user.click(screen.getByText('set-source'));
    await user.click(screen.getByText('set-range'));
    await user.click(screen.getByText('reset'));

    expect(screen.getByTestId('source')).toHaveTextContent('all');
    expect(screen.getByTestId('range')).toHaveTextContent('all');
    const stored = JSON.parse(window.localStorage.getItem(ANALYTICS_FILTER_STORAGE_KEY) ?? '{}');
    expect(stored).toEqual({ source: 'all', range: 'all' });
  });
});
