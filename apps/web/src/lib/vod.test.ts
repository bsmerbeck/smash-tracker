import { describe, expect, it } from 'vitest';
import {
  detectVodProvider,
  formatTimestamp,
  parseTimestamp,
  parseVodStartSeconds,
  vodDeepLink,
} from './vod';

describe('vodDeepLink', () => {
  it('appends &t=<s>s for a youtube.com/watch URL', () => {
    expect(vodDeepLink('https://youtube.com/watch?v=abc123', 161)).toBe(
      'https://youtube.com/watch?v=abc123&t=161s',
    );
  });

  it('works for www.youtube.com and m.youtube.com hosts', () => {
    expect(vodDeepLink('https://www.youtube.com/watch?v=abc123', 30)).toBe(
      'https://www.youtube.com/watch?v=abc123&t=30s',
    );
    expect(vodDeepLink('https://m.youtube.com/watch?v=abc123', 30)).toBe(
      'https://m.youtube.com/watch?v=abc123&t=30s',
    );
  });

  it('overwrites an existing t param on a youtube.com/watch URL', () => {
    expect(vodDeepLink('https://youtube.com/watch?v=abc123&t=5s', 161)).toBe(
      'https://youtube.com/watch?v=abc123&t=161s',
    );
  });

  it('uses ?t=<s> for a youtu.be short URL', () => {
    expect(vodDeepLink('https://youtu.be/abc123', 90)).toBe('https://youtu.be/abc123?t=90');
  });

  it('uses the 1h2m3s format for a twitch.tv/videos URL', () => {
    expect(vodDeepLink('https://twitch.tv/videos/123456789', 3723)).toBe(
      'https://twitch.tv/videos/123456789?t=1h2m3s',
    );
  });

  it('omits the hours segment in the twitch format when under an hour', () => {
    expect(vodDeepLink('https://twitch.tv/videos/123456789', 161)).toBe(
      'https://twitch.tv/videos/123456789?t=2m41s',
    );
  });

  it('handles zero seconds for twitch (0h0m0s -> 0s)', () => {
    expect(vodDeepLink('https://twitch.tv/videos/123456789', 0)).toBe(
      'https://twitch.tv/videos/123456789?t=0s',
    );
  });

  it('works for www.twitch.tv host', () => {
    expect(vodDeepLink('https://www.twitch.tv/videos/123456789', 65)).toBe(
      'https://www.twitch.tv/videos/123456789?t=1m5s',
    );
  });

  it('works for m.twitch.tv host (mobile)', () => {
    expect(vodDeepLink('https://m.twitch.tv/videos/123456789', 65)).toBe(
      'https://m.twitch.tv/videos/123456789?t=1m5s',
    );
  });

  it('returns the base URL unchanged for an unrecognized host', () => {
    expect(vodDeepLink('https://example.com/some-vod', 161)).toBe('https://example.com/some-vod');
  });

  it('returns a non-watch youtube.com path unchanged', () => {
    expect(vodDeepLink('https://youtube.com/channel/abc', 161)).toBe(
      'https://youtube.com/channel/abc',
    );
  });

  it('returns a non-videos twitch.tv path unchanged', () => {
    expect(vodDeepLink('https://twitch.tv/someuser', 161)).toBe('https://twitch.tv/someuser');
  });

  it('returns malformed input unchanged rather than throwing', () => {
    expect(vodDeepLink('not a url', 161)).toBe('not a url');
  });

  it('floors fractional seconds and clamps negative values to 0', () => {
    expect(vodDeepLink('https://youtu.be/abc123', 90.9)).toBe('https://youtu.be/abc123?t=90');
    expect(vodDeepLink('https://youtu.be/abc123', -5)).toBe('https://youtu.be/abc123?t=0');
  });
});

describe('formatTimestamp', () => {
  it('formats sub-minute offsets as m:ss', () => {
    expect(formatTimestamp(0)).toBe('0:00');
    expect(formatTimestamp(5)).toBe('0:05');
    expect(formatTimestamp(59)).toBe('0:59');
  });

  it('formats minute-scale offsets as m:ss', () => {
    expect(formatTimestamp(161)).toBe('2:41');
    expect(formatTimestamp(600)).toBe('10:00');
  });

  it('formats hour-scale offsets as h:mm:ss', () => {
    expect(formatTimestamp(3661)).toBe('1:01:01');
    expect(formatTimestamp(3600)).toBe('1:00:00');
  });

  it('floors fractional seconds and clamps negatives to 0', () => {
    expect(formatTimestamp(90.9)).toBe('1:30');
    expect(formatTimestamp(-5)).toBe('0:00');
  });
});

describe('parseTimestamp', () => {
  it('parses m:ss', () => {
    expect(parseTimestamp('2:41')).toBe(161);
    expect(parseTimestamp('0:05')).toBe(5);
  });

  it('parses h:mm:ss', () => {
    expect(parseTimestamp('1:01:01')).toBe(3661);
  });

  it('returns null for empty or whitespace-only input', () => {
    expect(parseTimestamp('')).toBeNull();
    expect(parseTimestamp('   ')).toBeNull();
  });

  it('returns null for non-numeric parts', () => {
    expect(parseTimestamp('a:bb')).toBeNull();
  });

  it('returns null for out-of-range minutes or seconds', () => {
    expect(parseTimestamp('1:60')).toBeNull();
    expect(parseTimestamp('1:99:00')).toBeNull();
  });

  it('returns null for too few or too many segments', () => {
    expect(parseTimestamp('42')).toBeNull();
    expect(parseTimestamp('1:2:3:4')).toBeNull();
  });

  it('round-trips with formatTimestamp', () => {
    expect(parseTimestamp(formatTimestamp(161))).toBe(161);
    expect(parseTimestamp(formatTimestamp(3661))).toBe(3661);
  });
});

describe('detectVodProvider', () => {
  it('extracts a YouTube long-form video id', () => {
    expect(detectVodProvider('https://www.youtube.com/watch?v=abc123')).toEqual({
      provider: 'youtube',
      videoId: 'abc123',
    });
  });

  it('extracts a YouTube short-form (youtu.be) video id', () => {
    expect(detectVodProvider('https://youtu.be/abc123')).toEqual({
      provider: 'youtube',
      videoId: 'abc123',
    });
  });

  it('extracts a YouTube short-form video id ignoring the query string', () => {
    expect(detectVodProvider('https://youtu.be/abc123?t=45')).toEqual({
      provider: 'youtube',
      videoId: 'abc123',
    });
  });

  it('extracts a Twitch VOD video id', () => {
    expect(detectVodProvider('https://www.twitch.tv/videos/123456789')).toEqual({
      provider: 'twitch',
      videoId: '123456789',
    });
  });

  it('extracts a Twitch VOD video id from a mobile (m.twitch.tv) URL', () => {
    expect(detectVodProvider('https://m.twitch.tv/videos/123456')).toEqual({
      provider: 'twitch',
      videoId: '123456',
    });
  });

  it('returns provider:null for an unsupported host', () => {
    expect(detectVodProvider('https://vimeo.com/12345')).toEqual({ provider: null });
  });

  it('returns provider:null for a YouTube watch URL missing the v param', () => {
    expect(detectVodProvider('https://www.youtube.com/watch')).toEqual({ provider: null });
  });

  it('returns provider:null for a malformed URL', () => {
    expect(detectVodProvider('not-a-url')).toEqual({ provider: null });
  });

  it('returns provider:null for a Twitch live channel URL (not /videos/)', () => {
    expect(detectVodProvider('https://www.twitch.tv/somechannel')).toEqual({ provider: null });
  });
});

describe('parseVodStartSeconds', () => {
  it('parses a bare-seconds t param on a youtube.com/watch URL', () => {
    expect(parseVodStartSeconds('https://youtube.com/watch?v=abc123&t=161')).toBe(161);
  });

  it('parses a trailing-s t param on a youtube.com/watch URL', () => {
    expect(parseVodStartSeconds('https://youtube.com/watch?v=abc123&t=161s')).toBe(161);
  });

  it('parses a duration-form t param (1h2m3s) on a youtube.com/watch URL', () => {
    expect(parseVodStartSeconds('https://youtube.com/watch?v=abc123&t=1h2m3s')).toBe(3723);
  });

  it('parses a partial duration-form t param (2m10s) on a youtube.com/watch URL', () => {
    expect(parseVodStartSeconds('https://youtube.com/watch?v=abc123&t=2m10s')).toBe(130);
  });

  it('falls back to the start param when t is absent on a youtube.com/watch URL', () => {
    expect(parseVodStartSeconds('https://youtube.com/watch?v=abc123&start=90')).toBe(90);
  });

  it('prefers t over start when both are present', () => {
    expect(parseVodStartSeconds('https://youtube.com/watch?v=abc123&start=5&t=90')).toBe(90);
  });

  it('parses a bare-seconds t param on a youtu.be short URL', () => {
    expect(parseVodStartSeconds('https://youtu.be/abc123?t=90')).toBe(90);
  });

  it('returns 0 for a youtube.com/watch URL with no t or start param', () => {
    expect(parseVodStartSeconds('https://youtube.com/watch?v=abc123')).toBe(0);
  });

  it('parses a duration-form t param (1h2m3s) on a twitch.tv/videos URL', () => {
    expect(parseVodStartSeconds('https://twitch.tv/videos/123456789?t=1h2m3s')).toBe(3723);
  });

  it('parses a bare-seconds t param on a twitch.tv/videos URL', () => {
    expect(parseVodStartSeconds('https://twitch.tv/videos/123456789?t=161')).toBe(161);
  });

  it('returns 0 for a twitch.tv/videos URL with no t param', () => {
    expect(parseVodStartSeconds('https://twitch.tv/videos/123456789')).toBe(0);
  });

  it('returns 0 for an unrecognized host', () => {
    expect(parseVodStartSeconds('https://example.com/some-vod?t=161')).toBe(0);
  });

  it('returns 0 for a malformed URL rather than throwing', () => {
    expect(parseVodStartSeconds('not a url')).toBe(0);
  });

  it('returns 0 for a malformed t value', () => {
    expect(parseVodStartSeconds('https://youtube.com/watch?v=abc123&t=notaduration')).toBe(0);
  });
});
