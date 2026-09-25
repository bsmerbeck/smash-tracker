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

/**
 * Plan 39.1-33: the default per-viewport scroll-budget map `evaluateScrollBudget`
 * uses when a caller passes none — exported so a route can merge its OWN
 * per-viewport budgets over these defaults (`{ ...DEFAULT_SCROLL_BUDGETS,
 * ...route.scrollBudgets }`) instead of the runner silently exempting every
 * viewport this map has no entry for (see `evaluateScrollBudget`'s doc
 * comment — that silent exemption is exactly why the 390x844 regression this
 * plan closes went unmeasured for plans 30-32).
 */
export const DEFAULT_SCROLL_BUDGETS = {
  '2560x1440': SCROLL_BUDGET_2560X1440,
  '1440x900': SCROLL_BUDGET_1440X900,
};

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
 * Plan 39.1-37 (design-audit item 5): tick text that is a raw engine key —
 * anything carrying `::` (the event-anchor key separator, e.g.
 * `session::1700000000000`) or an ISO-8601 timestamp
 * (`2023-11-15T19:30:20.000Z`). An identifier on an axis is never a label.
 */
export const RAW_AXIS_KEY_PATTERN = /::|\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/;

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
 * 3 at 2560×1440 or 5 at 1440×900. A viewport name with no entry in `budgets`
 * is silently exempt — UI-SPEC §6.3 deliberately sets no 390px budget, and
 * plan 39.1-30/31/32's runner never passed a `budgets` argument, so Matchups'
 * 390x844 (and its 1024x768/1280x800 extras) had NO enforced scroll budget:
 * plan 32's final gate printed `MEASUREMENT route=matchups viewport=390x844
 * ... scrollRatio=13.793` and nothing failed on it. Plan 39.1-33 closes this
 * by letting a route declare its OWN per-viewport budgets, merged over
 * `DEFAULT_SCROLL_BUDGETS` (see `MATCHUPS_SCROLL_BUDGET_390X844` below) —
 * every other route/viewport combination stays exempt exactly as before.
 */
export function evaluateScrollBudget(
  { scrollHeight, innerHeight, viewportName },
  budgets = DEFAULT_SCROLL_BUDGETS,
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
 * or period dot colliding with a tick or axis line, and (plan 39.1-37,
 * design-audit items 5 and 10) a raw engine key as tick text, value labels
 * overprinting one another, and the all-time reference label overprinting a
 * value label. Each `surface` is
 * `{ selectorPath, rect, xTicks: [{ left, right, top, bottom, text }], yTicks: [...],
 * valueLabels: [...], dots: [...], referenceLabels?: [...], xAxisLine: rect|null,
 * yAxisLine: rect|null }`.
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

    for (const tick of [...xTicks, ...yTicks]) {
      if (RAW_AXIS_KEY_PATTERN.test(tick.text)) {
        violations.push({ type: 'raw-axis-key', selectorPath, tick: tick.text });
      }
    }

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

    for (let i = 0; i < valueLabels.length; i += 1) {
      for (let j = i + 1; j < valueLabels.length; j += 1) {
        if (rectsIntersect(valueLabels[i], valueLabels[j])) {
          violations.push({
            type: 'value-label-overlap',
            selectorPath,
            a: valueLabels[i].text,
            b: valueLabels[j].text,
          });
        }
      }
    }

    for (const reference of surface.referenceLabels ?? []) {
      for (const label of valueLabels) {
        if (rectsIntersect(label, reference)) {
          violations.push({
            type: 'reference-label-collision',
            selectorPath,
            label: label.text,
            reference: reference.text,
          });
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

/** Plan 39.1-37 (UI-SPEC §6.1): a trend plot is never wider than 4 : 1. */
export const PLOT_ASPECT_MAX = 4;
/** UI-SPEC §6.1's 8 + 4 rule applies from the lg breakpoint; narrower viewports stack every cell at 12. */
export const PLOT_ASPECT_MIN_VIEWPORT_WIDTH_PX = 1024;
/**
 * UI-SPEC §6.1's signed-off exemption (D-12): the hero's compact trend
 * (`CHART_H_COMPACT`, 160px) is exempt — any plot at or under 160 + 8px tall.
 */
export const PLOT_ASPECT_COMPACT_EXEMPT_MAX_HEIGHT_PX = 168;

/**
 * Plan 39.1-37 (design-audit item 5, event-chart-aspect): every chart plot
 * surface (`svg.recharts-surface` inside a `[data-slot="card"]`) taller than
 * the compact exemption must be at most `PLOT_ASPECT_MAX` : 1 at viewports
 * `PLOT_ASPECT_MIN_VIEWPORT_WIDTH_PX` and wider. Each surface is
 * `{ selectorPath, width, height }`. An opted route with no surface at all is
 * `plot-aspect-unmeasured` (non-vacuity) at an evaluated viewport.
 */
export function evaluatePlotAspect({ viewportWidth, surfaces }) {
  if (viewportWidth < PLOT_ASPECT_MIN_VIEWPORT_WIDTH_PX) {
    return [];
  }
  if (surfaces.length === 0) {
    return [{ type: 'plot-aspect-unmeasured' }];
  }
  const violations = [];
  for (const surface of surfaces) {
    if (!(surface.height > PLOT_ASPECT_COMPACT_EXEMPT_MAX_HEIGHT_PX)) continue;
    const ratio = surface.width / surface.height;
    if (ratio > PLOT_ASPECT_MAX) {
      violations.push({
        type: 'plot-aspect',
        selectorPath: surface.selectorPath,
        width: surface.width,
        height: surface.height,
        ratio,
      });
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

// ---------------------------------------------------------------------------
// Plan 39.1-33: the Matchups phone scroll budget (above), the Win Rate Trend
// card ceiling and the single-row form-strip family. Both new evaluators
// return a LIST of ALL offenders, same discipline as every family above.
// ---------------------------------------------------------------------------

/**
 * Plan 39.1-33: a Matchups regression tripwire, not a design target —
 * UI-SPEC §6.3's own budgets and every other route are unchanged. Derived
 * from the measured projection of a single-row form strip + a 20-row phone
 * results page (7.127 viewport heights, ~6015px) plus ~0.37 (~315px, ~3.5
 * rows) of headroom: 5.611 at 9abcac76 and 6.063 after plan 31 both had the
 * list confined to the (now-banned) 500px nested scroller; 13.793 at
 * 494216ed with neither fix; 7.767 with only the form strip fixed; 13.153
 * with only the results list bounded. 7.5 sits below every single-regression
 * state and below a stacked cap drifting past ~23 rows.
 */
export const MATCHUPS_SCROLL_BUDGET_390X844 = 7.5;

/**
 * Plan 39.1-33: one phone screen — a card taller than the viewport can never
 * be seen whole. 1204px (1.427 viewport heights) on 494216ed fails by 360px;
 * the projected single-row-strip card (~664px, ~0.787) passes with ~180px
 * headroom.
 */
export const WIN_RATE_TREND_CARD_MAX_VIEWPORT_HEIGHTS = 1;

/** Plan 39.1-33: the FormStrip row's own set-top spread tolerance, px. */
export const FORM_STRIP_ROW_TOP_TOLERANCE_PX = 2;

/**
 * Plan 39.1-33: a card taller than `maxViewportHeights` viewport heights is a
 * ceiling violation; a card whose marker never resolved to an ancestor
 * `[data-slot="card"]` (height `null`) is `card-height-ceiling-unmeasured`
 * rather than silently passing. Each `card` is
 * `{ marker, selectorPath, height: number|null, maxViewportHeights }`.
 */
export function evaluateCardHeightCeilings({ innerHeight, cards }) {
  const violations = [];
  for (const card of cards) {
    const { marker, selectorPath, height, maxViewportHeights } = card;
    if (height == null) {
      violations.push({ type: 'card-height-ceiling-unmeasured', marker });
      continue;
    }
    const limitPx = maxViewportHeights * innerHeight;
    if (height > limitPx) {
      violations.push({
        type: 'card-height-ceiling',
        marker,
        selectorPath,
        height,
        limitPx,
        ratio: height / innerHeight,
      });
    }
  }
  return violations;
}

/**
 * UI-SPEC §7.10 as narrowed by plan 39.1-33 (one row, most recent sets that
 * fit): `form-strip-wrapped` when the row's own sets carry two or more
 * distinct tops spread by more than `FORM_STRIP_ROW_TOP_TOLERANCE_PX`;
 * `form-strip-overflow` when the row's own `scrollWidth` exceeds its
 * `clientWidth` by more than 1px (a strip that clips or scrolls its newest
 * ticks is not fitting). Each `strip` is
 * `{ selectorPath, setTops: number[], rowScrollWidth, rowClientWidth }`.
 */
export function evaluateFormStripFit(strips) {
  const violations = [];
  for (const strip of strips) {
    const { selectorPath, setTops, rowScrollWidth, rowClientWidth } = strip;
    if (setTops.length >= 2) {
      const spread = Math.max(...setTops) - Math.min(...setTops);
      if (spread > FORM_STRIP_ROW_TOP_TOLERANCE_PX) {
        violations.push({ type: 'form-strip-wrapped', selectorPath });
      }
    }
    if (rowScrollWidth > rowClientWidth + 1) {
      violations.push({ type: 'form-strip-overflow', selectorPath });
    }
  }
  return violations;
}

// ---------------------------------------------------------------------------
// Plan 39.1-34: the career-timeline family (UI-SPEC §11 mark bounds, §12.1
// the shared time axis, §13.1 real-Chrome oracle). This plain-Node module
// cannot import the TypeScript sources, so every constant below MIRRORS a
// named shared/kit constant — each doc comment names the one it mirrors.
// Every evaluator returns a LIST of ALL offenders, never a boolean.
// ---------------------------------------------------------------------------

/**
 * UI-SPEC §12.1 "two strips on the SAME time axis": a strip cell edge may sit
 * at most this many px from the rating line's own time-to-pixel mapping. The
 * kit draws each cell 0.5px inset on both sides, which this tolerance
 * absorbs with 1px to spare.
 */
export const CAREER_TIMELINE_ALIGN_TOLERANCE_PX = 1.5;

/**
 * The rating line's anchors must lie on ONE linear time axis: an anchor more
 * than this many px off the least-squares line of cx on t means the line and
 * the strips are not reading one scale.
 */
export const CAREER_TIMELINE_LINE_RESIDUAL_TOLERANCE_PX = 1;

/** UI-SPEC §11 line points — mirrors `MARK_BOUND_LINE_POINTS` (packages/shared/src/insight/markBounds.ts). */
export const CAREER_TIMELINE_LINE_POINT_BOUND = 60;

/** UI-SPEC §11 heat cells — mirrors `MARK_BOUND_HEAT_CELLS` (packages/shared/src/insight/markBounds.ts). */
export const CAREER_TIMELINE_STRIP_CELL_BOUND = 108;

/** UI-SPEC §12.1 narrow re-grain (108 / 3) — mirrors `CAREER_TIMELINE_NARROW_STRIP_CELLS` (packages/shared/src/insight/careerTimeline.ts). */
export const CAREER_TIMELINE_NARROW_STRIP_CELL_BOUND = 36;

/** UI-SPEC §11 "below a 520px plot" — mirrors `CHART_NARROW_PLOT_PX` (apps/web/src/components/charts/tokens.ts). */
export const CAREER_TIMELINE_NARROW_PLOT_PX = 520;

/** UI-SPEC §11 strip ticks (the thin account's per-game strip) — mirrors `MARK_BOUND_STRIP_TICKS`. */
export const CAREER_TIMELINE_FORM_STRIP_TICK_BOUND = 60;

/**
 * The least-squares line of anchor cx on t (UI-SPEC §12.1's one numeric time
 * axis), or `null` below two anchors / a zero time span. Returns
 * `{ x: (t) => px, maxResidualPx }`.
 */
export function fitCareerTimelineAxis(anchors) {
  if (anchors.length < 2) return null;
  const n = anchors.length;
  const meanT = anchors.reduce((sum, a) => sum + a.t, 0) / n;
  const meanX = anchors.reduce((sum, a) => sum + a.cx, 0) / n;
  let sTT = 0;
  let sTX = 0;
  for (const a of anchors) {
    sTT += (a.t - meanT) ** 2;
    sTX += (a.t - meanT) * (a.cx - meanX);
  }
  if (sTT === 0) return null;
  const slope = sTX / sTT;
  const intercept = meanX - slope * meanT;
  const x = (t) => intercept + slope * t;
  const residuals = anchors.map((a) => Math.abs(a.cx - x(a.t)));
  return { x, residuals, maxResidualPx: Math.max(...residuals) };
}

/**
 * Every strip cell's edge delta against the fitted axis — the SAME rule
 * `evaluateCareerTimeline`'s alignment check applies: a cell's expected left
 * is `max(plotLeft, x(startMs))` and its expected right
 * `min(plotRight, x(endMs))` (a cell straddling the domain is clipped to the
 * plot). Returns `[{ track, edge, deltaPx, startMs }]`, empty below two
 * anchors. Exported so the runner's TIMELINE line prints the same number the
 * evaluator judges.
 */
export function careerTimelineEdgeDeltas(timeline) {
  const fit = fitCareerTimelineAxis(timeline.anchors);
  if (!fit) return [];
  const deltas = [];
  for (const [track, cells] of [
    ['rate', timeline.rateCells],
    ['games', timeline.gamesCells],
  ]) {
    for (const cell of cells) {
      const expectedLeft = Math.max(timeline.plotLeft, fit.x(cell.startMs));
      const expectedRight = Math.min(timeline.plotRight, fit.x(cell.endMs));
      deltas.push({
        track,
        edge: 'left',
        deltaPx: Math.abs(cell.left - expectedLeft),
        startMs: cell.startMs,
      });
      deltas.push({
        track,
        edge: 'right',
        deltaPx: Math.abs(cell.right - expectedRight),
        startMs: cell.startMs,
      });
    }
  }
  return deltas;
}

/**
 * UI-SPEC §11 / §12.1 / §13.1: the career-timeline family. `timelines` is one
 * measurement per `[data-slot="career-timeline"]` root —
 * `{ selectorPath, state, plotLeft, plotRight, plotWidth, stripGrain,
 * anchors: [{ t, cx }], lineVertexCount, rateCells, gamesCells:
 * [{ startMs, endMs, left, right }], formStripTicks }` — and `canvasCount` is
 * the page's `canvas` element count (the retired chart.js pair drew two).
 * `expectation` is the route's own `timelineExpect`
 * (`{ strips?, formStrip?, state? }`). An empty `timelines` list is
 * `career-timeline-unmeasured` (never a silent pass).
 */
export function evaluateCareerTimeline({ timelines, canvasCount }, expectation = {}) {
  const violations = [...evaluateFamilyPresence('career-timeline', timelines)];
  if (canvasCount > 0) {
    violations.push({ type: 'career-timeline-legacy-canvas', count: canvasCount });
  }
  for (const timeline of timelines) {
    const { selectorPath, state, plotWidth, stripGrain, anchors, rateCells, gamesCells } = timeline;

    if (state === 'full' && anchors.length < 2) {
      violations.push({
        type: 'career-timeline-line-unmeasured',
        selectorPath,
        anchors: anchors.length,
      });
    }
    if (anchors.length > CAREER_TIMELINE_LINE_POINT_BOUND) {
      violations.push({
        type: 'career-timeline-line-points',
        selectorPath,
        measure: 'anchors',
        count: anchors.length,
      });
    }
    if (timeline.lineVertexCount > CAREER_TIMELINE_LINE_POINT_BOUND) {
      violations.push({
        type: 'career-timeline-line-points',
        selectorPath,
        measure: 'vertices',
        count: timeline.lineVertexCount,
      });
    }
    for (const [track, cells] of [
      ['rate', rateCells],
      ['games', gamesCells],
    ]) {
      if (cells.length > CAREER_TIMELINE_STRIP_CELL_BOUND) {
        violations.push({
          type: 'career-timeline-strip-cells',
          selectorPath,
          track,
          count: cells.length,
        });
      }
    }

    const hasStrips = rateCells.length > 0 || gamesCells.length > 0;
    if (hasStrips && plotWidth < CAREER_TIMELINE_NARROW_PLOT_PX) {
      if (stripGrain === 'month') {
        violations.push({
          type: 'career-timeline-narrow-grain',
          selectorPath,
          plotWidth,
          stripGrain,
        });
      }
      for (const [track, cells] of [
        ['rate', rateCells],
        ['games', gamesCells],
      ]) {
        if (cells.length > CAREER_TIMELINE_NARROW_STRIP_CELL_BOUND) {
          violations.push({
            type: 'career-timeline-narrow-grain',
            selectorPath,
            plotWidth,
            track,
            count: cells.length,
          });
        }
      }
    }

    if (hasStrips) {
      const gamesStarts = new Set(gamesCells.map((cell) => cell.startMs));
      const unpaired = rateCells.filter((cell) => !gamesStarts.has(cell.startMs));
      if (rateCells.length !== gamesCells.length || unpaired.length > 0) {
        violations.push({
          type: 'career-timeline-strip-pairing',
          selectorPath,
          rateCells: rateCells.length,
          gamesCells: gamesCells.length,
          unpaired: unpaired.map((cell) => cell.startMs),
        });
      }
    }

    const fit = fitCareerTimelineAxis(anchors);
    if (fit) {
      anchors.forEach((anchor, i) => {
        if (fit.residuals[i] > CAREER_TIMELINE_LINE_RESIDUAL_TOLERANCE_PX) {
          violations.push({
            type: 'career-timeline-line-nonlinear',
            selectorPath,
            t: anchor.t,
            residualPx: fit.residuals[i],
          });
        }
      });
      for (const delta of careerTimelineEdgeDeltas(timeline)) {
        if (delta.deltaPx > CAREER_TIMELINE_ALIGN_TOLERANCE_PX) {
          violations.push({ type: 'career-timeline-axis-misaligned', selectorPath, ...delta });
        }
      }
    }

    if (timeline.formStripTicks > CAREER_TIMELINE_FORM_STRIP_TICK_BOUND) {
      violations.push({
        type: 'career-timeline-form-strip-ticks',
        selectorPath,
        count: timeline.formStripTicks,
      });
    }
    if (expectation.strips === true && (state === 'thin' || rateCells.length === 0)) {
      violations.push({ type: 'career-timeline-strips-missing', selectorPath, state });
    }
    if (expectation.formStrip === true && state === 'thin' && timeline.formStripTicks === 0) {
      violations.push({ type: 'career-timeline-form-strip-missing', selectorPath });
    }
    if (expectation.state !== undefined && expectation.state !== state) {
      violations.push({
        type: 'career-timeline-state-mismatch',
        selectorPath,
        expected: expectation.state,
        state,
      });
    }
  }
  return violations;
}

// ---------------------------------------------------------------------------
// Plan 39.1-38: the page-frame oracle families — filter-row, stat-row-columns,
// placement, insight-order. Same discipline as every family above: each
// evaluator returns EVERY offender, and an opted-in route that measured
// nothing reports `<family>-unmeasured` (never a silent pass).
// ---------------------------------------------------------------------------

/** UI-SPEC §10.4: the one filter row's height ceiling applies from this viewport width up. */
export const FILTER_ROW_MIN_VIEWPORT_WIDTH_PX = 1024;
/** Stat-row column clustering: child lefts within this many px are one column. */
export const STAT_ROW_COLUMN_TOLERANCE_PX = 2;
/** UI-SPEC §8.1 placement tolerance (column edges and the hero-to-lists gap). */
export const PLACEMENT_TOLERANCE_PX = 2;
/** UI-SPEC §6.1: placement is a desktop-composition rule, evaluated from `lg` (1024) up. */
export const PLACEMENT_MIN_VIEWPORT_WIDTH_PX = 1024;

function ownerViolationType(selector) {
  if (/^h1\b/.test(selector)) return 'title-in-card';
  if (selector.includes('horizon-switch')) return 'switch-in-card';
  return 'owner-in-card';
}

/**
 * UI-SPEC §6.1 / §10.4 (sketch 001-C / 002-C `.filters`): ONE unboxed filter
 * row — no border, not inside a card, no card holding the page h1 or the
 * HorizonSwitch, at most `maxHeightPx` tall at 1024+, and every declared owner
 * (`owners`) rendered inside it. Input:
 * `{ viewportWidth, maxHeightPx?, owners?, rows: [{ selectorPath, borderWidths:
 * number[4], inCard, height, ownedInside?: string[] }], ownedInCards:
 * [{ selector, selectorPath }] }`.
 */
export function evaluateFilterRow({
  viewportWidth,
  maxHeightPx,
  owners = [],
  rows,
  ownedInCards = [],
}) {
  const violations = [];
  if (rows.length === 0) {
    violations.push({ type: 'filter-row-unmeasured' });
  }
  if (rows.length > 1) {
    violations.push({ type: 'filter-row-duplicate', count: rows.length });
  }
  for (const row of rows) {
    const { selectorPath } = row;
    if (row.borderWidths.some((w) => w > 0)) {
      violations.push({
        type: 'filter-row-bordered',
        selectorPath,
        borderWidths: row.borderWidths,
      });
    }
    if (row.inCard) {
      violations.push({ type: 'filter-row-in-card', selectorPath });
    }
    if (
      typeof maxHeightPx === 'number' &&
      viewportWidth >= FILTER_ROW_MIN_VIEWPORT_WIDTH_PX &&
      row.height > maxHeightPx
    ) {
      violations.push({ type: 'filter-row-tall', selectorPath, height: row.height, maxHeightPx });
    }
  }
  if (rows.length > 0) {
    const inside = new Set(rows.flatMap((row) => row.ownedInside ?? []));
    for (const owner of owners) {
      if (!inside.has(owner)) {
        violations.push({ type: 'filter-row-missing-owner', owner });
      }
    }
  }
  for (const owned of ownedInCards) {
    violations.push({
      type: ownerViolationType(owned.selector),
      selector: owned.selector,
      selectorPath: owned.selectorPath,
    });
  }
  return violations;
}

/**
 * UI-SPEC §6.6 / §7.3 (sketches 001-C / 003-A `.statrow`, 002-C `.statrow.kpi`):
 * on a phone every StatRow without fixed columns is a PLAIN two-column grid —
 * at most two distinct column lefts, and no first figure spanning the full
 * row unless the row opted into the sketch 002-C lead span (`data-lead-span`).
 * Each row: `{ selectorPath, fixedColumns, leadSpan, rowWidth, children:
 * [{ left, width }] }`. Zero-width (hidden) children are ignored.
 */
export function evaluateStatRowColumns(rows, tolerancePx = STAT_ROW_COLUMN_TOLERANCE_PX) {
  if (rows.length === 0) return [{ type: 'stat-row-columns-unmeasured' }];
  const violations = [];
  for (const row of rows) {
    if (row.fixedColumns) continue;
    const children = row.children.filter((child) => child.width > 0);
    if (children.length < 2) continue;
    const columnLefts = [];
    for (const child of children) {
      if (!columnLefts.some((left) => Math.abs(left - child.left) <= tolerancePx)) {
        columnLefts.push(child.left);
      }
    }
    if (columnLefts.length > 2) {
      violations.push({
        type: 'stat-row-columns',
        selectorPath: row.selectorPath,
        columns: columnLefts.length,
      });
    }
    if (!row.leadSpan && children[0].width >= row.rowWidth - tolerancePx) {
      violations.push({
        type: 'stat-row-lead-span',
        selectorPath: row.selectorPath,
        leadWidth: children[0].width,
        rowWidth: row.rowWidth,
      });
    }
  }
  return violations;
}

/**
 * UI-SPEC §8.1 (sketch 001-C `.col-8` stack / `.duo`): desktop placement
 * declarations, evaluated at 1024+ only. Kinds:
 * - `within-column`: `{ subjectSelector, subject, anchor, gapPx }` — the
 *   subject's left/right within 2px of the anchor column's, and its top
 *   `gapPx` (±2) under the anchor's bottom.
 * - `side-by-side`: `{ parentSelector, children, pageWidth, minPageWidthPx }` —
 *   when the page is at least `minPageWidthPx` wide, every child's top within
 *   2px of the first's.
 * - `above`: `{ firstSelector, thenSelector, first, then }` — `first` starts
 *   above `then` (a desktop composition kept by grid placement, plan 39.1-38
 *   Task 3).
 * A missing rect (or fewer than two side-by-side children) is
 * `placement-unmeasured`; an empty declaration list is exactly one.
 */
export function evaluatePlacement({ viewportWidth, items }, tolerancePx = PLACEMENT_TOLERANCE_PX) {
  if (viewportWidth < PLACEMENT_MIN_VIEWPORT_WIDTH_PX) return [];
  if (items.length === 0) return [{ type: 'placement-unmeasured' }];
  const violations = [];
  for (const item of items) {
    if (item.kind === 'within-column') {
      const { subject, anchor, subjectSelector } = item;
      if (!subject || !anchor) {
        violations.push({
          type: 'placement-unmeasured',
          kind: item.kind,
          selector: subjectSelector,
        });
        continue;
      }
      if (
        Math.abs(subject.left - anchor.left) > tolerancePx ||
        Math.abs(subject.right - anchor.right) > tolerancePx
      ) {
        violations.push({
          type: 'placement-column',
          selectorPath: subjectSelector,
          subject: { left: subject.left, right: subject.right },
          anchor: { left: anchor.left, right: anchor.right },
        });
      }
      const gap = subject.top - anchor.bottom;
      if (Math.abs(gap - item.gapPx) > tolerancePx) {
        violations.push({
          type: 'placement-gap',
          selectorPath: subjectSelector,
          gap,
          expected: item.gapPx,
        });
      }
    } else if (item.kind === 'side-by-side') {
      const { children, parentSelector } = item;
      if (!children || children.length < 2 || typeof item.pageWidth !== 'number') {
        violations.push({
          type: 'placement-unmeasured',
          kind: item.kind,
          selector: parentSelector,
        });
        continue;
      }
      if (item.pageWidth < item.minPageWidthPx) continue;
      const firstTop = children[0].top;
      if (children.some((child) => Math.abs(child.top - firstTop) > tolerancePx)) {
        violations.push({
          type: 'placement-not-side-by-side',
          selectorPath: parentSelector,
          tops: children.map((child) => child.top),
          pageWidth: item.pageWidth,
        });
      }
    } else if (item.kind === 'above') {
      const { first, then, firstSelector, thenSelector } = item;
      if (!first || !then) {
        violations.push({
          type: 'placement-unmeasured',
          kind: item.kind,
          selector: first ? thenSelector : firstSelector,
        });
        continue;
      }
      if (first.top >= then.top) {
        violations.push({
          type: 'placement-not-above',
          selectorPath: firstSelector,
          first: firstSelector,
          then: thenSelector,
          firstTop: first.top,
          thenTop: then.top,
        });
      }
    } else {
      violations.push({ type: 'placement-unmeasured', kind: item.kind });
    }
  }
  return violations;
}

/**
 * UI-SPEC §8.2 / §8.4 "insight before chart" (phone reading order): each
 * declared pair `{ first, then, firstTop, thenTop }` must render `first` no
 * lower than `then`. A declared selector that matched nothing (`null` top) is
 * `insight-order-unmeasured` naming it; an empty pair list is exactly one.
 */
export function evaluateInsightOrder(pairs) {
  if (pairs.length === 0) return [{ type: 'insight-order-unmeasured' }];
  const violations = [];
  for (const pair of pairs) {
    const missing =
      pair.firstTop === null || pair.firstTop === undefined
        ? pair.first
        : pair.thenTop === null || pair.thenTop === undefined
          ? pair.then
          : null;
    if (missing) {
      violations.push({ type: 'insight-order-unmeasured', missing, selectorPath: missing });
      continue;
    }
    if (pair.firstTop > pair.thenTop) {
      violations.push({
        type: 'insight-order',
        selectorPath: pair.first,
        first: pair.first,
        then: pair.then,
        firstTop: pair.firstTop,
        thenTop: pair.thenTop,
      });
    }
  }
  return violations;
}
