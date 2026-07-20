import { Fragment } from 'react';
import type { ReactNode } from 'react';
import { parseCitationToken, SAFE_MARKDOWN_DOC_MAX_LENGTH } from '@smash-tracker/shared';
import { CitationChip } from '@/pages/Coaching/components/CitationChip';

/**
 * REV-04/D-10: the ONE hand-rolled renderer for the small safe-Markdown
 * subset a review section/private-notes body may contain — paragraphs,
 * headings (`#`/`##`/`###`), unordered/ordered lists, `*italic*`/`**bold**`
 * emphasis, and the `{{cite:...}}` citation token (grammar owned by
 * `packages/shared/src/coachingReview.ts`). Never react-markdown/remark/
 * rehype, never `dangerouslySetInnerHTML`, never raw HTML passthrough —
 * every code path below only ever produces React elements or plain-string
 * child nodes, so anything outside the fixed grammar (including literal
 * `<script>`/HTML) renders as inert text: React escapes string children
 * automatically, exactly like any other interpolated string. Reused
 * verbatim by the composer's "Preview as client" (this plan) and the
 * plan-08 delivery page — never a second, separately-maintained renderer
 * (the exact drift bug 12-RESEARCH.md's Pitfall in "Publish/Version Model"
 * calls out: "what the coach previews doesn't match what's actually
 * delivered").
 *
 * Explicit length/nesting limits (defense in depth beyond the schema's own
 * `safeMarkdownDocSchema.max(SAFE_MARKDOWN_DOC_MAX_LENGTH)`, since this
 * renderer may also be fed a not-yet-autosaved composer buffer that hasn't
 * round-tripped through that Zod check yet):
 * - the WHOLE input is truncated to `SAFE_MARKDOWN_DOC_MAX_LENGTH` before
 *   any parsing begins;
 * - at most `MAX_BLOCKS` paragraph/heading/list blocks are parsed — any
 *   further blocks are silently dropped, never rendered;
 * - at most `MAX_LIST_ITEMS` items render per list;
 * - emphasis is a SINGLE, non-recursive pass — a bold/italic span's inner
 *   text is matched against a fixed, bounded-length pattern that excludes
 *   further `*` characters, so there is no nested-emphasis recursion that
 *   could blow up on adversarial input like a long run of `*` characters.
 */

const MAX_BLOCKS = 100;
const MAX_LIST_ITEMS = 60;
/** Bounds a single emphasis span's inner text — defense against pathological, effectively-unterminated `*`/`**` runs. */
const MAX_EMPHASIS_SPAN_LENGTH = 400;

const HEADING_PATTERN = /^(#{1,3})\s+(.+)$/;
const UNORDERED_ITEM_PATTERN = /^[-*]\s+(.*)$/;
const ORDERED_ITEM_PATTERN = /^\d+\.\s+(.*)$/;

/** `h3`/`h4`/`h5` — offset from `#`/`##`/`###` so a review's own headings never collide with the surrounding page chrome's `h1`/`h2`. */
const HEADING_TAGS = ['h3', 'h4', 'h5'] as const;
const HEADING_CLASSES = [
  'text-base font-semibold',
  'text-sm font-semibold',
  'text-sm font-semibold',
];

/**
 * Locates `{{cite:...}}` token SPANS for interleaving with plain text.
 * Bounded quantifiers (unlike `coachingReview.ts`'s own unbounded `+`/`*`,
 * appropriate there since a citation's actual field lengths are enforced by
 * `citationTokenSchema` after parsing) are a LOCAL, defensive addition for
 * a renderer that must never itself become the site of a ReDoS/length
 * blowup. Field VALIDATION/decoding is never reimplemented here — every
 * located span is re-checked through the shared `parseCitationToken`
 * before being trusted; a span that fails that check (or simply isn't
 * matched at all, e.g. a longer-than-bounded value) falls back to inert
 * plain text, never a rendering crash.
 */
const CITATION_LOCATE_SOURCE =
  '\\{\\{cite:matchId=[^;}]{1,200};seconds=\\d{1,15};label=[^}]{0,600}\\}\\}';
const BOLD_SOURCE = `\\*\\*([^*\\n]{1,${MAX_EMPHASIS_SPAN_LENGTH}}?)\\*\\*`;
const ITALIC_SOURCE = `\\*([^*\\n]{1,${MAX_EMPHASIS_SPAN_LENGTH}}?)\\*`;
const INLINE_TOKEN_PATTERN = new RegExp(
  `(${CITATION_LOCATE_SOURCE})|(${BOLD_SOURCE})|(${ITALIC_SOURCE})`,
  'g',
);

export interface SafeMarkdownSource {
  /** Display title for a citation's source VOD, e.g. "vs Zain — Set 1". */
  label: string;
}

export interface SafeMarkdownProps {
  /** Raw safe-Markdown-subset body text (a review section or private notes). */
  body: string;
  /** Fires when a citation chip is activated. Seek-in-place vs. switch-source is entirely the CALLER's decision — this renderer never touches player state. */
  onActivateCitation?: (matchId: string, seconds: number) => void;
  /** Resolves a citation's `matchId` to a display source label — e.g. for a multi-VOD review whose citation references a DIFFERENT VOD than the one currently playing. Return `undefined` for the current/only source (no extra label needed). */
  resolveCitationSource?: (matchId: string) => SafeMarkdownSource | undefined;
}

interface Block {
  kind: 'heading' | 'list' | 'paragraph';
  level?: number;
  ordered?: boolean;
  lines: string[];
}

function splitBlocks(raw: string): Block[] {
  const paragraphs = raw.split(/\n{2,}/);
  const blocks: Block[] = [];

  for (const paragraph of paragraphs) {
    if (blocks.length >= MAX_BLOCKS) {
      break;
    }
    const lines = paragraph.split('\n').filter((line) => line.trim().length > 0);
    if (lines.length === 0) {
      continue;
    }

    if (lines.length === 1) {
      const headingMatch = HEADING_PATTERN.exec(lines[0]!);
      if (headingMatch) {
        blocks.push({ kind: 'heading', level: headingMatch[1]!.length, lines: [headingMatch[2]!] });
        continue;
      }
    }

    const unorderedItems = lines.map((line) => UNORDERED_ITEM_PATTERN.exec(line));
    if (unorderedItems.every((match) => match !== null)) {
      blocks.push({
        kind: 'list',
        ordered: false,
        lines: unorderedItems.slice(0, MAX_LIST_ITEMS).map((match) => match![1]!),
      });
      continue;
    }

    const orderedItems = lines.map((line) => ORDERED_ITEM_PATTERN.exec(line));
    if (orderedItems.every((match) => match !== null)) {
      blocks.push({
        kind: 'list',
        ordered: true,
        lines: orderedItems.slice(0, MAX_LIST_ITEMS).map((match) => match![1]!),
      });
      continue;
    }

    blocks.push({ kind: 'paragraph', lines });
  }

  return blocks;
}

/** Renders `raw` through the inline grammar (emphasis + citation tokens) into an array of text/element nodes. */
function renderInline(
  raw: string,
  keyPrefix: string,
  onActivateCitation: SafeMarkdownProps['onActivateCitation'],
  resolveCitationSource: SafeMarkdownProps['resolveCitationSource'],
): ReactNode[] {
  const nodes: ReactNode[] = [];
  let cursor = 0;
  let matchIndex = 0;
  INLINE_TOKEN_PATTERN.lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = INLINE_TOKEN_PATTERN.exec(raw)) !== null) {
    const [full, citationSpan, , boldInner, , italicInner] = match;
    if (match.index > cursor) {
      nodes.push(raw.slice(cursor, match.index));
    }
    const key = `${keyPrefix}-${matchIndex}`;
    matchIndex += 1;

    if (citationSpan) {
      const token = parseCitationToken(citationSpan);
      if (token) {
        nodes.push(
          <CitationChip
            key={key}
            matchId={token.sourceVodRef}
            seconds={token.seconds}
            label={token.label}
            source={resolveCitationSource?.(token.sourceVodRef)?.label}
            onActivate={(matchId, seconds) => onActivateCitation?.(matchId, seconds)}
          />,
        );
      } else {
        // Failed the shared package's own bounded-field validation — never
        // trusted; falls back to the plain literal text (safe, never a crash).
        nodes.push(citationSpan);
      }
    } else if (boldInner !== undefined) {
      nodes.push(<strong key={key}>{boldInner}</strong>);
    } else if (italicInner !== undefined) {
      nodes.push(<em key={key}>{italicInner}</em>);
    } else {
      nodes.push(full);
    }

    cursor = match.index + full!.length;
    // A zero-length match would infinite-loop a global-regex `exec` — not
    // reachable with this grammar (every alternative consumes at least one
    // character), but guarded defensively.
    if (full!.length === 0) {
      INLINE_TOKEN_PATTERN.lastIndex += 1;
    }
  }

  if (cursor < raw.length) {
    nodes.push(raw.slice(cursor));
  }
  return nodes;
}

/**
 * Renders `body` (a review section or private-notes value) through the
 * fixed safe-Markdown grammar. Renders nothing (`null`) for an empty/
 * whitespace-only body.
 */
export function SafeMarkdown({
  body,
  onActivateCitation,
  resolveCitationSource,
}: SafeMarkdownProps) {
  const truncated =
    body.length > SAFE_MARKDOWN_DOC_MAX_LENGTH ? body.slice(0, SAFE_MARKDOWN_DOC_MAX_LENGTH) : body;
  const blocks = splitBlocks(truncated);

  if (blocks.length === 0) {
    return null;
  }

  return (
    <div className="flex flex-col gap-2 text-sm">
      {blocks.map((block, blockIndex) => {
        const keyPrefix = `block-${blockIndex}`;

        if (block.kind === 'heading') {
          const levelIndex = Math.min((block.level ?? 1) - 1, HEADING_TAGS.length - 1);
          const HeadingTag = HEADING_TAGS[levelIndex]!;
          return (
            <HeadingTag key={keyPrefix} className={HEADING_CLASSES[levelIndex]}>
              {renderInline(block.lines[0]!, keyPrefix, onActivateCitation, resolveCitationSource)}
            </HeadingTag>
          );
        }

        if (block.kind === 'list') {
          const ListTag = block.ordered ? 'ol' : 'ul';
          return (
            <ListTag
              key={keyPrefix}
              className={block.ordered ? 'list-decimal pl-5' : 'list-disc pl-5'}
            >
              {block.lines.map((line, itemIndex) => (
                <li key={`${keyPrefix}-item-${itemIndex}`}>
                  {renderInline(
                    line,
                    `${keyPrefix}-${itemIndex}`,
                    onActivateCitation,
                    resolveCitationSource,
                  )}
                </li>
              ))}
            </ListTag>
          );
        }

        return (
          <p key={keyPrefix}>
            {block.lines.map((line, lineIndex) => (
              <Fragment key={`${keyPrefix}-line-${lineIndex}`}>
                {lineIndex > 0 && <br />}
                {renderInline(
                  line,
                  `${keyPrefix}-${lineIndex}`,
                  onActivateCitation,
                  resolveCitationSource,
                )}
              </Fragment>
            ))}
          </p>
        );
      })}
    </div>
  );
}
