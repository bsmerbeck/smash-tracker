import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { AnalyzeOpponentLink } from './AnalyzeOpponentLink';

function renderAt(path: string, ui: React.ReactElement) {
  return render(<MemoryRouter initialEntries={[path]}>{ui}</MemoryRouter>);
}

describe('AnalyzeOpponentLink', () => {
  it('renders an icon link preferring the provider player id on a personal route', () => {
    renderAt(
      '/match-data',
      <AnalyzeOpponentLink identity={{ opponentUserSlug: 'user/9fb774ae', opponent: 'rival' }} />,
    );
    const link = screen.getByRole('link', { name: 'Analyze opponent rival' });
    expect(link).toHaveAttribute('href', '/opponents?player=sgg%3Auser%2F9fb774ae&opponent=rival');
  });

  it('renders the labeled button variant', () => {
    renderAt('/vod', <AnalyzeOpponentLink variant="button" identity={{ opponent: 'rival' }} />);
    const link = screen.getByRole('link', { name: 'Analyze opponent rival' });
    expect(link).toHaveAttribute('href', '/opponents?opponent=rival');
    expect(link).toHaveTextContent('Analyze opponent');
  });

  it('renders nothing when nothing identifies the opponent', () => {
    const { container } = renderAt('/match-data', <AnalyzeOpponentLink identity={{}} />);
    expect(container.querySelector('a')).toBeNull();
  });

  it('renders nothing inside a coach client workspace — /opponents has no workspace route', () => {
    const { container } = renderAt(
      '/coach/client-1/match-data',
      <AnalyzeOpponentLink identity={{ opponent: 'rival' }} />,
    );
    expect(container.querySelector('a')).toBeNull();
  });

  it('renders nothing inside a client-owned workspace', () => {
    const { container } = renderAt(
      '/workspace/tenant-1/match-data',
      <AnalyzeOpponentLink identity={{ opponent: 'rival' }} />,
    );
    expect(container.querySelector('a')).toBeNull();
  });
});
