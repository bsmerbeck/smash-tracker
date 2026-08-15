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

  it('a long-form watch URL keeps its validated t offset and drops the tracking params', () => {
    const result = normalizeLiquipediaVodUrl(
      'https://www.youtube.com/watch?v=oXoBi4DOq6I&t=42s&feature=share',
    );
    expect(result.vodUrl).toBe('https://www.youtube.com/watch?v=oXoBi4DOq6I&t=42s');
  });

  it('a playlist-context watch URL (list/index) drops the playlist params and, with no offset, reduces to the bare watch form', () => {
    const result = normalizeLiquipediaVodUrl(
      'https://www.youtube.com/watch?v=B1A_3d_-jRY&list=PLcMdMmtHkPpT1ZiF46rUkNbOW6tSRW4Eu&index=8',
    );
    expect(result.vodUrl).toBe('https://www.youtube.com/watch?v=B1A_3d_-jRY');
  });
});

describe('normalizeLiquipediaVodUrl — start offsets (30.3 Gate 5, known loss fixed)', () => {
  it('a short link with a bare-seconds t offset canonicalizes to the watch form with t=<seconds>s', () => {
    const result = normalizeLiquipediaVodUrl('https://youtu.be/6Mage6l0a4w?t=13540');
    expect(result.rejected).toBe(false);
    expect(result.vodUrl).toBe('https://www.youtube.com/watch?v=6Mage6l0a4w&t=13540s');
  });

  it('a short link carrying BOTH a tracking si and a t offset keeps the offset and drops the tracking param', () => {
    const result = normalizeLiquipediaVodUrl(
      'https://youtu.be/-cnZFKAfujo?si=g2fkckTPwW1bYOGx&t=17011',
    );
    expect(result.vodUrl).toBe('https://www.youtube.com/watch?v=-cnZFKAfujo&t=17011s');
    expect(result.vodUrl).not.toContain('si=');
  });

  it('a start= query param is treated as a validated offset source', () => {
    const result = normalizeLiquipediaVodUrl(
      'https://www.youtube.com/watch?v=oXoBi4DOq6I&start=90',
    );
    expect(result.vodUrl).toBe('https://www.youtube.com/watch?v=oXoBi4DOq6I&t=90s');
  });

  it('a legacy #t=11m38s fragment offset is validated, converted to seconds, and preserved', () => {
    const result = normalizeLiquipediaVodUrl(
      'https://www.youtube.com/watch?v=s8lEQWBm96o#t=11m38s',
    );
    expect(result.vodUrl).toBe('https://www.youtube.com/watch?v=s8lEQWBm96o&t=698s');
  });

  it('an INVALID offset value is dropped from the canonical form rather than passed through or guessed at', () => {
    const result = normalizeLiquipediaVodUrl('https://youtu.be/6Mage6l0a4w?t=whenever');
    expect(result.rejected).toBe(false);
    expect(result.vodUrl).toBe('https://www.youtube.com/watch?v=6Mage6l0a4w');
  });

  it('a zero offset is equivalent to no offset', () => {
    const result = normalizeLiquipediaVodUrl('https://youtu.be/6Mage6l0a4w?t=0');
    expect(result.vodUrl).toBe('https://www.youtube.com/watch?v=6Mage6l0a4w');
  });

  it('the same video with two DIFFERENT offsets stays two DISTINCT canonical forms — and therefore two distinct dedupe keys even for the same target set', () => {
    const first = normalizeLiquipediaVodUrl('https://youtu.be/sD9RX78rUDw?t=2203');
    const second = normalizeLiquipediaVodUrl('https://youtu.be/sD9RX78rUDw?t=5764');
    expect(first.vodUrl).not.toBe(second.vodUrl);
    expect(buildVodDedupeKey(first.vodUrl!, 'set-x')).not.toBe(
      buildVodDedupeKey(second.vodUrl!, 'set-x'),
    );
  });

  it('a Twitch t offset is validated and normalized to the duration form the web deep-link writer uses', () => {
    const seconds = normalizeLiquipediaVodUrl('https://www.twitch.tv/videos/949316125?t=1847s');
    expect(seconds.vodUrl).toBe('https://www.twitch.tv/videos/949316125?t=30m47s');
    const minutes = normalizeLiquipediaVodUrl('https://www.twitch.tv/videos/131225487?t=9m');
    expect(minutes.vodUrl).toBe('https://www.twitch.tv/videos/131225487?t=9m0s');
  });
});

describe('normalizeLiquipediaVodUrl — /live/ links (30.3 Gate 5, known loss fixed)', () => {
  it('a /live/<id> URL canonicalizes to the ordinary watch form for the same video', () => {
    const result = normalizeLiquipediaVodUrl('https://www.youtube.com/live/68Yek0_jlOU');
    expect(result.rejected).toBe(false);
    expect(result.vodUrl).toBe('https://www.youtube.com/watch?v=68Yek0_jlOU');
  });

  it('a /live/<id>?t=NNNN URL keeps its validated offset on the canonical watch form', () => {
    const result = normalizeLiquipediaVodUrl('https://www.youtube.com/live/PrrjJPxCsZw?t=26190');
    expect(result.vodUrl).toBe('https://www.youtube.com/watch?v=PrrjJPxCsZw&t=26190s');
  });

  it('a /live/ URL with an empty or nested id is still rejected with a stated reason', () => {
    expect(normalizeLiquipediaVodUrl('https://www.youtube.com/live/').rejected).toBe(true);
    expect(normalizeLiquipediaVodUrl('https://www.youtube.com/live/a/b').rejected).toBe(true);
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
// Data-driven: every VOD URL extracted from the committed player VOD-page
// fixtures either normalizes onto an allowlisted host or is rejected with a
// stated reason — never silently dropped — and (30.3 Gate 5) every KNOWN
// timestamped row keeps its offset while every `/live/` link is accepted.
// ---------------------------------------------------------------------------

const VOD_PAGE_FIXTURES = [
  'parse-sparg0-vods.json.gz',
  'parse-mkleo-vods.json.gz',
  'parse-hungrybox-vods.json.gz',
] as const;

function extractVodUrls(fixtureName: string): string[] {
  const compressed = readFileSync(resolve(LIQUIPEDIA_FIXTURE_DIR, fixtureName));
  const text = gunzipSync(compressed).toString('utf8');
  const parsed = JSON.parse(text) as { parse: { text: string } };
  const html = parsed.parse.text;
  const re = /class="plainlinks vodlink"><a href="([^"]+)"/g;
  const urls: string[] = [];
  let match: RegExpExecArray | null;
  while ((match = re.exec(html))) {
    // The parse HTML entity-escapes `&`; decode so query params parse.
    urls.push(match[1]!.replace(/&amp;/g, '&'));
  }
  return urls;
}

function extractSparg0VodUrls(): string[] {
  return extractVodUrls('parse-sparg0-vods.json.gz');
}

/** Mirrors the module-private offset grammar, for computing EXPECTED values in the fixture sweep. */
function expectedOffsetSeconds(raw: string): number | null {
  if (/^\d+$/.test(raw)) {
    return Number(raw);
  }
  const match = /^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?$/i.exec(raw);
  if (match && (match[1] !== undefined || match[2] !== undefined || match[3] !== undefined)) {
    return Number(match[1] ?? 0) * 3600 + Number(match[2] ?? 0) * 60 + Number(match[3] ?? 0);
  }
  return null;
}

/** Reads the raw offset value a fixture URL carries (t/start query param, or the legacy #t= fragment). */
function rawOffsetValue(url: URL): string | null {
  const query = url.searchParams.get('t') ?? url.searchParams.get('start');
  if (query != null && query.length > 0) {
    return query;
  }
  if (url.hash.startsWith('#t=')) {
    return url.hash.slice('#t='.length);
  }
  return null;
}

describe.each(VOD_PAGE_FIXTURES.map((name) => [name] as const))(
  'data-driven over %s: timestamped rows and /live/ links',
  (fixtureName) => {
    const urls = extractVodUrls(fixtureName);

    it('every timestamped row on an allowlisted host normalizes WITH its offset preserved in whole seconds', () => {
      let timestamped = 0;
      for (const raw of urls) {
        let parsed: URL;
        try {
          parsed = new URL(raw);
        } catch {
          continue;
        }
        if (!LIQUIPEDIA_VOD_ALLOWED_HOSTS.has(parsed.hostname.toLowerCase())) {
          continue;
        }
        const rawOffset = rawOffsetValue(parsed);
        if (rawOffset == null) {
          continue;
        }
        timestamped += 1;

        const result = normalizeLiquipediaVodUrl(raw);
        expect(result.rejected, `unexpected rejection for ${raw}: ${result.reason}`).toBe(false);

        const expected = expectedOffsetSeconds(rawOffset);
        const canonical = new URL(result.vodUrl!);
        const canonicalOffset = canonical.searchParams.get('t');
        if (expected !== null && expected > 0) {
          expect(canonicalOffset, `offset lost for ${raw}`).not.toBeNull();
          expect(expectedOffsetSeconds(canonicalOffset!), `offset value drifted for ${raw}`).toBe(
            expected,
          );
        } else {
          expect(canonicalOffset).toBeNull();
        }
      }
      // Every committed player VOD fixture is known to carry timestamped
      // rows — a zero count means the extraction regex broke, not that the
      // fixture changed.
      expect(timestamped).toBeGreaterThan(0);
    });

    it('every /live/ link is accepted and canonicalized to the ordinary watch form', () => {
      const liveUrls = urls.filter((url) => url.includes('/live/'));
      for (const raw of liveUrls) {
        const result = normalizeLiquipediaVodUrl(raw);
        expect(result.rejected, `live link rejected: ${raw} (${result.reason})`).toBe(false);
        expect(result.vodUrl).toContain('https://www.youtube.com/watch?v=');
      }
      if (fixtureName !== 'parse-hungrybox-vods.json.gz') {
        // Sparg0 and MkLeo's committed pages each carry at least one
        // /live/ permalink — the exact rows the pre-fix normalizer lost.
        expect(liveUrls.length).toBeGreaterThan(0);
      }
    });
  },
);

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
