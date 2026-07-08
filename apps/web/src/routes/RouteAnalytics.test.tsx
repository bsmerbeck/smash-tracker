import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Link, MemoryRouter, Route, Routes } from 'react-router';
import { logAnalyticsPageView } from '@/lib/firebase';
import { RouteAnalytics } from './RouteAnalytics';

vi.mock('@/lib/firebase', () => ({
  logAnalyticsPageView: vi.fn(),
}));

function renderWithRouter() {
  return render(
    <MemoryRouter initialEntries={['/faq']}>
      <RouteAnalytics />
      <Routes>
        <Route path="/faq" element={<Link to="/gsp-calculator">go</Link>} />
        <Route path="/gsp-calculator" element={<div>calculator</div>} />
      </Routes>
    </MemoryRouter>,
  );
}

describe('RouteAnalytics', () => {
  beforeEach(() => {
    vi.mocked(logAnalyticsPageView).mockClear();
  });

  it('logs a page_view for the initial route, including public ones', () => {
    renderWithRouter();
    expect(logAnalyticsPageView).toHaveBeenCalledExactlyOnceWith('/faq');
  });

  it('logs a page_view on every navigation', async () => {
    renderWithRouter();
    await userEvent.click(screen.getByRole('link', { name: 'go' }));

    expect(await screen.findByText('calculator')).toBeInTheDocument();
    expect(logAnalyticsPageView).toHaveBeenCalledTimes(2);
    expect(logAnalyticsPageView).toHaveBeenLastCalledWith('/gsp-calculator');
  });
});
