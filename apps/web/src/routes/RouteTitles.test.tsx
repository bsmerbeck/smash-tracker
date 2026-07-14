import { describe, expect, it } from 'vitest';
import { render } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { navItems } from '@/layouts/nav';
import { RouteTitles, titleKeyForPath } from './RouteTitles';

function renderAt(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <RouteTitles />
    </MemoryRouter>,
  );
}

describe('RouteTitles', () => {
  it('maps every nav destination to its nav.* title key', () => {
    for (const item of navItems) {
      expect(titleKeyForPath(item.href)).toBe(item.titleKey);
    }
  });

  it('applies the translated title to the document (English under the test fallback)', () => {
    renderAt('/matchups');
    expect(document.title).toBe('Matchups | grandfinals.gg');
  });

  it('titles tournament detail pages', () => {
    expect(titleKeyForPath('/tournaments/tournament-123')).toBe('nav.tournament');
  });

  it('leaves unmapped (public/SEO) routes alone so useSeo owns them', () => {
    document.title = 'set by useSeo';
    renderAt('/gsp-calculator');
    expect(document.title).toBe('set by useSeo');
    expect(titleKeyForPath('/')).toBeNull();
    expect(titleKeyForPath('/faq')).toBeNull();
  });
});
