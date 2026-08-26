import { parseCitationToken } from '@smash-tracker/shared';
import type { CitationToken } from '@smash-tracker/shared';

/**
 * Locates `{{cite:...}}` token SPANS for interleaving with plain text.
 * Bounded quantifiers (unlike `coachingReview.ts`'s own unbounded `+`/`*`,
 * appropriate there since a citation's actual field lengths are enforced by
 * `citationTokenSchema` after parsing) are a LOCAL, defensive addition for a
 * locator that must never itself become the site of a ReDoS/length blowup.
 * Field VALIDATION/decoding is never reimplemented here — every located span
 * is re-checked through the shared `parseCitationToken` before being
 * trusted; a span that fails that check (or simply isn't matched at all,
 * e.g. a longer-than-bounded value) is reported with `token: null`, never a
 * rendering crash.
 *
 * Single owner (260826-kio): this constant used to live in `safeMarkdown.tsx`
 * — it now lives here so the delivery renderer AND the editor mirror
 * (`CitationTextarea.tsx`) share exactly one locate pattern. Never
 * duplicate/hand-roll a second copy.
 */
export const CITATION_LOCATE_SOURCE =
  '\\{\\{cite:matchId=[^;}]{1,200};seconds=\\d{1,15};label=[^}]{0,600}\\}\\}';

/**
 * Returns a FRESH `RegExp` on every call — never a shared module-level
 * instance — so no caller can be bitten by another caller's mutated
 * `lastIndex` on the same global-flagged regex.
 */
export function createCitationLocateRegex(): RegExp {
  return new RegExp(CITATION_LOCATE_SOURCE, 'g');
}

/** A single located `{{cite:...}}` candidate within a body string. */
export interface CitationSpan {
  /** Index of the token's first character in the body. */
  start: number;
  /** Index one past the token's last character in the body. */
  end: number;
  /** The exact substring `body.slice(start, end)` — the raw token text. */
  raw: string;
  /** The shared-validated token, or `null` when `raw` fails `parseCitationToken`. */
  token: CitationToken | null;
}

/**
 * Scans `body` for every `{{cite:...}}` candidate. Never throws, never
 * partially recovers a bad token, never re-implements percent-decoding or
 * field bounds — every hit's `token` comes straight from the shared
 * `parseCitationToken`.
 */
export function locateCitationSpans(body: string): CitationSpan[] {
  const regex = createCitationLocateRegex();
  const spans: CitationSpan[] = [];
  let match: RegExpExecArray | null;

  while ((match = regex.exec(body)) !== null) {
    const raw = match[0];
    spans.push({
      start: match.index,
      end: match.index + raw.length,
      raw,
      token: parseCitationToken(raw),
    });
    // A zero-length match would infinite-loop a global-regex `exec` — not
    // reachable with this grammar (every alternative consumes at least one
    // character), but guarded defensively (mirrors safeMarkdown.tsx).
    if (raw.length === 0) {
      regex.lastIndex += 1;
    }
  }

  return spans;
}

/** An interleaved run of plain text or a located citation candidate, in body order. */
export type CitationSegment =
  { kind: 'text'; text: string } | { kind: 'citation'; span: CitationSpan };

/**
 * Splits `body` into interleaved text/citation segments. Round-trip
 * invariant: concatenating every segment's text (plain-text segments plus
 * each citation segment's `span.raw`, in order) reproduces `body` EXACTLY.
 * This is the reason the mirror can never drift out of alignment with the
 * textarea it backs — every character of `body` appears in exactly one
 * segment, in order, unmodified.
 */
export function splitCitationSegments(body: string): CitationSegment[] {
  const spans = locateCitationSpans(body);
  const segments: CitationSegment[] = [];
  let cursor = 0;

  for (const span of spans) {
    if (span.start > cursor) {
      segments.push({ kind: 'text', text: body.slice(cursor, span.start) });
    }
    segments.push({ kind: 'citation', span });
    cursor = span.end;
  }

  if (cursor < body.length) {
    segments.push({ kind: 'text', text: body.slice(cursor) });
  }

  return segments;
}

/** The literal marker preceding a token's label value in its raw text. */
const LABEL_MARKER = 'label=';
/** The token grammar's closing braces. */
const CLOSING_BRACES = '}}';

/**
 * Slices an already-located token's raw text into the part before its label
 * value, the label value itself, and the trailing closing braces — so a
 * consumer (the mirror) can tint the label sub-range differently from the
 * machinery around it. Derives the cut points as INDEXES into `raw` (string
 * slicing of already-validated text, not a second parser). Falls back to the
 * whole string as `prefix` with empty `label`/`suffix` when either marker is
 * absent or out of order. By construction, `prefix + label + suffix` always
 * equals `raw` exactly in every branch.
 */
export function splitCitationSpanParts(raw: string): {
  prefix: string;
  label: string;
  suffix: string;
} {
  const markerIndex = raw.indexOf(LABEL_MARKER);
  const hasClosingBraces = raw.length >= CLOSING_BRACES.length && raw.endsWith(CLOSING_BRACES);
  const closingIndex = hasClosingBraces ? raw.length - CLOSING_BRACES.length : -1;
  const labelStart = markerIndex === -1 ? -1 : markerIndex + LABEL_MARKER.length;

  if (markerIndex === -1 || closingIndex === -1 || closingIndex < labelStart) {
    return { prefix: raw, label: '', suffix: '' };
  }

  return {
    prefix: raw.slice(0, labelStart),
    label: raw.slice(labelStart, closingIndex),
    suffix: raw.slice(closingIndex),
  };
}

/**
 * Offset-based deletion of a single located citation span from `body`.
 * Re-checks that `body.slice(span.start, span.end)` still equals `span.raw`
 * before deleting — a span computed on a since-edited body is STALE, and
 * this returns `body` completely unchanged rather than delete the wrong
 * range. Deletes only the exact `[start, end)` range (never a string
 * `replace`, so two identical tokens in the same body are disambiguated by
 * offset), then normalizes the seam the deletion leaves behind: a token at
 * the very start/end of the body leaves no leading/trailing space, and a
 * token in the middle collapses the two single spaces the insertion path
 * padded with down to one. No other whitespace in the body is touched — the
 * coach's own spacing elsewhere survives byte-for-byte.
 */
export function removeCitationSpan(body: string, span: CitationSpan): string {
  if (body.slice(span.start, span.end) !== span.raw) {
    return body;
  }

  let before = body.slice(0, span.start);
  let after = body.slice(span.end);

  if (before.length === 0 && after.startsWith(' ')) {
    after = after.slice(1);
  } else if (after.length === 0 && before.endsWith(' ')) {
    before = before.slice(0, -1);
  } else if (before.endsWith(' ') && after.startsWith(' ')) {
    after = after.slice(1);
  }

  return `${before}${after}`;
}
