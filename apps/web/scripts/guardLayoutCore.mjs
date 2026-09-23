/**
 * Layout-oracle PURE core (Phase 39.1 Plan 09, UIX-01/UIX-03/UIX-06): the
 * measurement-to-violation logic, separated from the Puppeteer/Vite
 * orchestration in `guardLayout.mjs` so it is unit-testable without a
 * browser — the same "pure core plus a thin runner" split
 * `scl01BrowserBudget.mjs`/`scl01BrowserBudgetCore.mjs` already use.
 *
 * Every `evaluate*` function takes MEASUREMENTS (plain data the runner reads
 * out of a real page via Puppeteer) and returns a LIST of violations, never
 * a boolean and never only the first violation — UI-SPEC §13.1's oracle must
 * report every offender it finds, not stop at the first.
 */

/** UI-SPEC §13.1: a card taller than its content by more than this many px is a stretch violation. */
export const STRETCH_TOLERANCE_PX = 24;

/** UI-SPEC §6.3: total page height budget, in viewport heights, per viewport. */
export const SCROLL_BUDGET_2560X1440 = 3;
export const SCROLL_BUDGET_1440X900 = 5;

/** UI-SPEC §13.1's three named viewports, in the order the runner measures them. */
export const LAYOUT_ORACLE_VIEWPORTS = [
  { name: '2560x1440', width: 2560, height: 1440 },
  { name: '1440x900', width: 1440, height: 900 },
  { name: '390x844', width: 390, height: 844 },
];

/**
 * Plan 39.1-30: the two extra viewports Matchups opts into so the harness's
 * MainLayout-geometry app shell (`GuardAppShell.tsx`) is measured at the
 * exact tiers UI-SPEC §6.6 names — 1024x768 (the 1024-1279 tier) and 1280x800
 * (the narrowest >=1280 rail width) — never measured for any other route.
 */
export const EXTRA_ORACLE_VIEWPORTS = {
  '1024x768': { name: '1024x768', width: 1024, height: 768 },
  '1280x800': { name: '1280x800', width: 1280, height: 800 },
};

/** UI-SPEC §6.1 "No orphan half": a side-by-side item shorter than this fraction of its taller sibling is an orphan half. */
export const ORPHAN_HALF_MIN_RATIO = 0.5;

/** UI-SPEC §6.5 rule 1 (header-squeeze family): a header title/description narrower than this fraction of its header's content width, while wrapping, is squeezed. */
export const HEADER_SQUEEZE_MIN_SHARE = 0.5;

/** The minimum legible gap (px) between two adjacent x-axis tick labels before they are considered overlapping. */
export const MIN_TICK_GAP_PX = 4;

/**
 * UI-SPEC §13.1's stretch condition:
 * `card.height − (lastChild.bottom − card.top + paddingBottom) > 24px`.
 * Each `card` is `{ selectorPath, height, lastChildBottom, top, paddingBottom }`.
 */
export function evaluateStretch(cards, tolerancePx = STRETCH_TOLERANCE_PX) {
  const violations = [];
  for (const card of cards) {
    const { selectorPath, height, lastChildBottom, top, paddingBottom } = card;
    const contentHeight = lastChildBottom - top + paddingBottom;
    const overflow = height - contentHeight;
    if (overflow > tolerancePx) {
      violations.push({
        type: 'stretch',
        selectorPath,
        height,
        contentHeight,
        overflow,
      });
    }
  }
  return violations;
}

/**
 * UI-SPEC §6.3's scroll budget: `scrollHeight / innerHeight` must not exceed
 * 3 at 2560×1440 or 5 at 1440×900. The 390×844 viewport carries no scroll
 * budget (only the horizontal-overflow check applies there) — a viewport
 * name with no entry in `budgets` is silently exempt.
 */
export function evaluateScrollBudget(
  { scrollHeight, innerHeight, viewportName },
  budgets = { '2560x1440': SCROLL_BUDGET_2560X1440, '1440x900': SCROLL_BUDGET_1440X900 },
) {
  const budget = budgets[viewportName];
  if (budget === undefined) {
    return [];
  }
  const ratio = scrollHeight / innerHeight;
  if (ratio > budget) {
    return [{ type: 'scroll-budget', viewportName, ratio, budget }];
  }
  return [];
}

/** UI-SPEC §6.3: no horizontal page scroll at any viewport (390px is where it actually bites). */
export function evaluateHorizontalOverflow({ scrollWidth, innerWidth }) {
  if (scrollWidth > innerWidth) {
    return [{ type: 'horizontal-overflow', scrollWidth, innerWidth }];
  }
  return [];
}

/**
 * UI-SPEC §6.5 rule 6: an element carrying the truncation-guard attribute
 * (`data-truncate-guard`) must have `scrollWidth ≤ clientWidth` OR a `title`
 * attribute with the full string. Each `element` is
 * `{ selectorPath, scrollWidth, clientWidth, hasTitle }`.
 */
export function evaluateTruncation(elements) {
  const violations = [];
  for (const element of elements) {
    const { selectorPath, scrollWidth, clientWidth, hasTitle } = element;
    if (scrollWidth > clientWidth && !hasTitle) {
      violations.push({ type: 'truncation', selectorPath, scrollWidth, clientWidth });
    }
  }
  return violations;
}

// ---------------------------------------------------------------------------
// Plan 39.1-30: the four Matchups gap-closure oracle families
// (content-overflow, header-squeeze, axis-ticks, grid-balance). Every
// evaluator returns a LIST of ALL offenders, never a boolean and never only
// the first — same discipline as the four evaluators above.
// ---------------------------------------------------------------------------

/**
 * UI-SPEC §6.5: a card whose descendant extends past the card's own inner
 * horizontal edges (excluding descendants inside a horizontal scroll/clip
 * container, and SVG internals — the collector in `guardLayout.mjs` already
 * excludes those from `offenders`). Each `card` is
 * `{ selectorPath, innerLeft, innerRight, offenders: [{ selectorPath, left, right }] }`.
 */
export function evaluateCardContentOverflow(cards, tolerancePx = 1) {
  const violations = [];
  for (const card of cards) {
    const { selectorPath, innerLeft, innerRight, offenders } = card;
    for (const offender of offenders) {
      const { left, right } = offender;
      const overflowLeft = innerLeft - left;
      const overflowRight = right - innerRight;
      const overflowPx = Math.max(overflowLeft, overflowRight);
      if (left < innerLeft - tolerancePx || right > innerRight + tolerancePx) {
        violations.push({
          type: 'content-overflow',
          selectorPath,
          offender: offender.selectorPath,
          overflowPx,
        });
      }
    }
  }
  return violations;
}

/**
 * UI-SPEC §6.5: a card-header title/description narrower than
 * `minShare` of the header's own content width WHILE wrapping onto 2+ lines
 * (a single-line short string is never squeezed, even if it's narrow — that's
 * just short text). Each `header` is
 * `{ selectorPath, contentWidth, parts: [{ role, width, height, lineHeight }] }`.
 */
export function evaluateHeaderSqueeze(headers, minShare = HEADER_SQUEEZE_MIN_SHARE) {
  const violations = [];
  for (const header of headers) {
    const { selectorPath, contentWidth, parts } = header;
    for (const part of parts) {
      const { role, width, height, lineHeight } = part;
      const lines = lineHeight > 0 ? Math.round(height / lineHeight) : 1;
      if (width < minShare * contentWidth && lines >= 2) {
        violations.push({ type: 'header-squeeze', selectorPath, role, width, contentWidth, lines });
      }
    }
  }
  return violations;
}

/**
 * UI-SPEC §7.13/§11: x-axis tick clipping, tick-label overlap, a value label
 * or period dot colliding with a tick or axis line. Each `surface` is
 * `{ selectorPath, rect, xTicks: [{ left, right, top, bottom, text }], yTicks: [...],
 * valueLabels: [...], dots: [...], xAxisLine: rect|null, yAxisLine: rect|null }`.
 * Rect intersection is a standard AABB overlap test (both axes must overlap).
 */
function rectsIntersect(a, b, expandPx = 0) {
  const aLeft = a.left - expandPx;
  const aRight = a.right + expandPx;
  const aTop = a.top - expandPx;
  const aBottom = a.bottom + expandPx;
  return aLeft < b.right && aRight > b.left && aTop < b.bottom && aBottom > b.top;
}

export function evaluateAxisTicks(surfaces, minGapPx = MIN_TICK_GAP_PX) {
  const violations = [];
  for (const surface of surfaces) {
    const { selectorPath, rect, xTicks, yTicks, valueLabels, dots, xAxisLine, yAxisLine } = surface;

    for (const tick of xTicks) {
      if (tick.left < rect.left - 0.5 || tick.right > rect.right + 0.5) {
        violations.push({ type: 'tick-clipped', selectorPath, tick: tick.text });
      }
    }

    const sortedXTicks = [...xTicks].sort((a, b) => a.left - b.left);
    for (let i = 1; i < sortedXTicks.length; i += 1) {
      const prev = sortedXTicks[i - 1];
      const next = sortedXTicks[i];
      const gap = next.left - prev.right;
      if (gap < minGapPx) {
        violations.push({
          type: 'tick-overlap',
          selectorPath,
          a: prev.text,
          b: next.text,
          gap,
        });
      }
    }

    const allTicks = [...xTicks, ...yTicks];
    for (const label of valueLabels) {
      for (const tick of allTicks) {
        if (rectsIntersect(label, tick)) {
          violations.push({
            type: 'value-label-collision',
            selectorPath,
            label: label.text,
            tick: tick.text,
          });
          break;
        }
      }
    }

    const axisLines = [xAxisLine, yAxisLine].filter((line) => line != null);
    for (const dot of dots) {
      for (const line of axisLines) {
        if (rectsIntersect(dot, line, 0.5)) {
          violations.push({ type: 'mark-on-axis', selectorPath, dot: dot.selectorPath });
          break;
        }
      }
    }
  }
  return violations;
}

/**
 * Non-vacuity check for the axis-ticks family: a route opted into the family
 * whose collected `surfaces` carry NO x tick anywhere fails with
 * `axis-unmeasured` — a selector or structure drift must fail loudly rather
 * than silently reporting zero violations.
 */
export function evaluateAxisPresence(surfaces) {
  const hasAnyXTick = surfaces.some((surface) => surface.xTicks.length > 0);
  if (!hasAnyXTick) {
    return [{ type: 'axis-unmeasured' }];
  }
  return [];
}

/**
 * UI-SPEC §6.1 "No orphan half" + dead-gap: `orphan-half` when two
 * horizontally-non-overlapping items at (nearly) the same top have a
 * height ratio under `minHeightRatio`; `dead-gap` when the vertical space
 * between a horizontally-overlapping item and the nearest item below it
 * exceeds the grid's own row-gap plus `deadGapTolerancePx`. Each `grid` is
 * `{ selectorPath, rowGapPx, items: [{ selectorPath, left, right, top, bottom }] }`
 * (card-bearing direct children only — the collector filters).
 */
export function evaluateGridBalance(
  grids,
  { minHeightRatio = ORPHAN_HALF_MIN_RATIO, deadGapTolerancePx = STRETCH_TOLERANCE_PX } = {},
) {
  const violations = [];
  for (const grid of grids) {
    const { selectorPath, rowGapPx, items } = grid;

    for (let i = 0; i < items.length; i += 1) {
      for (let j = i + 1; j < items.length; j += 1) {
        const a = items[i];
        const b = items[j];
        const sameRow = Math.abs(a.top - b.top) <= 2;
        const horizontallyOverlap = a.left < b.right && b.left < a.right;
        if (!sameRow || horizontallyOverlap) continue;
        const aHeight = a.bottom - a.top;
        const bHeight = b.bottom - b.top;
        const ratio = Math.min(aHeight, bHeight) / Math.max(aHeight, bHeight);
        if (ratio < minHeightRatio) {
          violations.push({
            type: 'orphan-half',
            selectorPath,
            a: a.selectorPath,
            b: b.selectorPath,
            ratio,
          });
        }
      }
    }

    for (const item of items) {
      let nearestBelow;
      for (const other of items) {
        if (other === item) continue;
        const horizontallyOverlap = item.left < other.right && other.left < item.right;
        const overlapPx = Math.min(item.right, other.right) - Math.max(item.left, other.left);
        if (!horizontallyOverlap || overlapPx <= 1) continue;
        if (other.top < item.bottom - 1) continue; // not below
        if (!nearestBelow || other.top < nearestBelow.top) {
          nearestBelow = other;
        }
      }
      if (!nearestBelow) continue;
      const gap = nearestBelow.top - item.bottom;
      if (gap > rowGapPx + deadGapTolerancePx) {
        violations.push({
          type: 'dead-gap',
          selectorPath,
          a: item.selectorPath,
          b: nearestBelow.selectorPath,
          gap,
        });
      }
    }
  }
  return violations;
}

/**
 * Non-vacuity check shared by three families (content-overflow,
 * header-squeeze, grid-balance): an opted-in route whose collector returned
 * an EMPTY list for that family (selectors never matched) fails loudly with
 * `<family>-unmeasured` instead of silently reporting zero violations.
 */
export function evaluateFamilyPresence(family, items) {
  if (items.length === 0) {
    return [{ type: `${family}-unmeasured` }];
  }
  return [];
}

// ---------------------------------------------------------------------------
// Plan 39.1-32: the four mobile gap-closure oracle families (picker-alignment,
// row-cohesion, row-tag-legibility, nested-scroll). Every evaluator returns a
// LIST of ALL offenders, never a boolean and never only the first — same
// discipline as every family above.
// ---------------------------------------------------------------------------

/** UI-SPEC §10.4/§6.6: the picker's two controls must align within this many px. */
export const PICKER_ALIGN_TOLERANCE_PX = 1;
/** UI-SPEC §10.4: the 'vs' element must be centred on the controls within this many px. */
export const VS_CENTER_TOLERANCE_PX = 2;
/** UI-SPEC §8.5/§6.5: sibling items in a fixed-columns row must share a top within this many px. */
export const ROW_COHESION_TOP_TOLERANCE_PX = 2;
/** UI-SPEC §6.5 rule 1: a tag owning at least this share of its row's content width may legitimately truncate (with its title). */
export const TAG_MIN_ROW_SHARE = 0.6;
/** UI-SPEC §6.6 "below 640" — the widest viewport the narrow-only families (row-tag-legibility, nested-scroll) are evaluated at. */
export const NARROW_VIEWPORT_MAX_WIDTH_PX = 639;

/**
 * UI-SPEC §10.4 (one filter row), §6.6 (below-640 single column / 640+ 2-up):
 * a two-control picker (fighter/opponent select, with a 'vs' element between
 * them) must have equal-width controls, labels flush with their own control's
 * left edge, and a 'vs' element correctly placed for whichever layout the
 * picker is currently in (stacked below 640px, 2-up from 640px — detected
 * from the controls' own top positions, never from viewport width, so the
 * evaluator has no knowledge of breakpoints). Each `picker` is
 * `{ selectorPath, controls: [rect, rect], labels: [rect, rect], vs: rect }`.
 */
export function evaluatePickerAlignment(
  pickers,
  { tolerancePx = PICKER_ALIGN_TOLERANCE_PX, vsCenterTolerancePx = VS_CENTER_TOLERANCE_PX } = {},
) {
  const violations = [];
  for (const picker of pickers) {
    const { selectorPath, controls, labels, vs } = picker;
    const [control0, control1] = controls;
    const [, label1] = labels;

    const width0 = control0.right - control0.left;
    const width1 = control1.right - control1.left;
    if (Math.abs(width0 - width1) > tolerancePx) {
      violations.push({ type: 'picker-control-width', selectorPath, width0, width1 });
    }

    labels.forEach((label, index) => {
      const control = controls[index];
      if (Math.abs(label.left - control.left) > tolerancePx) {
        violations.push({
          type: 'picker-label-offset',
          selectorPath,
          index,
          labelLeft: label.left,
          controlLeft: control.left,
        });
      }
    });

    const stacked = Math.abs(control0.top - control1.top) > tolerancePx;
    if (stacked) {
      if (Math.abs(control0.left - control1.left) > tolerancePx) {
        violations.push({
          type: 'picker-control-offset',
          selectorPath,
          left0: control0.left,
          left1: control1.left,
        });
      }
      const control0CenterX = (control0.left + control0.right) / 2;
      const vsCenterX = (vs.left + vs.right) / 2;
      const positioned =
        vs.top >= control0.bottom - tolerancePx &&
        vs.bottom <= label1.top + tolerancePx &&
        Math.abs(vsCenterX - control0CenterX) <= vsCenterTolerancePx;
      if (!positioned) {
        violations.push({ type: 'picker-vs-misplaced', selectorPath, layout: 'stacked' });
      }
    } else {
      const vsCenterY = (vs.top + vs.bottom) / 2;
      const positioned =
        vs.left >= control0.right - tolerancePx &&
        vs.right <= control1.left + tolerancePx &&
        vsCenterY >= control0.top &&
        vsCenterY <= control0.bottom;
      if (!positioned) {
        violations.push({ type: 'picker-vs-misplaced', selectorPath, layout: '2-up' });
      }
    }
  }
  return violations;
}

/**
 * UI-SPEC §8.5/§6.5: a fixed-columns row's items must share a top (never
 * wrap onto separate lines) and never overflow their own column. Each `row`
 * is `{ selectorPath, items: [{ selectorPath, top, scrollWidth, clientWidth }] }`.
 */
export function evaluateRowCohesion(rows, topTolerancePx = ROW_COHESION_TOP_TOLERANCE_PX) {
  const violations = [];
  for (const row of rows) {
    const { selectorPath, items } = row;
    if (items.length === 0) continue;
    const firstTop = items[0].top;
    const wrapped = items.some((item) => Math.abs(item.top - firstTop) > topTolerancePx);
    if (wrapped) {
      violations.push({ type: 'row-wrapped', selectorPath });
    }
    for (const item of items) {
      if (item.scrollWidth > item.clientWidth + 1) {
        violations.push({ type: 'row-item-overflow', selectorPath: item.selectorPath });
      }
    }
  }
  return violations;
}

/**
 * UI-SPEC §6.5 rule 1: a tag squeezed onto less than `minShare` of its row's
 * content width, while also overflowing, is truncated illegibly — a tag that
 * already owns most of its row (its title still supplies the full text) may
 * legitimately truncate. Each `tag` is
 * `{ selectorPath, text, scrollWidth, clientWidth, rowContentWidth }`.
 */
export function evaluateRowTagLegibility(tags, minShare = TAG_MIN_ROW_SHARE) {
  const violations = [];
  for (const tag of tags) {
    const { selectorPath, text, scrollWidth, clientWidth, rowContentWidth } = tag;
    if (scrollWidth > clientWidth + 1 && clientWidth < minShare * rowContentWidth) {
      violations.push({
        type: 'tag-truncated',
        selectorPath,
        text,
        scrollWidth,
        clientWidth,
        rowContentWidth,
      });
    }
  }
  return violations;
}

/**
 * UI-SPEC §6.4: a nested vertical scroller (an element that scrolls its own
 * content, inside the page's own scroll) is banned below 640px. Each
 * `scroller` is `{ selectorPath, overflowY, scrollHeight, clientHeight }`.
 * A horizontal-only scroller (e.g. a `table-container`, whose computed
 * `overflow-y` is `auto` too) is exempt by construction because it is judged
 * ONLY on `scrollHeight` exceeding `clientHeight` — never on `overflowY`
 * alone — so a wide-but-not-tall element never fires this family.
 */
export function evaluateNestedScrollers(scrollers) {
  const violations = [];
  for (const scroller of scrollers) {
    const { selectorPath, overflowY, scrollHeight, clientHeight } = scroller;
    if ((overflowY === 'auto' || overflowY === 'scroll') && scrollHeight > clientHeight + 1) {
      violations.push({
        type: 'nested-vertical-scroller',
        selectorPath,
        overflowY,
        scrollHeight,
        clientHeight,
      });
    }
  }
  return violations;
}
