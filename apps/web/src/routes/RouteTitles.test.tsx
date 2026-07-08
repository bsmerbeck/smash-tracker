import { describe, expect, it } from 'vitest';
import { render } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { navItems } from '@/layouts/nav';
import { RouteTitles, titleForPath } from './RouteTitles';

function renderAt(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <RouteTitles />
    </MemoryRouter>,
  );
}

describe('RouteTitles', () => {
  it('sets a per-route title for every nav destination', () => {
    for (const item of navItems) {
      expect(titleForPath(item.href)).toBe(`${item.title} | Smash Tracker`);
    }
  });

  it('applies the title to the document', () => {
    renderAt('/matchups');
    expect(document.title).toBe('Matchups | Smash Tracker');
  });

  it('titles tournament detail pages', () => {
    expect(titleForPath('/tournaments/tournament-123')).toBe('Tournament | Smash Tracker');
  });

  it('leaves unmapped (public/SEO) routes alone so useSeo owns them', () => {
    document.title = 'set by useSeo';
    renderAt('/gsp-calculator');
    expect(document.title).toBe('set by useSeo');
    expect(titleForPath('/')).toBeNull();
    expect(titleForPath('/faq')).toBeNull();
  });
});
