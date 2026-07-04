import { describe, expect, it } from 'vitest';
import { buildStartggUrl, buildEventStartggUrl } from './startggLinks';

describe('buildStartggUrl', () => {
  it('builds a start.gg URL from a slug', () => {
    expect(buildStartggUrl('user/9fb774ae')).toBe('https://start.gg/user/9fb774ae');
  });

  it('builds a start.gg URL from a tournament slug', () => {
    expect(buildStartggUrl('tournament/the-box-juice-box-26')).toBe(
      'https://start.gg/tournament/the-box-juice-box-26',
    );
  });

  it('returns null when the slug is undefined', () => {
    expect(buildStartggUrl(undefined)).toBeNull();
  });

  it('returns null when the slug is an empty string', () => {
    expect(buildStartggUrl('')).toBeNull();
  });
});

describe('buildEventStartggUrl', () => {
  it('prefers the event slug over the tournament slug', () => {
    const url = buildEventStartggUrl({
      slug: 'tournament/the-box-juice-box-26',
      eventSlug: 'tournament/the-box-juice-box-26/event/ultimate-singles',
    });
    expect(url).toBe('https://start.gg/tournament/the-box-juice-box-26/event/ultimate-singles');
  });

  it('falls back to the tournament slug when the event slug is absent', () => {
    const url = buildEventStartggUrl({ slug: 'tournament/the-box-juice-box-26' });
    expect(url).toBe('https://start.gg/tournament/the-box-juice-box-26');
  });

  it('returns null when neither slug is present', () => {
    expect(buildEventStartggUrl({})).toBeNull();
  });
});
