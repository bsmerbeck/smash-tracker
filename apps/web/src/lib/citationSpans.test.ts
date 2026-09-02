import { describe, expect, it } from 'vitest';
import { serializeCitationToken } from '@smash-tracker/shared';
import type { CitationToken } from '@smash-tracker/shared';
import { locateCitationSpans, removeCitationSpan, splitCitationSegments } from './citationSpans';

function token(overrides: Partial<CitationToken> = {}): CitationToken {
  return { sourceVodRef: 'm1', seconds: 32, label: 'Great edgeguard', ...overrides };
}

describe('locateCitationSpans', () => {
  it('returns two spans whose start/end slice back to exactly raw for two tokens separated by prose', () => {
    const t1 = serializeCitationToken(token({ seconds: 5, label: 'first' }));
    const t2 = serializeCitationToken(token({ seconds: 90, label: 'second' }));
    const body = `Before ${t1} middle ${t2} after`;

    const spans = locateCitationSpans(body);

    expect(spans).toHaveLength(2);
    expect(body.slice(spans[0]!.start, spans[0]!.end)).toBe(t1);
    expect(body.slice(spans[1]!.start, spans[1]!.end)).toBe(t2);
    expect(spans[0]!.raw).toBe(t1);
    expect(spans[1]!.raw).toBe(t2);
  });

  it('does not locate a token whose seconds field is non-numeric — zero spans, no throw', () => {
    const body = '{{cite:matchId=m1;seconds=abc;label=x}}';
    expect(() => locateCitationSpans(body)).not.toThrow();
    expect(locateCitationSpans(body)).toEqual([]);
  });

  it('locates a token whose label exceeds the shared 200-char cap (locate bound is 600) but token is null', () => {
    const overLongLabel = encodeURIComponent('x'.repeat(210));
    const body = `{{cite:matchId=m1;seconds=32;label=${overLongLabel}}}`;

    const spans = locateCitationSpans(body);

    expect(spans).toHaveLength(1);
    expect(spans[0]!.token).toBeNull();
  });

  it('returns token: null (never throws) for unparseable percent-encoding', () => {
    const body = '{{cite:matchId=m1;seconds=32;label=%}}';
    expect(() => locateCitationSpans(body)).not.toThrow();
    const spans = locateCitationSpans(body);
    expect(spans).toHaveLength(1);
    expect(spans[0]!.token).toBeNull();
  });
});

describe('splitCitationSegments', () => {
  it('round-trips: concatenating every segment reproduces the input exactly', () => {
    const t1 = serializeCitationToken(token({ seconds: 5, label: 'first' }));
    const t2 = serializeCitationToken(token({ seconds: 90, label: 'second' }));
    const bodies = [
      `Before ${t1} middle ${t2} after`,
      'no tokens at all here',
      '',
      t1,
      `${t1}${t2}`,
      'trailing token at the very end ' + t2,
    ];

    for (const body of bodies) {
      const segments = splitCitationSegments(body);
      const reconstructed = segments
        .map((segment) => (segment.kind === 'text' ? segment.text : segment.span.raw))
        .join('');
      expect(reconstructed).toBe(body);
    }
  });
});

describe('removeCitationSpan', () => {
  it('deletes the token and collapses the two padded spaces down to one', () => {
    const raw = serializeCitationToken(token());
    const body = `before ${raw} after`;
    const span = locateCitationSpans(body)[0]!;

    expect(removeCitationSpan(body, span)).toBe('before after');
  });

  it('leaves no leading space when the token is at the very start of the body', () => {
    const raw = serializeCitationToken(token());
    const body = `${raw} after`;
    const span = locateCitationSpans(body)[0]!;

    expect(removeCitationSpan(body, span)).toBe('after');
  });

  it('leaves no trailing space when the token is at the very end of the body', () => {
    const raw = serializeCitationToken(token());
    const body = `before ${raw}`;
    const span = locateCitationSpans(body)[0]!;

    expect(removeCitationSpan(body, span)).toBe('before');
  });

  it('returns the body unchanged when the span is stale (slice no longer equals raw)', () => {
    const raw = serializeCitationToken(token());
    const body = `before ${raw} after`;
    const span = locateCitationSpans(body)[0]!;
    const editedBody = `before something else after`;

    expect(removeCitationSpan(editedBody, span)).toBe(editedBody);
  });

  it('removes only the targeted span when the body holds two identical tokens', () => {
    const raw = serializeCitationToken(token());
    const body = `${raw} middle ${raw} end`;
    const spans = locateCitationSpans(body);
    expect(spans).toHaveLength(2);

    const result = removeCitationSpan(body, spans[1]!);

    // Only the SECOND occurrence (by offset) is removed — the first raw
    // token text is untouched, proving this is offset-based, not a
    // string-wide `replace`.
    expect(result).toBe(`${raw} middle end`);
  });
});
