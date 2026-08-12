import { gunzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { LIQUIPEDIA_FIXTURE_DIR } from './__fixtures__/loadFixture.js';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  buildVodDedupeKey,
  LIQUIPEDIA_VOD_ALLOWED_HOSTS,
  normalizeLiquipediaVodUrl,
} from './vodUrl.js';

// The shipped host-recognition vocabulary this module's allowlist must
// agree with, read as LITERALS (not imported — apps/api cannot import from
// apps/web). Source of truth: apps/web/src/lib/vod.ts's YOUTUBE_HOSTS /
// YOUTUBE_SHORT_HOSTS / TWITCH_HOSTS sets.
const WEB_YOUTUBE_HOSTS = ['youtube.com', 'www.youtube.com', 'm.youtube.com'];
const WEB_YOUTUBE_SHORT_HOSTS = ['youtu.be', 'www.youtu.be'];
const WEB_TWITCH_HOSTS = ['twitch.tv', 'www.twitch.tv', 'm.twitch.tv'];

describe('LIQUIPEDIA_VOD_ALLOWED_HOSTS agrees with the shipped web detector', () => {
  it('contains every host string apps/web/src/lib/vod.ts recognises', () => {
    for (const host of [...WEB_YOUTUBE_HOSTS, ...WEB_YOUTUBE_SHORT_HOSTS, ...WEB_TWITCH_HOSTS]) {
      expect(LIQUIPEDIA_VOD_ALLOWED_HOSTS.has(host)).toBe(true);
    }
  });
});

describe('normalizeLiquipediaVodUrl — YouTube', () => {
  it('a watch-style URL and a short-link URL for the same video normalize to the same canonical form', () => {
    const watch = normalizeLiquipediaVodUrl('https://www.youtube.com/watch?v=oXoBi4DOq6I');
    const short = normalizeLiquipediaVodUrl('https://youtu.be/oXoBi4DOq6I');
    expect(watch.rejected).toBe(false);
    expect(short.rejected).toBe(false);
    expect(watch.vodUrl).toBe(short.vodUrl);
  });

  it('a tracking parameter on a short link is stripped from the canonical form; the raw string is unchanged', () => {
    const raw = 'https://youtu.be/JFOBV1Hb2E8?si=JkdgpFiE1BRvNLtN';
    const result = normalizeLiquipediaVodUrl(raw);
    expect(result.rejected).toBe(false);
    expect(result.vodUrl).not.toContain('si=');
    expect(result.vodUrl).toBe('https://www.youtube.com/watch?v=JFOBV1Hb2E8');
    expect(result.rawVodUrl).toBe(raw);
  });

  it('a plain-http short link is upgraded to https in the canonical form and never returned as http', () => {
    const result = normalizeLiquipediaVodUrl('http://youtu.be/j_UZf2urPn4');
    expect(result.rejected).toBe(false);
    expect(result.vodUrl).toMatch(/^https:\/\//);
    expect(result.vodUrl).toBe('https://www.youtube.com/watch?v=j_UZf2urPn4');
  });

  it('a long-form watch URL with extra tracking query params drops everything but v=', () => {
    const result = normalizeLiquipediaVodUrl(
      'https://www.youtube.com/watch?v=oXoBi4DOq6I&t=42s&feature=share',
    );
    expect(result.vodUrl).toBe('https://www.youtube.com/watch?v=oXoBi4DOq6I');
  });
});

describe('normalizeLiquipediaVodUrl — Twitch', () => {
  it('a Twitch video URL is accepted and passed through with its host preserved', () => {
    const result = normalizeLiquipediaVodUrl('https://www.twitch.tv/videos/1234567890');
    expect(result.rejected).toBe(false);
    expect(result.host).toBe('www.twitch.tv');
    expect(result.vodUrl).toContain('/videos/1234567890');
  });
});

describe('normalizeLiquipediaVodUrl — rejections', () => {
  it('a URL on any other host is REJECTED with a stated reason and yields no canonical value', () => {
    const result = normalizeLiquipediaVodUrl('https://vimeo.com/12345');
    expect(result.rejected).toBe(true);
    expect(result.vodUrl).toBeNull();
    expect(result.reason).not.toBeNull();
  });

  it('a script-scheme URL is rejected with a stated reason', () => {
    const result = normalizeLiquipediaVodUrl('javascript:alert(1)');
    expect(result.rejected).toBe(true);
    expect(result.vodUrl).toBeNull();
    expect(result.reason).not.toBeNull();
  });

  it('a data-scheme URL is rejected with a stated reason', () => {
    const result = normalizeLiquipediaVodUrl('data:text/html,<script>alert(1)</script>');
    expect(result.rejected).toBe(true);
    expect(result.vodUrl).toBeNull();
    expect(result.reason).not.toBeNull();
  });

  it('a protocol-relative URL is rejected', () => {
    const result = normalizeLiquipediaVodUrl('//youtube.com/watch?v=oXoBi4DOq6I');
    expect(result.rejected).toBe(true);
    expect(result.vodUrl).toBeNull();
  });

  it('a malformed URL is rejected with a stated reason rather than throwing', () => {
    const result = normalizeLiquipediaVodUrl('not a url at all');
    expect(result.rejected).toBe(true);
    expect(result.reason).not.toBeNull();
  });
});

describe('normalizeLiquipediaVodUrl — dedupe integrity', () => {
  it('two different videos never normalize to the same canonical form', () => {
    const a = normalizeLiquipediaVodUrl('https://www.youtube.com/watch?v=oXoBi4DOq6I');
    const b = normalizeLiquipediaVodUrl('https://www.youtube.com/watch?v=pncEm1PfAJU');
    expect(a.vodUrl).not.toBe(b.vodUrl);
  });
});

describe('buildVodDedupeKey', () => {
  it('exposes the pair of canonical URL and target set id, never the URL alone', () => {
    const canonical = normalizeLiquipediaVodUrl(
      'https://www.youtube.com/watch?v=pncEm1PfAJU',
    ).vodUrl!;
    const grandFinalsKey = buildVodDedupeKey(canonical, 'set-r3m1');
    const resetKey = buildVodDedupeKey(canonical, 'set-r3m2');
    // Same VOD, two different target sets (the GF and its reset) -> two
    // DISTINCT dedupe keys, so both attachments are representable.
    expect(grandFinalsKey).not.toBe(resetKey);
    expect(grandFinalsKey).toContain(canonical);
    expect(grandFinalsKey).toContain('set-r3m1');
  });
});

// ---------------------------------------------------------------------------
// Data-driven: every VOD URL extracted from the Sparg0 VOD-page fixture
// either normalizes onto an allowlisted host or is rejected with a stated
// reason — never silently dropped.
// ---------------------------------------------------------------------------

function extractSparg0VodUrls(): string[] {
  const compressed = readFileSync(resolve(LIQUIPEDIA_FIXTURE_DIR, 'parse-sparg0-vods.json.gz'));
  const text = gunzipSync(compressed).toString('utf8');
  const parsed = JSON.parse(text) as { parse: { text: string } };
  const html = parsed.parse.text;
  const re = /class="plainlinks vodlink"><a href="([^"]+)"/g;
  const urls: string[] = [];
  let match: RegExpExecArray | null;
  while ((match = re.exec(html))) {
    urls.push(match[1]!);
  }
  return urls;
}

describe('data-driven: every extracted Sparg0 VOD URL is accounted for', () => {
  it('accepted count plus rejected-with-reason count equals the total row count, zero unaccounted', () => {
    const urls = extractSparg0VodUrls();
    expect(urls.length).toBeGreaterThan(0);

    let accepted = 0;
    let rejectedWithReason = 0;
    let unaccounted = 0;

    for (const url of urls) {
      const result = normalizeLiquipediaVodUrl(url);
      if (!result.rejected) {
        accepted++;
        continue;
      }
      if (result.reason) {
        rejectedWithReason++;
      } else {
        unaccounted++;
      }
    }

    expect(unaccounted).toBe(0);
    expect(accepted + rejectedWithReason).toBe(urls.length);
  });
});
