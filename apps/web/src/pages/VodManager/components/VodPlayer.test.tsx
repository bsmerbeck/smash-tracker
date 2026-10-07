import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { VodPlayer } from './VodPlayer';

// The real hook injects vendor scripts and constructs YT/Twitch players; this
// suite only exercises VodPlayer's own render states, so the hook reports a
// ready, error-free embed.
vi.mock('@/lib/useVodPlayer', () => ({
  useVodPlayer: () => ({
    containerRef: { current: null },
    isReady: true,
    error: null,
    seek: vi.fn(),
    pause: vi.fn(),
    pauseAtEnd: vi.fn(() => false),
    getCurrentTime: vi.fn(() => 0),
  }),
}));

describe('VodPlayer open-on-host fallback', () => {
  // Owner report 2026-10-06: Twitch can paint its own in-iframe overlay
  // ("Failed to determine content classification") that the Embed API never
  // reports, so a Twitch VOD always offers a way out to twitch.tv itself.
  it('follows a Twitch embed with an "Open on www.twitch.tv" link at the start offset', () => {
    render(<VodPlayer vodUrl="https://www.twitch.tv/videos/123456789" startSeconds={3723} />);

    const playerBox = screen.getByTestId('vod-player-box');
    const link = screen.getByRole('link', { name: /Open on www\.twitch\.tv/ });

    expect(playerBox.contains(link)).toBe(false);
    expect(playerBox.compareDocumentPosition(link) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();

    const href = new URL(link.getAttribute('href')!);
    expect(href.hostname).toBe('www.twitch.tv');
    expect(href.pathname).toBe('/videos/123456789');
    expect(href.searchParams.get('t')).toBe('1h2m3s');
    expect(link).toHaveAttribute('target', '_blank');
    expect(link).toHaveAttribute('rel', 'noreferrer');
  });

  it('renders no open-on-host link beside a YouTube embed', () => {
    render(<VodPlayer vodUrl="https://www.youtube.com/watch?v=abc123" startSeconds={90} />);

    expect(screen.getByTestId('vod-player-box')).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /Open on/ })).toBeNull();
  });
});
