import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { TIER_WORDS, tierLevel, type TierBasis } from '@smash-tracker/shared';
import { TooltipProvider } from '@/components/ui/tooltip';
import { TierBadge } from './TierBadge';

/**
 * UI-SPEC §13 G3 (owner note 8: "an estimate never looks like a recorded
 * fact"): for EVERY (tier, basis) pair the badge carries `data-tier`,
 * `data-basis`, `data-variant`; an estimate or an unknown is never `secondary`
 * and a manual or recorded tier is never `outline`; `unknown` draws no glyph;
 * and a `--tier-*` colour appears only as a glyph `rect` fill, never as text,
 * background or border. The validator below is the oracle, and the negative
 * controls prove it rejects the exact defects the rule exists to catch.
 */

const BASES: TierBasis[] = ['manual', 'recorded', 'estimated', 'unknown'];

const TIER_TOKEN_IN_STYLE = /--(color-)?tier-[1-5]/;
const TIER_UTILITY_IN_CLASS =
  /(^|[\s:!-])(text|bg|border|ring|fill|stroke|outline|from|to|via)-tier-[1-5]\b|\btier-[1-5]\b/;

/** Every violation a rendered badge node has against G3. Empty means the node is clean. */
function badgeViolations(badge: Element): string[] {
  const violations: string[] = [];
  const basis = badge.getAttribute('data-basis');
  const tier = badge.getAttribute('data-tier');
  const variant = badge.getAttribute('data-variant');

  if (!tier || !basis || !variant) {
    violations.push('missing data-tier / data-basis / data-variant');
    return violations;
  }
  if ((basis === 'estimated' || basis === 'unknown') && variant !== 'outline') {
    violations.push(`${basis} badge is ${variant}, expected outline`);
  }
  if ((basis === 'manual' || basis === 'recorded') && variant !== 'secondary') {
    violations.push(`${basis} badge is ${variant}, expected secondary`);
  }

  const glyphs = badge.querySelectorAll('svg[data-slot="tier-glyph"]');
  const rects = badge.querySelectorAll('rect');
  if (tier === 'unknown' && (glyphs.length > 0 || rects.length > 0)) {
    violations.push('unknown tier draws a glyph');
  }

  const scan = [badge, ...badge.querySelectorAll('*')];
  for (const element of scan) {
    const isGlyphRect = element.tagName.toLowerCase() === 'rect';
    const attributes = [
      element.getAttribute('class') ?? '',
      element.getAttribute('style') ?? '',
      element.getAttribute('fill') ?? '',
      element.getAttribute('stroke') ?? '',
    ];
    const [classAttr, styleAttr, fillAttr, strokeAttr] = attributes as [
      string,
      string,
      string,
      string,
    ];
    if (TIER_UTILITY_IN_CLASS.test(classAttr)) {
      violations.push(`${element.tagName} class names a tier colour: ${classAttr}`);
    }
    if (TIER_TOKEN_IN_STYLE.test(styleAttr)) {
      violations.push(`${element.tagName} style names a tier colour: ${styleAttr}`);
    }
    if (TIER_TOKEN_IN_STYLE.test(strokeAttr)) {
      violations.push(`${element.tagName} stroke names a tier colour`);
    }
    if (TIER_TOKEN_IN_STYLE.test(fillAttr) && !isGlyphRect) {
      violations.push(`${element.tagName} (not a glyph rect) fill names a tier colour`);
    }
  }
  return violations;
}

/** A hand-built badge node, for the negative controls. */
function syntheticBadge(attributes: Record<string, string>, innerHtml = ''): Element {
  const node = document.createElement('span');
  for (const [name, value] of Object.entries(attributes)) {
    node.setAttribute(name, value);
  }
  node.innerHTML = innerHtml;
  document.body.appendChild(node);
  return node;
}

function renderBadge(tier: (typeof TIER_WORDS)[number], basis: TierBasis) {
  const { container } = render(
    <TooltipProvider>
      <TierBadge tier={tier} basis={basis} provenance="How this tier was established" />
    </TooltipProvider>,
  );
  return container.querySelector('[data-slot="tier-badge"]') as HTMLElement;
}

describe('TierBadge (G3: estimate never solid)', () => {
  it('covers the full matrix (non-vacuity: six tier words times four bases)', () => {
    expect(TIER_WORDS).toHaveLength(6);
    expect(BASES).toHaveLength(4);
  });

  for (const tier of TIER_WORDS) {
    for (const basis of BASES) {
      it(`${tier} / ${basis}: variant, glyph and colour rules hold`, () => {
        const badge = renderBadge(tier, basis);
        expect(badge).not.toBeNull();
        expect(badge.getAttribute('data-tier')).toBe(tier);
        expect(badge.getAttribute('data-basis')).toBe(basis);
        expect(badgeViolations(badge)).toEqual([]);

        const expectedVariant =
          basis === 'manual' || basis === 'recorded' ? 'secondary' : 'outline';
        expect(badge.getAttribute('data-variant')).toBe(expectedVariant);

        const rects = badge.querySelectorAll('rect');
        if (tier === 'unknown') {
          expect(rects).toHaveLength(0);
        } else {
          // Five bars; exactly `level` are filled with THIS level's tier colour, the rest a neutral track.
          const level = tierLevel(tier);
          expect(rects).toHaveLength(5);
          const filled = [...rects].filter((rect) => rect.getAttribute('data-filled') === 'true');
          expect(filled).toHaveLength(level);
          for (const rect of filled) {
            expect(rect.getAttribute('fill')).toBe(`var(--tier-${level})`);
          }
          for (const rect of [...rects].filter((r) => r.getAttribute('data-filled') === 'false')) {
            expect(rect.getAttribute('fill')).toBe('var(--viz-context-strong)');
          }
        }
      });
    }
  }

  it('the glyph is decoration: aria-hidden, and the badge text is exactly the tier word', () => {
    const badge = renderBadge('major', 'manual');
    expect(badge.querySelector('svg')?.getAttribute('aria-hidden')).toBe('true');
    expect(badge.textContent).toBe('Major');
  });

  it('an unknown tier reads "Tier unknown", muted, never styled like local', () => {
    const badge = renderBadge('unknown', 'unknown');
    expect(badge.textContent).toBe('Tier unknown');
    expect(badge.className).toContain('text-muted-foreground');
    const local = renderBadge('local', 'estimated');
    expect(local.textContent).not.toBe(badge.textContent);
  });

  it('the tooltip repeats the word and the provenance, and only an estimate carries the caveat', async () => {
    const user = userEvent.setup();
    const { unmount } = render(
      <TooltipProvider>
        <TierBadge tier="major" basis="estimated" provenance="Estimated from 600 entrants" />
      </TooltipProvider>,
    );
    await user.hover(document.querySelector('[data-slot="tier-badge"]') as HTMLElement);
    expect((await screen.findAllByText('Estimated from 600 entrants')).length).toBeGreaterThan(0);
    expect(
      screen.getAllByText(
        'An estimate from entrant count — it may under-rate an event, never the reverse.',
      ).length,
    ).toBeGreaterThan(0);
    unmount();

    render(
      <TooltipProvider>
        <TierBadge tier="major" basis="manual" provenance="Set manually" />
      </TooltipProvider>,
    );
    await user.hover(document.querySelector('[data-slot="tier-badge"]') as HTMLElement);
    expect((await screen.findAllByText('Set manually')).length).toBeGreaterThan(0);
    expect(
      screen.queryByText(
        'An estimate from entrant count — it may under-rate an event, never the reverse.',
      ),
    ).not.toBeInTheDocument();
  });

  describe('negative controls: the validator rejects each defect the rule exists to catch', () => {
    it('rejects an estimate forced to secondary (the named failing case)', () => {
      const node = syntheticBadge({
        'data-tier': 'major',
        'data-basis': 'estimated',
        'data-variant': 'secondary',
      });
      expect(badgeViolations(node)).toContain('estimated badge is secondary, expected outline');
    });

    it('rejects an unknown forced to secondary', () => {
      const node = syntheticBadge({
        'data-tier': 'unknown',
        'data-basis': 'unknown',
        'data-variant': 'secondary',
      });
      expect(badgeViolations(node).length).toBeGreaterThan(0);
    });

    it('rejects a manual or recorded tier drawn outlined', () => {
      for (const basis of ['manual', 'recorded']) {
        const node = syntheticBadge({
          'data-tier': 'major',
          'data-basis': basis,
          'data-variant': 'outline',
        });
        expect(badgeViolations(node)).toContain(`${basis} badge is outline, expected secondary`);
      }
    });

    it('rejects an unknown tier that draws a glyph', () => {
      const node = syntheticBadge(
        { 'data-tier': 'unknown', 'data-basis': 'unknown', 'data-variant': 'outline' },
        '<svg data-slot="tier-glyph"><rect fill="var(--tier-3)"></rect></svg>',
      );
      expect(badgeViolations(node)).toContain('unknown tier draws a glyph');
    });

    it('rejects a tier colour on text, background or border, by utility class or by inline style', () => {
      const base = { 'data-tier': 'major', 'data-basis': 'estimated', 'data-variant': 'outline' };
      for (const klass of ['text-tier-4', 'bg-tier-4', 'border-tier-4', 'fill-tier-2']) {
        const node = syntheticBadge({ ...base, class: klass });
        expect(badgeViolations(node).length, klass).toBeGreaterThan(0);
      }
      const styled = syntheticBadge({ ...base, style: 'color: var(--tier-4)' });
      expect(badgeViolations(styled).length).toBeGreaterThan(0);
      const aliasStyled = syntheticBadge({ ...base, style: 'background: var(--color-tier-4)' });
      expect(badgeViolations(aliasStyled).length).toBeGreaterThan(0);
    });

    it('rejects a tier fill on an element that is not a glyph rect', () => {
      const node = syntheticBadge(
        { 'data-tier': 'major', 'data-basis': 'estimated', 'data-variant': 'outline' },
        '<svg><circle fill="var(--tier-4)"></circle></svg>',
      );
      expect(badgeViolations(node).length).toBeGreaterThan(0);
    });

    it('rejects a badge missing its oracle attributes', () => {
      expect(badgeViolations(syntheticBadge({ 'data-tier': 'major' }))).toContain(
        'missing data-tier / data-basis / data-variant',
      );
    });

    it('accepts a clean glyph rect fill (the validator does not over-reject)', () => {
      const node = syntheticBadge(
        { 'data-tier': 'major', 'data-basis': 'manual', 'data-variant': 'secondary' },
        '<svg data-slot="tier-glyph"><rect fill="var(--tier-4)"></rect></svg>',
      );
      expect(badgeViolations(node)).toEqual([]);
    });
  });
});
