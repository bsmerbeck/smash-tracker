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
/**
 * Plan 39.1-50 (OOS-11, UI-SPEC §7.8 rule 5): the header-squeeze family's
 * default scan — every card header, measuring its title and description.
 */
export const DEFAULT_HEADER_SQUEEZE_CONFIG = Object.freeze({
  header: '[data-slot="card-header"]',
  parts: Object.freeze([
    Object.freeze({ role: 'title', selector: '[data-slot="card-title"]' }),
    Object.freeze({ role: 'description', selector: '[data-slot="card-description"]' }),
  ]),
});

/**
 * Plan 39.1-50: the headers and parts header-squeeze measures on `route`. A
 * route that declares `headerSqueeze: { header, parts: [{ role, selector }] }`
 * is measured on exactly those; every other route (Matchups) keeps the
 * default card-header scan, byte-unchanged. Pure; the result is what the
 * in-browser collector receives through `familyConfig`.
 */
export function headerSqueezeConfigForRoute(route) {
  const declared = route && route.headerSqueeze;
  if (declared && declared.header && Array.isArray(declared.parts)) {
    return {
      header: declared.header,
      parts: declared.parts.map((part) => ({ role: part.role, selector: part.selector })),
    };
  }
  return {
    header: DEFAULT_HEADER_SQUEEZE_CONFIG.header,
    parts: DEFAULT_HEADER_SQUEEZE_CONFIG.parts.map((part) => ({ ...part })),
  };
}

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

/**
 * Plan 39.1-43 (OOS-6): sketch 001-C / 003 draw every period dot with a 2px
 * card-surface halo (`.pt { box-shadow: 0 0 0 2px var(--color-surface) }`),
 * so a reference label must clear the dot's box expanded by this much.
 */
export const REFERENCE_LABEL_DOT_HALO_PX = 2;

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

    // Plan 39.1-43 (OOS-6): the value-label loop above never saw a label over
    // a DOT — the 39.1-39 capture's "NN% all time" sat on the last dots and
    // passed. Every (reference label, drawn dot) pair is reported.
    for (const reference of surface.referenceLabels ?? []) {
      for (const dot of dots) {
        if (rectsIntersect(dot, reference, REFERENCE_LABEL_DOT_HALO_PX)) {
          violations.push({
            type: 'reference-label-dot-collision',
            selectorPath,
            reference: reference.text,
            dot: dot.selectorPath,
            ...(dot.key ? { key: dot.key } : {}),
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
 * Plan 39.1-44 (PD-44-5): the Matchups phone scroll budget, re-derived from the
 * APPROVED SKETCH's measured page height (design-audit/matchups-fidelity/
 * after-39.1-43/metrics.json, sketch 003 A at 390x844): thin 4405px / 844 =
 * 5.219 viewport heights, deep 6176px / 844 = 7.318. The budget is the larger
 * page ratio + 0.4 (~340px of headroom, ~3 stacked result rows) = 7.718,
 * rounded up to 7.72 (and never below 7.5 — plan 39.1-33's floor). Plan
 * 39.1-33's first derivation (7.5: a single-row strip + a 20-row phone results
 * page, 7.127 heights measured on the old composition, with 0.37 headroom)
 * is superseded — the composition it measured is gone. The
 * plan 39.1-33 regression states (13.793 with neither fix, 7.767 with only the
 * form strip fixed, 13.153 with only the results list bounded) all still
 * exceed 7.72.
 */
export const MATCHUPS_SCROLL_BUDGET_390X844 = 7.72;

/**
 * Plan 39.1-44 (PD-44-5): one phone screen cannot hold the pairing hero, but
 * its card height is bounded by the approved design: the sketch's hero region
 * at 390x844 is 1022px thin / 1219px deep (after-39.1-43 metrics.json), i.e.
 * 1.211 / 1.444 viewport heights; the ceiling is the taller (deep) x 1.10 =
 * 1.588, rounded up to 1.59 (~1342px). It replaces plan 39.1-33's Win Rate
 * Trend card ceiling (1.0), whose card no longer exists (the trend lives in
 * the hero).
 */
export const PAIRING_HERO_CARD_MAX_VIEWPORT_HEIGHTS = 1.59;

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

// ---------------------------------------------------------------------------
// Plan 39.1-44: the section-order family — sketch 003 A's composition (hero +
// By opponent beside the rail at 1280+, the matrix below the whole pairing,
// results last, one reading order at every width).
// ---------------------------------------------------------------------------

/** Plan 39.1-44: rect comparisons tolerate this many px of sub-pixel rounding. */
export const SECTION_ORDER_TOLERANCE_PX = 1;
/** Plan 39.1-44: the rail sits beside the hero from this viewport width up (UI-SPEC 6.6). */
export const SECTION_ORDER_RAIL_MIN_VIEWPORT_WIDTH_PX = 1280;
/** Plan 39.1-44: the first rail section's top may differ from the hero's by at most this many px. */
export const SECTION_ORDER_RAIL_TOP_TOLERANCE_PX = 2;

/** The pairing sections the matrix must sit below (declared DOM order, hero first). */
const SECTION_ORDER_PAIRING_SLOTS = [
  'pairing-hero',
  'pairing-opponents',
  'matchup-insights',
  'matchup-or-player',
  'counterpick-advisor',
  'stage-breakdown',
];
/** The rail's sections, in rail order. */
const SECTION_ORDER_RAIL_SLOTS = [
  'matchup-insights',
  'matchup-or-player',
  'counterpick-advisor',
  'stage-breakdown',
];

/**
 * Plan 39.1-44 (sketch 003 A `renderA`, PD-44-1): the declared sections, in the
 * DOM order every width must keep. Input:
 * `{ viewportWidth, expected: [{ slot, optional? }], found: [{ slot, domIndex,
 * rect: { left, right, top, bottom } }] }`, `found` holding only the slots
 * that resolved. A required slot that is absent is `section-order-unmeasured`
 * (never a silent pass — the page drifting away from its slots must fail);
 * an absent optional slot is skipped.
 *
 * - `section-order-dom`: the found slots' DOM order differs from `expected`.
 * - `section-order-matrix-above`: the matrix's top is above the bottom of any
 *   pairing section.
 * - From 1280px: `section-order-rail-not-beside` — a rail section's left edge
 *   is left of the hero's right edge, or the first rail section's top differs
 *   from the hero's by more than 2px.
 * - At 639px and narrower: `section-order-stacked` — a section's top is above
 *   the previous section's bottom (minus 1px).
 */
export function evaluateSectionOrder({ viewportWidth, expected, found }) {
  const violations = [];
  const bySlot = new Map(found.map((item) => [item.slot, item]));
  for (const { slot, optional } of expected) {
    if (!bySlot.has(slot) && !optional) {
      violations.push({ type: 'section-order-unmeasured', slot });
    }
  }
  const present = expected.filter(({ slot }) => bySlot.has(slot)).map(({ slot }) => slot);

  const domOrder = [...present].sort((a, b) => bySlot.get(a).domIndex - bySlot.get(b).domIndex);
  if (domOrder.some((slot, i) => slot !== present[i])) {
    violations.push({ type: 'section-order-dom', expected: present, actual: domOrder });
  }

  const matrix = bySlot.get('matchup-matrix');
  if (matrix) {
    for (const slot of SECTION_ORDER_PAIRING_SLOTS) {
      const section = bySlot.get(slot);
      if (section && matrix.rect.top < section.rect.bottom - SECTION_ORDER_TOLERANCE_PX) {
        violations.push({
          type: 'section-order-matrix-above',
          slot,
          matrixTop: matrix.rect.top,
          sectionBottom: section.rect.bottom,
        });
      }
    }
  }

  const hero = bySlot.get('pairing-hero');
  if (hero && viewportWidth >= SECTION_ORDER_RAIL_MIN_VIEWPORT_WIDTH_PX) {
    const railSections = SECTION_ORDER_RAIL_SLOTS.filter((slot) => bySlot.has(slot));
    for (const slot of railSections) {
      const section = bySlot.get(slot);
      if (section.rect.left < hero.rect.right - SECTION_ORDER_TOLERANCE_PX) {
        violations.push({
          type: 'section-order-rail-not-beside',
          slot,
          left: section.rect.left,
          heroRight: hero.rect.right,
        });
      }
    }
    const firstRail = railSections[0] ? bySlot.get(railSections[0]) : null;
    if (
      firstRail &&
      Math.abs(firstRail.rect.top - hero.rect.top) > SECTION_ORDER_RAIL_TOP_TOLERANCE_PX
    ) {
      violations.push({
        type: 'section-order-rail-not-beside',
        slot: railSections[0],
        top: firstRail.rect.top,
        heroTop: hero.rect.top,
      });
    }
  }

  if (viewportWidth <= NARROW_VIEWPORT_MAX_WIDTH_PX) {
    for (let i = 1; i < present.length; i++) {
      const previous = bySlot.get(present[i - 1]);
      const current = bySlot.get(present[i]);
      if (current.rect.top < previous.rect.bottom - SECTION_ORDER_TOLERANCE_PX) {
        violations.push({
          type: 'section-order-stacked',
          slot: present[i],
          previous: present[i - 1],
          top: current.rect.top,
          previousBottom: previous.rect.bottom,
        });
      }
    }
  }
  return violations;
}

/** Plan 39.1-44: the one SECTION_ORDER line per measured surface — the found slots in DOM order. */
export function formatSectionOrderLine(routeId, viewportName, found) {
  const order = [...found]
    .sort((a, b) => a.domIndex - b.domIndex)
    .map((item) => item.slot)
    .join('>');
  return `SECTION_ORDER route=${routeId} viewport=${viewportName} order=${order}`;
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

/**
 * Plan 39.1-42 (sketch 003 `.strip-ev{min-width:80px}` / 76px below 640px,
 * UI-SPEC §7.10 as amended 2026-09-25): a shown event's label box is never
 * squeezed below this width — the kit's own minimum event column (76 / 80px)
 * less a 4px allowance for sub-pixel layout.
 */
export const FORM_STRIP_LABEL_MIN_WIDTH_PX = 72;

/** A label states the W–L actually drawn: two counts joined by an en dash (or a hyphen). */
const FORM_STRIP_RECORD_TOKEN = /\d+\s*[–-]\s*\d+/u;

/** Sub-pixel tolerance for two label boxes that merely touch. */
const FORM_STRIP_LABEL_OVERLAP_TOLERANCE_PX = 0.5;

/**
 * Plan 39.1-42: the form-strip-labels family (sketch 003 `formStrip` /
 * `fitStrips` — one row, older EVENTS drop first, `label + W–L` under every
 * shown event). `strips`: one entry per `[data-slot="form-strip-root"]` —
 * `{ selectorPath, eventCount: number | null (data-event-count), events:
 * [{ order: number | null (data-event-order), labelText: string | null,
 * labelRect: { left, right, top, bottom, width, height } | null }] }`.
 * Every offender is returned:
 * - `form-strip-labels-unmeasured`: an opted route rendered no strip;
 * - `form-strip-label-missing`: a shown event with no label text or no W–L
 *   token (a root with no event at all counts once);
 * - `form-strip-label-overlap`: two label boxes intersect;
 * - `form-strip-not-newest`: the shown orders are not the contiguous run
 *   ending at `eventCount - 1` — checked only when the root declares
 *   `data-event-count` (a shipped caption-only root has no orders, and
 *   reports its missing labels instead);
 * - `form-strip-label-squeezed`: a label box narrower than
 *   `FORM_STRIP_LABEL_MIN_WIDTH_PX`.
 */
export function evaluateFormStripLabels(strips) {
  if (strips.length === 0) {
    return [{ type: 'form-strip-labels-unmeasured' }];
  }
  const violations = [];
  for (const strip of strips) {
    const { selectorPath, eventCount, events } = strip;
    if (events.length === 0) {
      violations.push({ type: 'form-strip-label-missing', selectorPath, detail: 'no event' });
      continue;
    }
    events.forEach((event, index) => {
      const text = (event.labelText ?? '').trim();
      if (!text || !FORM_STRIP_RECORD_TOKEN.test(text)) {
        violations.push({
          type: 'form-strip-label-missing',
          selectorPath,
          detail: `event ${index} label=${text || 'none'}`,
        });
      }
    });
    for (let i = 0; i < events.length; i += 1) {
      for (let j = i + 1; j < events.length; j += 1) {
        const a = events[i].labelRect;
        const b = events[j].labelRect;
        // A negative expansion: boxes that merely touch (sub-pixel) never count.
        if (a && b && rectsIntersect(a, b, -FORM_STRIP_LABEL_OVERLAP_TOLERANCE_PX)) {
          violations.push({
            type: 'form-strip-label-overlap',
            selectorPath,
            detail: `events ${i} and ${j}`,
          });
        }
      }
    }
    if (eventCount != null) {
      const orders = events.map((event) => event.order);
      const sorted = orders.every((order) => Number.isInteger(order))
        ? [...orders].sort((a, b) => a - b)
        : null;
      const contiguous =
        sorted !== null &&
        sorted[sorted.length - 1] === eventCount - 1 &&
        sorted.every((order, index) => index === 0 || order === sorted[index - 1] + 1);
      if (!contiguous) {
        violations.push({
          type: 'form-strip-not-newest',
          selectorPath,
          detail: `orders=${orders.map((order) => order ?? 'none').join(',')} count=${eventCount}`,
        });
      }
    }
    events.forEach((event, index) => {
      if (event.labelRect && event.labelRect.width < FORM_STRIP_LABEL_MIN_WIDTH_PX) {
        violations.push({
          type: 'form-strip-label-squeezed',
          selectorPath,
          detail: `event ${index} width=${event.labelRect.width}`,
        });
      }
    });
  }
  return violations;
}

/**
 * The one FORM_STRIP line per measured strip root: shown / declared events,
 * drawn / total games, the shown labels (label text + W–L as rendered,
 * joined by `|`) and the root's measured width.
 */
export function formatFormStripLine(routeId, viewportName, strip) {
  const events = strip.events ?? [];
  const labels = events
    .map((event) => (event.labelText ?? '').replace(/\s+/g, ' ').trim())
    .filter((text) => text.length > 0)
    .join('|');
  const count = strip.eventCount ?? 'unknown';
  const total = strip.gameCount ?? 'unknown';
  const width = Number.isFinite(strip.rootWidth) ? Math.round(strip.rootWidth) : 'unknown';
  return `FORM_STRIP route=${routeId} viewport=${viewportName} events=${events.length}/${count} games=${strip.shownGames}/${total} labels=${labels || 'none'} width=${width}`;
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

/**
 * UI-SPEC §6.6 "< 640 tables become stacked rows" (plan 39.1-38 Task 3): at a
 * narrow viewport nothing in a declared list may hide behind a horizontal
 * scroll. Each target: `{ selector, found, selectorPath, scrollWidth,
 * clientWidth }` — the sizes are the target's nearest ancestor-or-self with
 * `overflow-x` auto / scroll / hidden (`null` when it has none, which passes).
 * A declared target matching nothing is `table-clip-unmeasured` naming it;
 * an empty target list is exactly one.
 */
export function evaluateTableClip(targets, tolerancePx = 1) {
  if (targets.length === 0) return [{ type: 'table-clip-unmeasured' }];
  const violations = [];
  for (const target of targets) {
    if (!target.found) {
      violations.push({ type: 'table-clip-unmeasured', selector: target.selector });
      continue;
    }
    if (typeof target.scrollWidth !== 'number' || typeof target.clientWidth !== 'number') continue;
    if (target.scrollWidth > target.clientWidth + tolerancePx) {
      violations.push({
        type: 'table-clipped',
        selector: target.selector,
        selectorPath: target.selectorPath,
        scrollWidth: target.scrollWidth,
        clientWidth: target.clientWidth,
      });
    }
  }
  return violations;
}

// ---------------------------------------------------------------------------
// Plan 39.1-39: brand-red-text and record-fit.
// ---------------------------------------------------------------------------

/** A resolved probe colour that cannot identify `--primary` (the var failed to resolve). */
function isUnresolvedColour(value) {
  if (typeof value !== 'string') return true;
  const v = value.trim().toLowerCase().replace(/\s+/g, ' ');
  return (
    v === '' ||
    v === 'transparent' ||
    v === 'rgba(0, 0, 0, 0)' ||
    /^rgba\(\s*\d+,\s*\d+,\s*\d+,\s*0\s*\)$/.test(v) ||
    /\/\s*0\s*\)$/.test(v)
  );
}

function normaliseColour(value) {
  return String(value).trim().toLowerCase().replace(/\s+/g, ' ');
}

/**
 * UI-SPEC §4.3 (red = the one filled primary door, the HorizonSwitch inset,
 * the focus ring and app chrome — never text): every text-bearing element
 * whose computed colour EXACTLY equals the resolved `--primary` probe colour
 * is one `brand-red-text` violation. `input` is `{ probe, scanned, elements }`
 * where `probe` is the probe span's computed `color`, `scanned` the number of
 * text-bearing elements the collector compared, and `elements` the
 * candidates `[{ tag, text, selectorPath, color }]`. A probe that did not
 * resolve, or zero scanned elements, is exactly one
 * `brand-red-text-unmeasured` (never a vacuous pass).
 */
export function evaluateBrandRedText({ probe, scanned, elements = [] } = {}) {
  if (isUnresolvedColour(probe)) {
    return [{ type: 'brand-red-text-unmeasured', reason: 'probe', probe: probe ?? null }];
  }
  if (!scanned) {
    return [{ type: 'brand-red-text-unmeasured', reason: 'no-text-elements' }];
  }
  const target = normaliseColour(probe);
  return elements
    .filter((el) => normaliseColour(el.color) === target)
    .map((el) => ({
      type: 'brand-red-text',
      tag: el.tag,
      text: el.text,
      selectorPath: el.selectorPath,
      color: el.color,
    }));
}

/** UI-SPEC §6.5 rule 2 / §7.4: a record may not leave its figure cell by more than this many px. */
export const RECORD_OVERFLOW_TOLERANCE_PX = 0.5;

/**
 * UI-SPEC §7.3 / §7.4 ("wraps whole") / §6.5 rule 2: inside one card, every
 * record's box is pairwise disjoint from every other record's box
 * (`record-overlap`, naming both texts), and every record's right edge stays
 * inside its figure cell (`record-overflow`, over 0.5px). Records in
 * different cards are never compared. `cards` is
 * `[{ selectorPath, records: [{ text, rect, cellRect }] }]`; zero records
 * across every card is exactly one `record-fit-unmeasured`.
 */
export function evaluateRecordFit(cards = []) {
  const total = cards.reduce((sum, card) => sum + (card.records?.length ?? 0), 0);
  if (total === 0) return [{ type: 'record-fit-unmeasured' }];
  const violations = [];
  for (const card of cards) {
    const records = card.records ?? [];
    for (let i = 0; i < records.length; i += 1) {
      const a = records[i];
      if (a.cellRect && a.rect.right > a.cellRect.right + RECORD_OVERFLOW_TOLERANCE_PX) {
        violations.push({
          type: 'record-overflow',
          selectorPath: card.selectorPath,
          text: a.text,
          recordRight: a.rect.right,
          cellRight: a.cellRect.right,
        });
      }
      for (let j = i + 1; j < records.length; j += 1) {
        const b = records[j];
        if (rectsIntersect(a.rect, b.rect)) {
          violations.push({
            type: 'record-overlap',
            selectorPath: card.selectorPath,
            texts: [a.text, b.text],
          });
        }
      }
    }
  }
  return violations;
}

// ---------------------------------------------------------------------------
// Plan 39.1-39: mark-count (UI-SPEC §11 line points) and matrix-hug (audit 7.4).
// ---------------------------------------------------------------------------

/** UI-SPEC §11: a line chart shows at most this many points (mirrors `MARK_BOUND_LINE_POINTS`). */
export const MARK_COUNT_LINE_POINTS_LIMIT = 60;

/**
 * UI-SPEC §11 ("line points at most 60"): every rendered line's point-mark
 * count is at most the bound. `lines` is `[{ selectorPath, count }]`; a count
 * over the limit is one `mark-count-over`; a route that requested the family
 * but rendered no line is exactly one `mark-count-unmeasured`.
 */
export function evaluateMarkCount(lines = [], limit = MARK_COUNT_LINE_POINTS_LIMIT) {
  if (lines.length === 0) return [{ type: 'mark-count-unmeasured' }];
  return lines
    .filter((line) => line.count > limit)
    .map((line) => ({
      type: 'mark-count-over',
      selectorPath: line.selectorPath,
      count: line.count,
      limit,
    }));
}

/** Audit 7.4: a matrix table may sit at most this many px right of its card's content edge. */
export const MATRIX_HUG_TOLERANCE_PX = 2;
/** The family is evaluated from this viewport width up (the grid form; below it the Tabs stack renders). */
export const MATRIX_HUG_MIN_VIEWPORT_PX = 1024;

/**
 * Design audit 7.4: a cross-tab matrix sits at its card's content edge (no
 * centring), so the card hugs its content. `tables` is
 * `[{ selectorPath, left, contentLeft }]`. Below 1024px the family is not
 * evaluated at all; at 1024px and wider no matrix is exactly one
 * `matrix-hug-unmeasured`; a table more than 2px right of the content edge is
 * one `matrix-not-left-aligned`.
 */
export function evaluateMatrixHug({ viewportWidth, tables = [] } = {}) {
  if (!(viewportWidth >= MATRIX_HUG_MIN_VIEWPORT_PX)) return [];
  if (tables.length === 0) return [{ type: 'matrix-hug-unmeasured' }];
  return tables
    .filter((table) => table.left - table.contentLeft > MATRIX_HUG_TOLERANCE_PX)
    .map((table) => ({
      type: 'matrix-not-left-aligned',
      selectorPath: table.selectorPath,
      left: table.left,
      contentLeft: table.contentLeft,
      offsetPx: table.left - table.contentLeft,
    }));
}

// ---------------------------------------------------------------------------
// Plan 39.1-49: the all-route table-clip sweep and the text-fit family.
// ---------------------------------------------------------------------------

/**
 * UI-SPEC §6.6 "< 640 tables become stacked rows": what the sweep discovers
 * on every route — tables, grids, lists and (OOS-5) tab lists. A candidate
 * whose nearest horizontal scroll / clip container hides content is a
 * table-clipped offender.
 */
export const TABLE_CLIP_SCAN_SELECTOR =
  'table, [role="table"], [role="grid"], [role="tablist"], ul, ol, [role="list"]';

/**
 * Matchups (and every `matchups-*` route plan 39.1-41 adds) is rebuilt by
 * plans 39.1-41..48: its clips are printed, never enforced here. An exact id
 * or the `matchups-` prefix only — `match-data` shares the `match` prefix
 * and stays enforced.
 */
export function tableClipModeForRoute(id) {
  return id === 'matchups' || String(id).startsWith('matchups-') ? 'routed' : 'enforce';
}

/** Every oracle route the sweep visits: all of them except the synthetic `-fixture` routes, in input order. */
export function tableClipSweepRoutes(routes) {
  return routes.filter((route) => !/-fixture$/.test(route.id));
}

/** The number of distinct visible candidates (discovered plus declared) the sweep measured. */
export function tableClipSweepScanned({ candidates = [], declared = [] } = {}) {
  const seen = new Set();
  for (const item of [...candidates, ...declared.filter((d) => d.found)]) {
    if (item.hidden) continue;
    seen.add(item.targetPath);
  }
  return seen.size;
}

/**
 * The sweep's pure evaluator. `candidates` are every visible-or-hidden match
 * of TABLE_CLIP_SCAN_SELECTOR, `declared` each route clipTarget's first match
 * (`found` false when it matched nothing), each item
 * `{ targetPath, kind, hidden, clipId, clipPath, scrollWidth, clientWidth }`
 * where the sizes are the nearest ancestor-or-self horizontal scroll / clip
 * container's (`clipId` null when there is none). `page` is
 * `{ scrollWidth, innerWidth }`. One violation per clipping container (never
 * one per candidate inside it); a page wider than its viewport is one
 * sweep-page-overflow. Routed mode (Matchups) reports both as
 * table-clip-routed; zero visible candidates, or a declared target matching
 * nothing, stays a table-clip-unmeasured violation in either mode.
 */
export function evaluateTableClipSweep(
  { candidates = [], declared = [], page = {} } = {},
  { mode = 'enforce', tolerancePx = 1 } = {},
) {
  const violations = [];
  const routed = mode === 'routed';
  const report = (violation) => {
    if (routed) {
      violations.push({ ...violation, type: 'table-clip-routed', routedType: violation.type });
    } else {
      violations.push(violation);
    }
  };

  for (const item of declared) {
    if (!item.found) {
      violations.push({ type: 'table-clip-unmeasured', selector: item.selector });
    }
  }
  const measured = [...candidates, ...declared.filter((item) => item.found)].filter(
    (item) => !item.hidden,
  );
  if (measured.length === 0) {
    violations.push({ type: 'table-clip-unmeasured', reason: 'no-visible-candidates' });
  }

  const byContainer = new Map();
  for (const item of measured) {
    if (item.clipId === null || item.clipId === undefined) continue;
    if (typeof item.scrollWidth !== 'number' || typeof item.clientWidth !== 'number') continue;
    if (!(item.scrollWidth > item.clientWidth + tolerancePx)) continue;
    const entry = byContainer.get(item.clipId);
    if (entry) {
      // A declared target is usually also a discovered candidate: one path once.
      if (!entry.candidates.includes(item.targetPath)) entry.candidates.push(item.targetPath);
    } else {
      byContainer.set(item.clipId, { item, candidates: [item.targetPath] });
    }
  }
  for (const { item, candidates: inside } of byContainer.values()) {
    report({
      type: 'table-clipped',
      selectorPath: item.clipPath ?? item.targetPath,
      kind: item.kind,
      scrollWidth: item.scrollWidth,
      clientWidth: item.clientWidth,
      candidates: inside,
    });
  }

  if (
    typeof page.scrollWidth === 'number' &&
    typeof page.innerWidth === 'number' &&
    page.scrollWidth > page.innerWidth + tolerancePx
  ) {
    report({
      type: 'sweep-page-overflow',
      selectorPath: 'html',
      scrollWidth: page.scrollWidth,
      innerWidth: page.innerWidth,
    });
  }
  return violations;
}

/**
 * Drives a page that needs input before its loaded marker exists (Scout):
 * each step waits for its selector first, then types / clicks / only waits.
 * An unknown step type throws naming it; a failed wait rejects naming the
 * step index and selector — the runner reports the route UNMEASURED, never
 * a pass.
 */
export async function runRoutePrepare(page, steps = [], { timeoutMs = 15_000 } = {}) {
  for (let index = 0; index < steps.length; index += 1) {
    const step = steps[index];
    if (!['type', 'click', 'wait'].includes(step?.type)) {
      throw new Error(`prepare step ${index}: unknown step type "${step?.type}"`);
    }
    try {
      await page.waitForSelector(step.selector, { timeout: timeoutMs });
    } catch (error) {
      throw new Error(
        `prepare step ${index} (${step.type}) never found "${step.selector}": ${
          error instanceof Error ? error.message : String(error)
        }`,
        { cause: error },
      );
    }
    if (step.type === 'type') {
      await page.type(step.selector, step.text ?? '');
    } else if (step.type === 'click') {
      await page.click(step.selector);
    }
  }
}

/**
 * UI-SPEC §6.5 rule 1: the one flexible slot may truncate with a `title` —
 * but a slot starved below this width shows 'U…', '(' or nothing at all, so
 * a title no longer excuses it.
 */
export const MIN_TRUNCATED_LABEL_PX = 48;

/** The route's declared text-fit targets measured at `viewportName` (`[]` for a route without any). */
export function fitTargetsForViewport(route, viewportName) {
  return (route?.fitTargets ?? []).filter((target) =>
    (target.viewports ?? []).includes(viewportName),
  );
}

/**
 * The text-fit family (plan 39.1-49; OOS-3, OOS-9, OOS-10). Each target is
 * `{ selector, found, scanned, left, right, items }` and each item
 * `{ selectorPath, hidden, left, right, cardInnerLeft, cardInnerRight,
 * hasText, clips, scrollWidth, clientWidth, scrollHeight, clientHeight,
 * lineClamped, titled }`. Reports EVERY offender:
 * - content-escape: a visible descendant past its card's inner edges (the
 *   target's own box when it has no card) by more than `tolerancePx`;
 * - text-cut: a visible text-bearing box that clips its own text (hidden /
 *   clip overflow, ellipsis or a line clamp) — exempt only when titled AND
 *   at least `minLabelPx` wide;
 * - text-fit-unmeasured: a target matching nothing or scanning nothing.
 */
export function evaluateTextFit(
  { targets = [] } = {},
  { tolerancePx = 1, minLabelPx = MIN_TRUNCATED_LABEL_PX } = {},
) {
  const violations = [];
  for (const target of targets) {
    if (!target.found) {
      violations.push({
        type: 'text-fit-unmeasured',
        selector: target.selector,
        reason: 'no-match',
      });
      continue;
    }
    if (!target.scanned) {
      violations.push({
        type: 'text-fit-unmeasured',
        selector: target.selector,
        reason: 'no-descendants',
      });
      continue;
    }
    for (const item of target.items ?? []) {
      if (item.hidden) continue;
      const innerLeft = typeof item.cardInnerLeft === 'number' ? item.cardInnerLeft : target.left;
      const innerRight =
        typeof item.cardInnerRight === 'number' ? item.cardInnerRight : target.right;
      if (
        typeof innerLeft === 'number' &&
        typeof innerRight === 'number' &&
        (item.left < innerLeft - tolerancePx || item.right > innerRight + tolerancePx)
      ) {
        violations.push({
          type: 'content-escape',
          target: target.selector,
          selectorPath: item.selectorPath,
          overflowPx: Math.max(innerLeft - item.left, item.right - innerRight),
        });
      }
      if (!item.hasText || !item.clips) continue;
      const cutWide = item.scrollWidth > item.clientWidth + tolerancePx;
      const cutTall =
        Boolean(item.lineClamped) && item.scrollHeight > item.clientHeight + tolerancePx;
      if (!cutWide && !cutTall) continue;
      if (item.titled && item.clientWidth >= minLabelPx) continue;
      violations.push({
        type: 'text-cut',
        target: target.selector,
        selectorPath: item.selectorPath,
        scrollWidth: item.scrollWidth,
        clientWidth: item.clientWidth,
        scrollHeight: item.scrollHeight,
        clientHeight: item.clientHeight,
        titled: Boolean(item.titled),
      });
    }
  }
  return violations;
}

/**
 * Plan 39.1-49 (orchestrator 2026-09-26, Scout desktop): the viewports a
 * route's fitTargets declare that its own measurement loop does not visit
 * (Scout is measured at 390x844 only, yet its Recent Events text-fit target
 * is also declared at 1440x900). The runner gives each such viewport its own
 * shell=app text-fit load, so a declared target is never silently skipped.
 * Returns viewport names in LAYOUT_ORACLE_VIEWPORTS order.
 */
export function fitViewportsOutsideRoute(route, measuredViewportNames) {
  const declared = new Set((route?.fitTargets ?? []).flatMap((target) => target.viewports ?? []));
  return LAYOUT_ORACLE_VIEWPORTS.map((viewport) => viewport.name).filter(
    (name) => declared.has(name) && !measuredViewportNames.includes(name),
  );
}

// ---------------------------------------------------------------------------
// Plan 39.1-40 (design-audit row 2.6, D-14, UI-SPEC §7.8 rules 1-4): the
// rail-cards family — a reads rail must hold at least `minCards` real cards
// (data-card-kind regular or unlocks-next) and never the engine's synthetic
// "insights aren't available" fallback. Non-vacuity goes through
// evaluateFamilyPresence('rail-cards', rails) at the call site.
// ---------------------------------------------------------------------------

/**
 * Every offending rail, never only the first: `rail-cards-below-min` when a
 * rail renders fewer than `minCards` cards, `rail-fallback-card` when it
 * renders the synthetic fallback card at all. Each rail is
 * `{ selectorPath, cards, fallback, templates }` as guard:layout's collector
 * reports it.
 */
export function evaluateRailCards(rails, { minCards } = {}) {
  const violations = [];
  for (const rail of rails) {
    if (rail.cards < minCards) {
      violations.push({
        type: 'rail-cards-below-min',
        selectorPath: rail.selectorPath,
        cards: rail.cards,
        minCards,
        templates: rail.templates ?? [],
      });
    }
    if (rail.fallback > 0) {
      violations.push({
        type: 'rail-fallback-card',
        selectorPath: rail.selectorPath,
        fallback: rail.fallback,
        templates: rail.templates ?? [],
      });
    }
  }
  return violations;
}

// ---------------------------------------------------------------------------
// Plan 39.1-50 (orchestrator addition OOS-40-A): a steady insight line's dash
// sits on the same line as its text.
// ---------------------------------------------------------------------------

/** How far (px) the dash's vertical centre may sit from the first text glyph's centre. */
export const INSIGHT_LINE_DASH_TOLERANCE_PX = 4;

/**
 * UI-SPEC §7.8 (the non-card insight form): the steady line's 8×2 dash leads
 * its text on the text's FIRST line. Each `line` is `{ selectorPath, dash:
 * rect, firstGlyph: rect }` — `firstGlyph` is the box of the text's first
 * character (a DOM Range), so a dash stranded on a line of its own above the
 * text (the flex-wrap door case) or centred across a wrapped two-line text
 * (the rail's steady line) both miss it. A dash must also precede the glyph
 * horizontally. Returns every offender.
 */
export function evaluateInsightLineDash(lines, tolerancePx = INSIGHT_LINE_DASH_TOLERANCE_PX) {
  const violations = [];
  for (const line of lines) {
    const { selectorPath, dash, firstGlyph } = line;
    const dashCenter = (dash.top + dash.bottom) / 2;
    const glyphCenter = (firstGlyph.top + firstGlyph.bottom) / 2;
    const offsetPx = dashCenter - glyphCenter;
    const precedes = dash.right <= firstGlyph.left + 1;
    if (Math.abs(offsetPx) > tolerancePx || !precedes) {
      violations.push({
        type: 'insight-line-dash-orphan',
        selectorPath,
        offsetPx: Math.round(offsetPx * 10) / 10,
        precedes,
        text: line.text ?? '',
      });
    }
  }
  return violations;
}

// ---------------------------------------------------------------------------
// Plan 39.1-51 (OOS-8, UI-SPEC §6.3 / §6.4 amended 2026-09-26, sketch 003 M14
// "no inner scroller"): the results-list terminus flows in the page. The
// `last-row-visible` family proves its last mounted row is whole and inside no
// vertical scroller; the terminus allowance keeps every page's scroll budget
// exactly as strict as it was while the list sat in its retired 500 px box.
// ---------------------------------------------------------------------------

/**
 * UI-SPEC §6.3 terminus allowance (amended 2026-09-26): the page scroll budget
 * counts at most this many px of a TABLE-layout terminus list — exactly the
 * height its retired fixed-height scroll box always contributed. The stacked
 * (phone) list counts in full.
 */
export const TERMINUS_TABLE_ALLOWANCE_PX = 500;

/** Mirrors `FILTERED_MATCH_LIST_ROW_CAP`: the table layout mounts at most 100 rows per pass. */
export const TERMINUS_TABLE_ROW_CAP = 100;

/** Mirrors `FILTERED_MATCH_LIST_STACK_ROW_CAP`: the stacked layout mounts at most 20 rows per pass. */
export const TERMINUS_STACK_ROW_CAP = 20;

/** A last row may end this many px past a clipping box's visible edge (sub-pixel layout). */
export const LAST_ROW_TOLERANCE_PX = 1;

/**
 * The px the scroll budget leaves out: for each table-layout terminus flow
 * height, the part above `allowancePx`. Pure.
 */
export function terminusBudgetExcessPx(flowHeightsPx, allowancePx = TERMINUS_TABLE_ALLOWANCE_PX) {
  return flowHeightsPx.reduce((sum, heightPx) => sum + Math.max(0, heightPx - allowancePx), 0);
}

/**
 * `lists`: one entry per `[data-slot="filtered-match-list"]` root —
 * `{ selectorPath, layout: 'table' | 'stack' | 'empty', mounted, total,
 * contentPx, lastRow: { top, bottom } | null, clips: [{ selectorPath,
 * overflowY, scrollHeight, clientHeight, visTop, visBottom }] }`, where `clips`
 * are the last row's ancestors (up to body) whose overflow is not visible.
 * Every offender is returned:
 * - `last-row-visible-unmeasured`: no mounted row or no measurable last row;
 * - `terminus-unbounded`: more rows mounted than the layout's pass allows;
 * - `terminus-inner-scroller`: an ancestor that scrolls vertically (overflow-y
 *   auto / scroll AND content taller than its box — geometry, never the class);
 * - `last-row-clipped`: the last row ends past (or starts before) a clipping
 *   ancestor's visible box.
 */
export function evaluateLastRowVisible(lists, { tolerancePx = LAST_ROW_TOLERANCE_PX } = {}) {
  const violations = [];
  for (const list of lists) {
    const { selectorPath, layout, mounted, lastRow, clips = [] } = list;
    if (!mounted || !lastRow) {
      violations.push({ type: 'last-row-visible-unmeasured', selectorPath, layout, mounted });
      continue;
    }
    const cap = layout === 'stack' ? TERMINUS_STACK_ROW_CAP : TERMINUS_TABLE_ROW_CAP;
    if (mounted > cap) {
      violations.push({ type: 'terminus-unbounded', selectorPath, layout, mounted, cap });
    }
    for (const clip of clips) {
      const scrollsVertically =
        (clip.overflowY === 'auto' || clip.overflowY === 'scroll') &&
        clip.scrollHeight > clip.clientHeight + tolerancePx;
      if (scrollsVertically) {
        violations.push({
          type: 'terminus-inner-scroller',
          selectorPath,
          scroller: clip.selectorPath,
          overflowY: clip.overflowY,
          scrollHeight: clip.scrollHeight,
          clientHeight: clip.clientHeight,
        });
      }
      const belowPx = lastRow.bottom - clip.visBottom;
      const abovePx = clip.visTop - lastRow.top;
      if (belowPx > tolerancePx || abovePx > tolerancePx) {
        violations.push({
          type: 'last-row-clipped',
          selectorPath,
          clipper: clip.selectorPath,
          belowPx: Math.round(belowPx * 10) / 10,
          abovePx: Math.round(abovePx * 10) / 10,
        });
      }
    }
  }
  return violations;
}

// ---------------------------------------------------------------------------
// Plan 39.1-41 (sketch 003 A, PD-41-1/2/3): the period-trend-marks family.
// ---------------------------------------------------------------------------

/** The only dot diameters (px) a period trend may draw (plan 37's 5 / 7 / 9). */
export const PERIOD_TREND_DOT_DIAMETERS = [5, 7, 9];

/** Direct value labels: the last, highest and lowest joined periods — never more than three. */
export const PERIOD_TREND_MAX_VALUE_LABELS = 3;

function sameSortedStrings(a, b) {
  const x = [...a].map(String).sort();
  const y = [...b].map(String).sort();
  return x.length === y.length && x.every((value, i) => value === y[i]);
}

/**
 * `surfaces`: one entry per `[data-slot="trend-line-period"]` root —
 * `{ selectorPath, state: 'drawn' | 'locked' | null, yDomain: [lo, hi] | null,
 * dots: [{ key, diameter, subFloor }], valueLabels: [{ key, text }],
 * strokedLineCount, yTickTexts: string[], referenceLabel: string | null }`.
 * `expect`: the route's `periodTrendExpect` — `{ state, yDomain?,
 * dotDiameters?, valueLabels?, referenceLabel? }`. Every offender is returned:
 * - `period-trend-unmeasured`: no surface at all (non-vacuity);
 * - `period-trend-state`: the surface's state is not the expected one (a
 *   locked surface expected locked passes with no further check);
 * - `period-trend-context-series`: stroked line paths other than exactly one;
 * - `period-trend-subfloor-label`: a value label on a sub-floor dot;
 * - `period-trend-label-count`: more than three value labels;
 * - `period-trend-labels`: the label texts differ from the expected set;
 * - `period-trend-dot-size`: a diameter outside {5, 7, 9}, or the distinct
 *   diameters differ from the expected set;
 * - `period-trend-domain`: the declared y-domain differs from the expected one;
 * - `period-trend-reference-label`: the reference label text differs;
 * - `period-trend-axis-edge`: a y tick outside the declared domain, a 0 tick
 *   while the domain starts above 0, or a 100 tick while it ends below 100;
 * - (plan 39.1-43, PD-43-3) `period-trend-value-range`: the measured
 *   `valueRangePx` (the span between the fitted domain's lowest and highest
 *   hairlines) lies outside `expect.valueRangePx` ([min, max]);
 *   `period-trend-value-range-unmeasured`: a drawn surface expected to carry
 *   a range has no measurable hairlines.
 * Every expectation field is optional — an empty expectation checks only
 * the kit invariants (one line, at most three labels, 5 / 7 / 9 dots).
 */
export function evaluatePeriodTrendMarks(surfaces, expect = {}) {
  if (!Array.isArray(surfaces) || surfaces.length === 0) {
    return [{ type: 'period-trend-unmeasured' }];
  }
  const violations = [];
  for (const surface of surfaces) {
    const { selectorPath } = surface;
    if (expect.state && surface.state !== expect.state) {
      violations.push({
        type: 'period-trend-state',
        selectorPath,
        state: surface.state ?? null,
        expected: expect.state,
      });
      continue;
    }
    if (surface.state === 'locked') continue;

    const dots = surface.dots ?? [];
    const valueLabels = surface.valueLabels ?? [];

    if (surface.strokedLineCount !== 1) {
      violations.push({
        type: 'period-trend-context-series',
        selectorPath,
        strokedLineCount: surface.strokedLineCount,
      });
    }

    const subFloorKeys = new Set(dots.filter((dot) => dot.subFloor).map((dot) => dot.key));
    for (const label of valueLabels) {
      if (subFloorKeys.has(label.key)) {
        violations.push({
          type: 'period-trend-subfloor-label',
          selectorPath,
          key: label.key,
          text: label.text,
        });
      }
    }

    if (valueLabels.length > PERIOD_TREND_MAX_VALUE_LABELS) {
      violations.push({
        type: 'period-trend-label-count',
        selectorPath,
        count: valueLabels.length,
      });
    }

    const texts = valueLabels.map((label) => label.text);
    if (expect.valueLabels && !sameSortedStrings(texts, expect.valueLabels)) {
      violations.push({
        type: 'period-trend-labels',
        selectorPath,
        labels: texts,
        expected: expect.valueLabels,
      });
    }

    const diameters = [...new Set(dots.map((dot) => dot.diameter))].sort((a, b) => a - b);
    const outside = diameters.filter((d) => !PERIOD_TREND_DOT_DIAMETERS.includes(d));
    if (
      outside.length > 0 ||
      (expect.dotDiameters && !sameSortedStrings(diameters, expect.dotDiameters))
    ) {
      violations.push({
        type: 'period-trend-dot-size',
        selectorPath,
        diameters,
        expected: expect.dotDiameters ?? PERIOD_TREND_DOT_DIAMETERS,
      });
    }

    const domain = surface.yDomain;
    if (
      expect.yDomain &&
      (!domain || domain[0] !== expect.yDomain[0] || domain[1] !== expect.yDomain[1])
    ) {
      violations.push({
        type: 'period-trend-domain',
        selectorPath,
        yDomain: domain ?? null,
        expected: expect.yDomain,
      });
    }

    if (
      expect.referenceLabel !== undefined &&
      (surface.referenceLabel ?? null) !== expect.referenceLabel
    ) {
      violations.push({
        type: 'period-trend-reference-label',
        selectorPath,
        referenceLabel: surface.referenceLabel ?? null,
        expected: expect.referenceLabel,
      });
    }

    if (expect.valueRangePx) {
      const [minPx, maxPx] = expect.valueRangePx;
      const measured = surface.valueRangePx;
      if (typeof measured !== 'number' || !Number.isFinite(measured)) {
        violations.push({ type: 'period-trend-value-range-unmeasured', selectorPath });
      } else if (measured < minPx || measured > maxPx) {
        violations.push({
          type: 'period-trend-value-range',
          selectorPath,
          valueRangePx: measured,
          expected: expect.valueRangePx,
        });
      }
    }

    if (domain) {
      const [lo, hi] = domain;
      for (const text of surface.yTickTexts ?? []) {
        const value = Number(String(text).replace(/[^\d.-]/g, ''));
        if (!Number.isFinite(value)) continue;
        const offDomain = value < lo || value > hi;
        const zeroEdge = value === 0 && lo > 0;
        const hundredEdge = value === 100 && hi < 100;
        if (offDomain || zeroEdge || hundredEdge) {
          violations.push({
            type: 'period-trend-axis-edge',
            selectorPath,
            tick: text,
            yDomain: domain,
          });
        }
      }
    }
  }
  return violations;
}

/**
 * The one PERIOD_TREND line per measured surface (later plans append fields
 * after `ref=`). `dots` are the sorted distinct diameters; spaces in the
 * reference label print as `_`. Plan 39.1-43 appends ` range=<rounded px>`
 * (the measured value range) or ` range=none`.
 */
export function formatPeriodTrendLine(routeId, viewportName, surface) {
  const domain = surface.yDomain ? `${surface.yDomain[0]},${surface.yDomain[1]}` : 'none';
  const dots = [...new Set((surface.dots ?? []).map((dot) => dot.diameter))]
    .sort((a, b) => a - b)
    .join(',');
  const labels = (surface.valueLabels ?? []).map((label) => label.text).join('|');
  // Plan 39.1-43 (OOS-6 fallback): a rate stated by the head's reference
  // legend item (no direct label — every slot was taken) prints as legend:<text>.
  const refText = surface.referenceLabel ? surface.referenceLabel.replace(/\s+/g, '_') : 'none';
  const ref =
    surface.referenceLabel && surface.referenceLabelSource === 'legend'
      ? `legend:${refText}`
      : refText;
  const range =
    typeof surface.valueRangePx === 'number' && Number.isFinite(surface.valueRangePx)
      ? String(Math.round(surface.valueRangePx))
      : 'none';
  return `PERIOD_TREND route=${routeId} viewport=${viewportName} state=${surface.state ?? 'none'} domain=${domain} dots=${dots || 'none'} labels=${labels || 'none'} lines=${surface.strokedLineCount ?? 0} ref=${ref} range=${range}`;
}

// ---------------------------------------------------------------------------
// Plan 39.1-43b (fidelity follow-up to 39.1-43): the period trend's AXIS
// against sketch 003 A's `trend()` CSS (the same rules sketch 001-C draws):
//   .trend.gutter{margin-left:26px}                        -> gutterPx 26
//   .trend .ytick{left:-26px;width:20px;text-align:right;   -> tickGapPx 6
//     font-size:10px;color:var(--color-text-muted)}        -> tick 10px, muted
//   .xaxis{font-size:10px;color:var(--color-text-muted)}    -> x labels 10px, muted
//   .trend .val{font-size:10px;font-weight:600}            -> value labels 10px / 600,
//     no colour of their own (the body's --color-text)     -> foreground
//   .trend .ref-label{font-size:10px;color:...-muted}      -> reference label 10px
//   step = hi - lo > 50 ? 20 : 10; for (g = lo; g <= hi; g += step)
//   .trend .grid-y only — no vertical grid, no axis line, no tick mark.
// ---------------------------------------------------------------------------

/**
 * Plan 39.1-43b: the value range (px) a period trend draws its fitted domain
 * across, from the hairlines drawn at y ticks. A sketch-stepped axis need not
 * put a hairline on the domain's top ([20, 90] ticks 20 / 40 / 60 / 80, the
 * top of the box is 90), so the span is the hairlines' px-per-point scale
 * times the declared domain's span. With no declared domain, or a domain the
 * hairlines already bound, it is the plain hairline span.
 * `ticks`: `[{ value, y }]` (the hairline-matched ticks). Returns null when
 * fewer than two distinct ticks were measured.
 */
export function periodValueRangeFromTicks(ticks, yDomain) {
  const usable = (ticks ?? []).filter(
    (tick) => Number.isFinite(tick?.value) && Number.isFinite(tick?.y),
  );
  if (usable.length < 2) return null;
  const low = usable.reduce((a, b) => (b.value < a.value ? b : a));
  const high = usable.reduce((a, b) => (b.value > a.value ? b : a));
  if (!(high.value > low.value)) return null;
  const spanPx = Math.abs(low.y - high.y);
  if (!Array.isArray(yDomain) || !(yDomain[1] > yDomain[0])) return spanPx;
  return (spanPx / (high.value - low.value)) * (yDomain[1] - yDomain[0]);
}

/** Sketch 003 A / 001-C: every axis label (y tick, x label, value label, reference label) is 10px. */
export const PERIOD_TREND_AXIS_FONT_PX = 10;
/** Sketch `.trend .val{font-weight:600}`. */
export const PERIOD_TREND_VALUE_LABEL_WEIGHT = 600;
/** Sketch `.trend.gutter{margin-left:26px}`: the plot's left edge sits 26px right of the head's. */
export const PERIOD_TREND_GUTTER_PX = 26;
/** Sketch `.ytick{left:-26px;width:20px;text-align:right}`: 6px from a tick's right edge to the plot. */
export const PERIOD_TREND_TICK_GAP_PX = 6;
/** Tolerance (px) on the gutter and the tick gap — sub-pixel text metrics. */
export const PERIOD_TREND_AXIS_TOLERANCE_PX = 1;

/**
 * The sketch 003 `trend()` y tick step for a fitted [lo, hi] domain:
 * `hi - lo > 50 ? 20 : 10`, ticks `lo, lo + step, ... <= hi`.
 */
export function sketchPeriodTickValues(yDomain) {
  const [lo, hi] = yDomain;
  const step = hi - lo > 50 ? 20 : 10;
  const values = [];
  for (let g = lo; g <= hi; g += step) values.push(g);
  return values;
}

function distinctNumbers(values) {
  return [...new Set((values ?? []).filter((v) => Number.isFinite(v)))].sort((a, b) => a - b);
}

function distinctStrings(values) {
  return [...new Set((values ?? []).filter((v) => typeof v === 'string' && v.length > 0))].sort();
}

/**
 * `surfaces`: the period-trend records (the same roots period-trend-marks
 * reads), each carrying `axis`:
 * `{ yTickValues: number[], yTickFontPx: number[], yTickColorTokens: string[],
 *    xTickFontPx: number[], xTickColorTokens: string[],
 *    valueLabelFontPx: number[], valueLabelWeights: number[], valueLabelColorTokens: string[],
 *    referenceLabelFontPx: number[], gutterPx: number | null, tickGapPx: number | null,
 *    verticalGridLines: number, axisLines: number, strayHairlines: number }`.
 * `expect`: the route's `periodTrendAxisExpect` — every field optional:
 * `{ tickValues?, tickFontPx?, tickColorToken?, xFontPx?, xColorToken?,
 *    valueLabelFontPx?, valueLabelWeight?, valueLabelColorToken?,
 *    referenceLabelFontPx?, gutterPx?, tickGapPx?, verticalGridLines?,
 *    axisLines?, strayHairlines? }`. A locked surface is skipped. Every
 * offender is returned:
 * - `period-trend-axis-unmeasured`: no drawn surface, or a drawn surface with
 *   no `axis` record, or an expected field whose elements were not found;
 * - `period-trend-axis-ticks`: the y tick values differ (step and count);
 * - `period-trend-axis-tick-font` / `-tick-color`;
 * - `period-trend-axis-x-font` / `-x-color`;
 * - `period-trend-axis-value-label-font` / `-value-label-weight` / `-value-label-color`;
 * - `period-trend-axis-reference-label-font` (only a DIRECT label is measured);
 * - `period-trend-axis-gutter` / `-tick-gap`: outside ± PERIOD_TREND_AXIS_TOLERANCE_PX;
 * - `period-trend-axis-vertical-grid` / `-axis-line` / `-stray-hairline`: a count that differs.
 */
export function evaluatePeriodTrendAxis(surfaces, expect = {}) {
  const drawn = (surfaces ?? []).filter((surface) => surface?.state !== 'locked');
  if (drawn.length === 0) {
    return [{ type: 'period-trend-axis-unmeasured', field: 'surface' }];
  }
  const violations = [];
  for (const surface of drawn) {
    const { selectorPath } = surface;
    const axis = surface.axis;
    if (!axis) {
      violations.push({ type: 'period-trend-axis-unmeasured', selectorPath, field: 'axis' });
      continue;
    }
    if (expect.tickValues) {
      const values = distinctNumbers(axis.yTickValues);
      if (values.length === 0) {
        violations.push({ type: 'period-trend-axis-unmeasured', selectorPath, field: 'ticks' });
      } else if (
        values.length !== expect.tickValues.length ||
        values.some((value, i) => value !== expect.tickValues[i])
      ) {
        violations.push({
          type: 'period-trend-axis-ticks',
          selectorPath,
          ticks: values,
          expected: expect.tickValues,
        });
      }
    }
    const numberField = (field, measuredList, expected, type) => {
      if (expected === undefined) return;
      const measured = distinctNumbers(measuredList);
      if (measured.length === 0) {
        violations.push({ type: 'period-trend-axis-unmeasured', selectorPath, field });
      } else if (measured.length !== 1 || measured[0] !== expected) {
        violations.push({ type, selectorPath, measured, expected });
      }
    };
    const tokenField = (field, measuredList, expected, type) => {
      if (expected === undefined) return;
      const measured = distinctStrings(measuredList);
      if (measured.length === 0) {
        violations.push({ type: 'period-trend-axis-unmeasured', selectorPath, field });
      } else if (measured.length !== 1 || measured[0] !== expected) {
        violations.push({ type, selectorPath, measured, expected });
      }
    };
    numberField('tickFont', axis.yTickFontPx, expect.tickFontPx, 'period-trend-axis-tick-font');
    tokenField(
      'tickColor',
      axis.yTickColorTokens,
      expect.tickColorToken,
      'period-trend-axis-tick-color',
    );
    numberField('xFont', axis.xTickFontPx, expect.xFontPx, 'period-trend-axis-x-font');
    tokenField('xColor', axis.xTickColorTokens, expect.xColorToken, 'period-trend-axis-x-color');
    numberField(
      'valueLabelFont',
      axis.valueLabelFontPx,
      expect.valueLabelFontPx,
      'period-trend-axis-value-label-font',
    );
    numberField(
      'valueLabelWeight',
      axis.valueLabelWeights,
      expect.valueLabelWeight,
      'period-trend-axis-value-label-weight',
    );
    tokenField(
      'valueLabelColor',
      axis.valueLabelColorTokens,
      expect.valueLabelColorToken,
      'period-trend-axis-value-label-color',
    );
    // The OOS-6 fallback draws no direct reference label: nothing to measure.
    if (expect.referenceLabelFontPx !== undefined && (axis.referenceLabelFontPx ?? []).length > 0) {
      numberField(
        'referenceLabelFont',
        axis.referenceLabelFontPx,
        expect.referenceLabelFontPx,
        'period-trend-axis-reference-label-font',
      );
    }
    const pxField = (field, measured, expected, type) => {
      if (expected === undefined) return;
      if (typeof measured !== 'number' || !Number.isFinite(measured)) {
        violations.push({ type: 'period-trend-axis-unmeasured', selectorPath, field });
      } else if (Math.abs(measured - expected) > PERIOD_TREND_AXIS_TOLERANCE_PX) {
        violations.push({ type, selectorPath, measured, expected });
      }
    };
    pxField('gutter', axis.gutterPx, expect.gutterPx, 'period-trend-axis-gutter');
    pxField('tickGap', axis.tickGapPx, expect.tickGapPx, 'period-trend-axis-tick-gap');
    const countField = (measured, expected, type) => {
      if (expected === undefined) return;
      if ((measured ?? 0) !== expected) {
        violations.push({ type, selectorPath, measured: measured ?? 0, expected });
      }
    };
    countField(axis.verticalGridLines, expect.verticalGridLines, 'period-trend-axis-vertical-grid');
    countField(axis.axisLines, expect.axisLines, 'period-trend-axis-axis-line');
    countField(axis.strayHairlines, expect.strayHairlines, 'period-trend-axis-stray-hairline');
  }
  return violations;
}

function formatList(values) {
  return values.length > 0 ? values.join(',') : 'none';
}

/** One PERIOD_TREND_AXIS line per measured drawn surface (printed whether or not it passed). */
export function formatPeriodTrendAxisLine(routeId, viewportName, surface) {
  const axis = surface.axis ?? {};
  const px = (value) =>
    typeof value === 'number' && Number.isFinite(value) ? value.toFixed(1) : 'none';
  const ticks = distinctNumbers(axis.yTickValues);
  const steps = distinctNumbers(ticks.slice(1).map((value, i) => value - ticks[i]));
  return [
    `PERIOD_TREND_AXIS route=${routeId} viewport=${viewportName}`,
    `state=${surface.state ?? 'none'}`,
    `step=${formatList(steps)}`,
    `ticks=${formatList(ticks)}`,
    `count=${ticks.length}`,
    `tickFont=${formatList(distinctNumbers(axis.yTickFontPx))}`,
    `tickColor=${formatList(distinctStrings(axis.yTickColorTokens))}`,
    `xFont=${formatList(distinctNumbers(axis.xTickFontPx))}`,
    `xColor=${formatList(distinctStrings(axis.xTickColorTokens))}`,
    `valueFont=${formatList(distinctNumbers(axis.valueLabelFontPx))}`,
    `valueWeight=${formatList(distinctNumbers(axis.valueLabelWeights))}`,
    `valueColor=${formatList(distinctStrings(axis.valueLabelColorTokens))}`,
    `refFont=${formatList(distinctNumbers(axis.referenceLabelFontPx))}`,
    `gutter=${px(axis.gutterPx)}`,
    `tickGap=${px(axis.tickGapPx)}`,
    `vgrid=${axis.verticalGridLines ?? 0}`,
    `axisLines=${axis.axisLines ?? 0}`,
    `strayHairlines=${axis.strayHairlines ?? 0}`,
  ].join(' ');
}
