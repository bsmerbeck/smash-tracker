#!/usr/bin/env node
/**
 * UIX-01/UIX-03/UIX-06 browser-measured layout oracle (Phase 39.1 Plan 09).
 * Real Chrome, a route-capable dev-only harness (`guard-layout.html` →
 * `src/guardHarness/main.tsx` → `guardHarnessRoutes.tsx`), fixture data —
 * copies `apps/web/scripts/scl01BrowserBudget.mjs`'s shape exactly: starts
 * the harness server bound to the loopback address, launches Puppeteer, and
 * for each route in `LAYOUT_ORACLE_ROUTES` and each of the three viewports,
 * navigates to `guard-layout.html` with that route's id, evaluates UI-SPEC
 * §13.1's four conditions through `guardLayoutCore.mjs`, and collects every
 * violation it finds. ALWAYS shuts the browser and the server down (a hard
 * timeout plus a `try/finally` double shutdown), so this process can never
 * hang — this repo has a zombie-CLI history (`enrichDemoAccounts.ts`).
 *
 * USAGE:
 *   pnpm --filter @smash-tracker/web run guard:layout
 *
 * Plan 39.1-20 Task 3 added the eight real analytics routes to BOTH — the
 * route table in `guardHarnessRoutes.tsx` (so they can be mounted) and this
 * array (so they are measured), keeping the stretch fixture route too
 * (behind `VITE_GUARD_LAYOUT_STRETCH_FIXTURE`, plan 39.1-09's own env flag)
 * so its own failing case stays runnable.
 *
 * A route whose page-loaded marker never appears is reported as UNMEASURED
 * and makes the run exit non-zero — it is never scored as a clean pass
 * (T-39.1-09-06). A trailing `MEASURED_ROUTES=<n>` /
 * `UNMEASURED_ROUTES=<ids or NONE>` summary pair makes both numbers
 * recordable.
 */
import puppeteer from 'puppeteer';
import { buildRecentScale, startGuardLayoutHarnessServer } from './guardLayoutHarness.mjs';
import { buildGuardDigestSeed } from './digestGuardFixture.mjs';
import {
  evaluateStretch,
  evaluateScrollBudget,
  evaluateHorizontalOverflow,
  evaluateTruncation,
  evaluateCardContentOverflow,
  evaluateHeaderSqueeze,
  evaluateAxisTicks,
  evaluateAxisPresence,
  evaluatePlotAspect,
  evaluateGridBalance,
  evaluateFamilyPresence,
  evaluatePickerAlignment,
  evaluateRowCohesion,
  evaluateRowTagLegibility,
  evaluateNestedScrollers,
  evaluateCardHeightCeilings,
  evaluateFormStripFit,
  evaluateCareerTimeline,
  careerTimelineEdgeDeltas,
  evaluateFilterRow,
  evaluateStatRowColumns,
  evaluatePlacement,
  evaluateInsightOrder,
  evaluateTableClip,
  evaluateBrandRedText,
  evaluateRecordFit,
  evaluateMarkCount,
  evaluateMatrixHug,
  evaluateTableClipSweep,
  evaluateTextFit,
  evaluateRailCards,
  evaluateInsightLineDash,
  evaluateLastRowVisible,
  evaluatePeriodTrendMarks,
  formatPeriodTrendLine,
  evaluatePeriodTrendAxis,
  formatPeriodTrendAxisLine,
  periodValueRangeFromTicks,
  sketchPeriodTickValues,
  PERIOD_TREND_AXIS_FONT_PX,
  PERIOD_TREND_VALUE_LABEL_WEIGHT,
  PERIOD_TREND_GUTTER_PX,
  PERIOD_TREND_TICK_GAP_PX,
  evaluateFormStripLabels,
  formatFormStripLine,
  terminusBudgetExcessPx,
  tableClipModeForRoute,
  headerSqueezeConfigForRoute,
  tableClipSweepRoutes,
  tableClipSweepScanned,
  fitTargetsForViewport,
  fitViewportsOutsideRoute,
  runRoutePrepare,
  TABLE_CLIP_SCAN_SELECTOR,
  DEFAULT_SCROLL_BUDGETS,
  MATCHUPS_SCROLL_BUDGET_390X844,
  WIN_RATE_TREND_CARD_MAX_VIEWPORT_HEIGHTS,
  LAYOUT_ORACLE_VIEWPORTS,
  EXTRA_ORACLE_VIEWPORTS,
  NARROW_VIEWPORT_MAX_WIDTH_PX,
} from './guardLayoutCore.mjs';

/**
 * Mirrors `apps/web/src/guardHarness/guardHarnessRoutes.tsx`'s `id` and
 * `loadedMarker` fields by hand: this is a plain Node script with no JSX/TS
 * transform in front of it, so it cannot `import` the `.tsx` route table
 * directly. Plan 39.1-20 adds one entry here per real analytics route,
 * copied from the same route table entries it adds there.
 */

/**
 * Plan 39.1-43b: a period trend's axis expectation, every value taken from
 * sketch 003 A's `trend()` CSS (sketch 001-C draws the same rules): the
 * y ticks `sketchPeriodTickValues(domain)`; 10px muted ticks and x labels;
 * 10px / 600 value labels in the body text colour (`.val` sets none of its
 * own); a 10px reference label; the plot 26px right of the head
 * (`.trend.gutter`) with 6px between a tick's right edge and the plot
 * (`.ytick{left:-26px;width:20px}`); horizontal hairlines only, at ticks.
 */
function periodTrendAxisExpectFor(domain) {
  return {
    tickValues: sketchPeriodTickValues(domain),
    tickFontPx: PERIOD_TREND_AXIS_FONT_PX,
    tickColorToken: 'muted-foreground',
    xFontPx: PERIOD_TREND_AXIS_FONT_PX,
    xColorToken: 'muted-foreground',
    valueLabelFontPx: PERIOD_TREND_AXIS_FONT_PX,
    valueLabelWeight: PERIOD_TREND_VALUE_LABEL_WEIGHT,
    valueLabelColorToken: 'foreground',
    referenceLabelFontPx: PERIOD_TREND_AXIS_FONT_PX,
    gutterPx: PERIOD_TREND_GUTTER_PX,
    tickGapPx: PERIOD_TREND_TICK_GAP_PX,
    verticalGridLines: 0,
    axisLines: 0,
    strayHairlines: 0,
  };
}

/**
 * Plan 39.2-12 (UI-SPEC G1): the Dashboard routes are measured with an EXPANDED
 * digest and 25 tracked items. The digest's device-local snapshot is seeded before
 * the app boots (`storageSeed`), and the prepare steps PROVE the seed took by
 * waiting on the expanded card, its moved rows and "and N more", then open the
 * Tracked list to all 25 — a route where any of them never appears is UNMEASURED,
 * never a pass over a quiet card.
 */
const DASHBOARD_DIGEST_SEED = buildGuardDigestSeed(buildRecentScale().matches);
const DASHBOARD_DIGEST_PREPARE = [
  { type: 'wait', selector: '#digest[data-state="expanded"]' },
  { type: 'wait', selector: '#digest [data-slot="digest-moved-list"] > li' },
  { type: 'wait', selector: '#digest [data-slot="digest-more"]' },
  { type: 'wait', selector: '#tracked [data-slot="tracked-row"]' },
  { type: 'click', selector: '#tracked [data-slot="bounded-list"] > button' },
  { type: 'wait', selector: '#tracked [data-slot="collapsible-content"][data-state="open"]' },
];

export const LAYOUT_ORACLE_ROUTES = [
  {
    id: 'stretched-card-fixture',
    loadedMarker: '[data-guard-loaded="stretched-card-fixture"]',
  },
  {
    // CR-01 (39.1-REVIEW.md): fixed-width period charts at the review's
    // reproduced overlap lengths (month n=17 @262px, game n=10 @829px). The
    // charts never depend on the viewport, so one viewport measures them.
    id: 'period-axis-ticks-fixture',
    loadedMarker: '[data-guard-loaded="period-axis-ticks-fixture"]',
    checks: ['axis-ticks'],
    viewports: ['1440x900'],
  },
  {
    id: 'dashboard',
    loadedMarker: '[data-slot="dashboard-body"]',
    // Plan 39.2-12: the wall-clock `recent` scale, not `realistic` — the realistic fixture's
    // games are all in 2023, so every tracked item reads `locked` at the digest's fixed
    // last-30 horizon and nothing can have MOVED. A current account is what the digest
    // and the Tracked section exist for.
    scale: 'recent',
    storageSeed: DASHBOARD_DIGEST_SEED,
    prepare: DASHBOARD_DIGEST_PREPARE,
    // Plan 39.1-38: the toolbar is the one unboxed filter row (no page h1 —
    // the Dashboard has none); phone StatRows collapse to two columns.
    // Plan 39.1-39: record-fit (the split cards' two records never
    // overprint or leave their cells) and brand-red-text (UI-SPEC §4.3).
    checks: ['filter-row', 'record-fit', 'brand-red-text'],
    filterRow: { maxHeightPx: 72, owns: ['[data-slot="horizon-switch"]'] },
    narrowChecks: ['stat-row-columns'],
  },
  {
    // Plan 39.1-39: the SAME Dashboard inside the MainLayout-geometry shell
    // (production card widths) — where 39.1-36's shelled capture recorded
    // the Casual vs Competitive / Online vs Offline record overprint.
    id: 'dashboard-app',
    loadedMarker: '[data-slot="dashboard-body"]',
    // Plan 39.2-12: the wall-clock `recent` scale, not `realistic` — the realistic fixture's
    // games are all in 2023, so every tracked item reads `locked` at the digest's fixed
    // last-30 horizon and nothing can have MOVED. A current account is what the digest
    // and the Tracked section exist for.
    scale: 'recent',
    storageSeed: DASHBOARD_DIGEST_SEED,
    prepare: DASHBOARD_DIGEST_PREPARE,
    checks: ['record-fit', 'brand-red-text'],
  },
  {
    id: 'fighter-analysis',
    loadedMarker: '[data-slot="fighter-hero-body"]',
    // Plan 39.1-33: form-strip-fit — no extra viewport, no scroll budget.
    // Plan 39.1-37: axis-ticks (incl. reference-label-collision) on the hero's
    // period trend.
    // Plan 39.1-38: filter-row (one unboxed row owning the h1 and the
    // HorizonSwitch) and placement (sketch 001-C: the vs lists 2-up inside
    // the hero's 8-col column, directly under the hero).
    // Plan 39.1-39: brand-red-text (UI-SPEC §4.3) on every analytics route.
    // Plan 39.1-50 (OOS-11, UI-SPEC §7.8 rule 5): header-squeeze scoped to
    // the insight-rail header's overline.
    checks: [
      'form-strip-fit',
      // Plan 39.1-42: labelled events, older events drop first (sketch 003).
      'form-strip-labels',
      'axis-ticks',
      'filter-row',
      'placement',
      'brand-red-text',
      'header-squeeze',
      // Plan 39.1-43 (PD-43-3, fidelity F4): the hero trend draws sketch
      // 001-C's 160px value range (plan 37 proved it drawn on this fixture).
      'period-trend-marks',
      // Plan 39.1-43b: the trend's axis against sketch 001-C / 003 A's CSS.
      'period-trend-axis',
    ],
    periodTrendExpect: { state: 'drawn', valueRangePx: [158, 162] },
    // Plan 39.1-43b: the realistic fixture fits [20, 90] — sketch 003's
    // `trend()` steps a span above 50 by 20 from lo: 20 / 40 / 60 / 80.
    periodTrendAxisExpect: periodTrendAxisExpectFor([20, 90]),
    headerSqueeze: {
      header: '[data-slot="insight-rail-header"]',
      parts: [{ role: 'overline', selector: '[data-slot="insight-rail-overline"]' }],
    },
    filterRow: { maxHeightPx: 72, owns: ['h1', '[data-slot="horizon-switch"]'] },
    placement: [
      {
        kind: 'within-column',
        subject: '[data-slot="fighter-vs-lists"]',
        // The hero column = the closest GridCell ([data-span]) of the hero body.
        anchor: { closest: '[data-span]', of: '[data-slot="fighter-hero-body"]' },
        gapPx: 16,
      },
      { kind: 'side-by-side', parent: '[data-slot="fighter-vs-lists"]', minPageWidthPx: 860 },
    ],
    // Plan 39.1-38: phone-only (DD-07 reading order hero -> rail -> lists; the
    // plain two-column StatRow collapse).
    narrowChecks: ['stat-row-columns', 'insight-order'],
    orderPairs: [
      { first: '[data-slot="fighter-hero-body"]', then: '[data-slot="insight-rail"]' },
      { first: '[data-slot="insight-rail"]', then: '[data-slot="fighter-vs-lists"]' },
    ],
    // Plan 39.1-49: declared into the all-route table-clip sweep (clipTargets
    // only — no new narrowChecks, so this route's own measurements are
    // unchanged).
    clipTargets: ['[data-slot="matchup-stage-guide"]', '[data-slot="opponent-table"]'],
  },
  {
    id: 'matchups',
    loadedMarker: '[data-slot="matchup-chart-body"]',
    // Plan 39.1-30: the only route opted into the four new oracle families
    // and the two extra viewports — every other route's measurement stays
    // byte-unchanged (three viewports, zero new checks).
    // Plan 39.1-41 (PD-41-1): 'axis-ticks' MOVED to matchups-sketch-deep —
    // this realistic pairing (one week of games) now shows the locked
    // quarterly trend, so it has no period axis to measure. Moved, never
    // dropped.
    checks: [
      'content-overflow',
      'header-squeeze',
      'grid-balance',
      'picker-alignment',
      'row-cohesion',
      // Plan 39.1-33: the single-row form-strip family.
      'form-strip-fit',
      // Plan 39.1-42: labelled events, older events drop first (sketch 003).
      'form-strip-labels',
      // Plan 39.1-39: no brand-red text (UI-SPEC §4.3).
      'brand-red-text',
      // Plan 39.1-51 (OOS-8): the results list's last row is whole, inside no
      // vertical scroller.
      'last-row-visible',
    ],
    extraViewports: ['1024x768', '1280x800'],
    // Plan 39.1-32: evaluated ONLY at viewports up to NARROW_VIEWPORT_MAX_WIDTH_PX
    // wide (UI-SPEC §6.6 "below 640") — every other route's `narrowChecks` is
    // `undefined`, so `measureRouteAtViewport` requests none for them.
    // Plan 39.1-33 adds card-height-ceiling (the Win Rate Trend card, a
    // phone-only ceiling).
    narrowChecks: ['row-tag-legibility', 'nested-scroll', 'card-height-ceiling'],
    // Plan 39.1-33: Matchups' own phone scroll budget, merged over
    // DEFAULT_SCROLL_BUDGETS — see evaluateScrollBudget's doc comment.
    scrollBudgets: { '390x844': MATCHUPS_SCROLL_BUDGET_390X844 },
    // Plan 39.1-33: the Win Rate Trend ChartCard is the closest
    // [data-slot="card"] ancestor of the route's own loaded marker — no new
    // hook needed.
    cardHeightCeilings: [
      {
        marker: '[data-slot="matchup-chart-body"]',
        maxViewportHeights: WIN_RATE_TREND_CARD_MAX_VIEWPORT_HEIGHTS,
      },
    ],
  },
  {
    // Plan 39.1-41 (sketch 003 tracer, PD-41-1): the Matchups page on sketch
    // 003's OWN deep pairing (Cloud vs Pyra/Mythra, 102 games; harness scale
    // `sketch003`). The period-trend-marks family pins the approved trend —
    // quarterly, 5 / 7 px tier dots, one data line, the fitted [20, 100]
    // domain, labels on the last / max / min joined quarters and the
    // "63% all time" hairline label (brief section 4) — and axis-ticks moves
    // here from `matchups`, whose realistic one-week pairing now shows the
    // locked quarterly state.
    id: 'matchups-sketch-deep',
    loadedMarker: '[data-slot="matchup-chart-body"]',
    scale: 'sketch003',
    checks: [
      'period-trend-marks',
      'form-strip-fit',
      // Plan 39.1-42: labelled events, older events drop first (sketch 003).
      'form-strip-labels',
      'brand-red-text',
      'content-overflow',
      'axis-ticks',
      // Plan 39.1-43b: the trend's axis against sketch 003 A's CSS.
      'period-trend-axis',
    ],
    // Plan 39.1-43b: sketch 003 A deep draws 20 / 40 / 60 / 80 / 100.
    periodTrendAxisExpect: periodTrendAxisExpectFor([20, 100]),
    periodTrendExpect: {
      state: 'drawn',
      yDomain: [20, 100],
      dotDiameters: [5, 7],
      valueLabels: ['100%', '33%', '60%'],
      referenceLabel: '63% all time',
      // Plan 39.1-43 (PD-43-3): sketch 003's `trend(d, { height: 160 })` box.
      valueRangePx: [158, 162],
    },
  },
  {
    // Plan 39.1-41: the thin pairing (Pikachu vs Joker, 11 games, one quarter
    // at the floor) honestly locks the trend.
    id: 'matchups-sketch-thin',
    loadedMarker: '[data-slot="matchup-chart-body"]',
    scale: 'sketch003',
    // Plan 39.1-42: form-strip-labels (labelled events, sketch 003).
    checks: [
      'period-trend-marks',
      'form-strip-fit',
      'form-strip-labels',
      'brand-red-text',
      'content-overflow',
    ],
    periodTrendExpect: { state: 'locked' },
  },
  {
    id: 'match-data',
    loadedMarker: '[data-slot="match-data-rail"]',
    // Plan 39.1-38: one unboxed filter row owning the page h1 and the switch;
    // phone StatRows collapse to two columns.
    // Plan 39.1-38 Task 3 (UI-SPEC §8.4 "insight before chart"): on a phone
    // the rail renders before the match table; at 1024+ the table keeps its
    // desktop place above the rail (grid placement, never `order`).
    // Plan 39.1-50 (OOS-11): header-squeeze scoped to the rail header.
    checks: ['filter-row', 'placement', 'brand-red-text', 'header-squeeze'],
    headerSqueeze: {
      header: '[data-slot="insight-rail-header"]',
      parts: [{ role: 'overline', selector: '[data-slot="insight-rail-overline"]' }],
    },
    filterRow: { maxHeightPx: 72, owns: ['h1', '[data-slot="horizon-switch"]'] },
    placement: [
      { kind: 'above', first: '#match-data-table', then: '[data-slot="match-data-rail"]' },
    ],
    narrowChecks: ['stat-row-columns', 'insight-order'],
    orderPairs: [{ first: '[data-slot="match-data-rail"]', then: '#match-data-table' }],
    // Plan 39.1-49 (OOS-3, OOS-10): the text-fit family's declared targets —
    // the Stage Breakdown and Roster Usage lists and the match table's
    // toolbar, at the phone width and at 1440.
    // Plan 39.1-49 Task 2: the converted match table declared into the sweep.
    clipTargets: ['[data-slot="match-table"]'],
    fitTargets: [
      { selector: '[data-slot="stage-breakdown"]', viewports: ['390x844', '1440x900'] },
      { selector: '[data-slot="roster-usage"]', viewports: ['390x844', '1440x900'] },
      { selector: '[data-slot="match-table-toolbar"]', viewports: ['390x844', '1440x900'] },
    ],
  },
  {
    id: 'trends',
    loadedMarker: '[data-slot="trends-hero-body"]',
    // Plan 39.1-34: the career-timeline family on the realistic (one-month,
    // thin) account — alignment, mark bounds and the no-canvas rule.
    // Plan 39.1-38: one unboxed filter row owning the h1 and the switch;
    // phone StatRows collapse to two columns (the KPI lead spans, 002-C).
    // Plan 39.1-38 Task 3 (UI-SPEC §8.2 "insight before chart"): on a phone
    // the reads rail renders directly after the stat row and before the
    // career timeline; at 1024+ the timeline keeps its desktop place above
    // the rails (grid placement, never `order`).
    // Plan 39.1-40 (design-audit row 2.6, D-14): grid-balance on the row-3
    // rails and the reads-rail card count.
    checks: [
      'career-timeline',
      'filter-row',
      'placement',
      'brand-red-text',
      'grid-balance',
      'rail-cards',
      // Plan 39.1-50 (OOS-11): header-squeeze scoped to the rail header.
      'header-squeeze',
      // Plan 39.1-50 (OOS-40-A): each steady insight line's dash sits on its
      // text's first line (Setting Comparison, Match-Type Mix, the rail).
      'insight-line-dash',
    ],
    headerSqueeze: {
      header: '[data-slot="insight-rail-header"]',
      parts: [{ role: 'overline', selector: '[data-slot="insight-rail-overline"]' }],
    },
    railCards: { selector: '[data-slot="trends-reads-rail"]', minCards: 2 },
    // The reads rail's cards are InsightCards (data-slot="insight-card"), so
    // grid-balance counts them too — otherwise the centre cell of row 3 is
    // invisible to the family (no pair, and a false dead-gap across it at
    // 390).
    gridBalance: { cardSelector: '[data-slot="card"], [data-slot="insight-card"]' },
    filterRow: { maxHeightPx: 72, owns: ['h1', '[data-slot="horizon-switch"]'] },
    placement: [
      {
        kind: 'above',
        first: '[data-slot="career-timeline"]',
        then: '[data-slot="trends-reads-rail"]',
      },
    ],
    narrowChecks: ['stat-row-columns', 'insight-order'],
    orderPairs: [
      { first: '[data-slot="trends-hero-body"]', then: '[data-slot="trends-reads-rail"]' },
      { first: '[data-slot="trends-reads-rail"]', then: '[data-slot="career-timeline"]' },
    ],
    // Plan 39.1-40 (OOS-4): the Sessions & Tilt rows' dates must read whole.
    fitTargets: [
      { selector: '[data-slot="sessions-and-tilt"]', viewports: ['1440x900', '390x844'] },
    ],
  },
  {
    // Plan 39.1-34: the ONE sparg0-shaped dataset (8,400 games over ~7.7
    // years, `guardLayoutHarness.mjs`'s `career` scale, selected per page via
    // the `x-guard-layout-scale` request header), mounted inside the
    // MainLayout-geometry app shell so the plot is measured at production
    // content widths — month strips at 2560/1440, quarter strips at 390.
    id: 'trends-career',
    loadedMarker: '[data-slot="trends-hero-body"]',
    scale: 'career',
    // Plan 39.1-40: the steady 8,400-game account back-fills (D-14).
    // Plan 39.1-50 (OOS-40-A): insight-line-dash at production card widths
    // (this route renders inside the MainLayout-geometry shell).
    checks: ['career-timeline', 'rail-cards', 'insight-line-dash'],
    railCards: { selector: '[data-slot="trends-reads-rail"]', minCards: 2 },
    timelineExpect: { strips: true, state: 'full' },
    // Plan 39.1-40 (OOS-4): the Sessions & Tilt rows' dates must read whole.
    fitTargets: [
      { selector: '[data-slot="sessions-and-tilt"]', viewports: ['1440x900', '390x844'] },
    ],
  },
  {
    // Plan 39.1-35: the casual account (41 games over three months,
    // `guardLayoutHarness.mjs`'s `casual` scale) — the timeline's THIN state
    // must render its per-session line AND the per-game FormStrip in place of
    // the month strips, inside the MainLayout-geometry shell.
    id: 'trends-casual',
    loadedMarker: '[data-slot="trends-hero-body"]',
    scale: 'casual',
    // Plan 39.1-40: a thin account keeps its lead card (UI-SPEC §8.2).
    // Plan 39.1-42: the thin FormStrip joins the strip families — one row
    // (form-strip-fit) and labelled events (form-strip-labels); T1 reads its
    // FORM_STRIP games=<drawn>/<total> (all 41 at every viewport).
    checks: ['career-timeline', 'rail-cards', 'form-strip-fit', 'form-strip-labels'],
    railCards: { selector: '[data-slot="trends-reads-rail"]', minCards: 1 },
    timelineExpect: { state: 'thin', formStrip: true },
    // Plan 39.1-40 (OOS-4): the Sessions & Tilt rows' dates must read whole.
    fitTargets: [
      { selector: '[data-slot="sessions-and-tilt"]', viewports: ['1440x900', '390x844'] },
    ],
  },
  // Plan 39.1-39: brand-red-text (UI-SPEC §4.3).
  { id: 'opponents', loadedMarker: '[data-slot="opponents-body"]', checks: ['brand-red-text'] },
  {
    // Plan 39.2-07 (UI-SPEC §13 G1): the tier-aware Tournaments page on the
    // harness's 19-row registry (`guardLayoutHarness.mjs`'s `tournaments`
    // scale), inside the MainLayout-geometry shell. brand-red-text (§4.3): the
    // chips, the Clear link and the event links are neutral. On a phone the
    // rows stack and the table-clip sweep reads the stacked list.
    id: 'tournaments',
    loadedMarker: '[data-slot="tournaments-body"]',
    scale: 'tournaments',
    checks: ['brand-red-text'],
    narrowChecks: ['table-clip'],
    clipTargets: ['[data-slot="tournaments-table"]'],
  },
  {
    // Plan 39.2-07: the SAME page on a 100-row registry (`tournaments100`) —
    // one full DOM pass. The table counts at most 500 px toward the page
    // scroll budget, like every table-layout list (UI-SPEC §6.3 terminus
    // allowance); the phone stack mounts 20 rows and counts in full.
    id: 'tournaments-100',
    loadedMarker: '[data-slot="tournaments-body"]',
    scale: 'tournaments100',
    checks: ['brand-red-text'],
    narrowChecks: ['table-clip'],
    clipTargets: ['[data-slot="tournaments-table"]'],
  },
  {
    id: 'opponent-hub',
    loadedMarker: '[data-slot="opponent-hub-body"]',
    // Plan 39.1-33: form-strip-fit — no extra viewport, no scroll budget.
    // Plan 39.1-37: axis-ticks on the H2H event trend (raw-axis-key,
    // value-label-overlap and the existing tick families) and plot-aspect
    // (UI-SPEC §6.1, the 8 + 4 trend row).
    // Plan 39.1-38: the hub's filter bar is one unboxed filter row — no
    // height limit and no owners (its h1 lives in the unchanged header row
    // above; the hub has no HorizonSwitch, audit 7.5's second half).
    // Plan 39.1-39: mark-count (UI-SPEC §11, the H2H event trend at most 60
    // points) and matrix-hug (audit 7.4, the cross-tab at its card edge).
    checks: [
      'form-strip-fit',
      // Plan 39.1-42: labelled events, older events drop first (sketch 003).
      'form-strip-labels',
      'axis-ticks',
      'plot-aspect',
      'filter-row',
      'brand-red-text',
      'mark-count',
      'matrix-hug',
      // Plan 39.1-51 (OOS-8).
      'last-row-visible',
    ],
    filterRow: {},
    // Plan 39.1-38 Task 3 (UI-SPEC §6.6): What they play never hides a column
    // behind a horizontal scroll on a phone.
    narrowChecks: ['table-clip'],
    clipTargets: ['[data-slot="what-they-play"]'],
  },
  {
    id: 'stage-detail',
    loadedMarker: '[data-slot="stage-detail-body"]',
    // Plan 39.1-37: axis-ticks and plot-aspect on the Over Time event trend.
    // Plan 39.1-39: mark-count (UI-SPEC §11, the Over Time trend at most 60 points).
    // Plan 39.1-51 (OOS-8): last-row-visible on the results list.
    checks: ['axis-ticks', 'plot-aspect', 'brand-red-text', 'mark-count', 'last-row-visible'],
    // Plan 39.1-38 Task 3 (UI-SPEC §6.6; deferred from 39.1-37): the By
    // Character list never hides its Win Rate column behind a horizontal
    // scroll on a phone.
    narrowChecks: ['table-clip'],
    clipTargets: ['[data-slot="stage-by-character"]'],
  },
  {
    // Plan 39.1-43 (OOS-6, 39.1-39 whole-page review): the Fighter hero on
    // the harness's `recent` scale, in the MainLayout-geometry shell — where
    // 39.1-39's capture showed the "NN% all time" reference label over the
    // last period dots. axis-ticks carries reference-label-dot-collision.
    id: 'fighter-analysis-recent',
    loadedMarker: '[data-slot="fighter-hero-body"]',
    scale: 'recent',
    // Plan 39.1-43b: the recent fixture's hero trend fits [0, 100] — the
    // same kit axis measured on a second domain (0..100 by 20).
    checks: ['axis-ticks', 'period-trend-axis'],
    periodTrendAxisExpect: periodTrendAxisExpectFor([0, 100]),
  },
  {
    // Plan 39.1-39 (deferred from 39.1-37): the SAME stage page on the
    // harness's `recent` scale (~150 session anchors on Battlefield — over
    // UI-SPEC §11's 60 line points unless the engine bins them), inside the
    // MainLayout-geometry shell at production widths.
    id: 'stage-detail-recent',
    loadedMarker: '[data-slot="stage-detail-body"]',
    scale: 'recent',
    // Plan 39.1-51 (OOS-8): last-row-visible on the results list.
    checks: ['mark-count', 'axis-ticks', 'last-row-visible'],
  },
  // Plan 39.1-51 (OOS-8): the three hosts that mount the results list only
  // under a drill axis, drilled with `?from=1` (every game) in the
  // MainLayout-geometry shell — the list is measurable and capturable.
  {
    id: 'fighter-analysis-games',
    loadedMarker: '[data-slot="filtered-match-list"] [data-total-rows]',
    checks: ['last-row-visible'],
  },
  {
    id: 'match-data-games',
    loadedMarker: '[data-slot="filtered-match-list"] [data-total-rows]',
    checks: ['last-row-visible'],
  },
  {
    id: 'trends-games',
    loadedMarker: '[data-slot="filtered-match-list"] [data-total-rows]',
    checks: ['last-row-visible'],
  },
  {
    // Plan 39.1-49: the Scout page, driven through its search form (a real
    // POST /api/scout answered by the fixture plugin from the harness
    // dataset) and its Full analysis section expanded — the narrowest host
    // of the three Scout multi-host tables. Phone width only: its desktop
    // lg:grid-cols-2 pairs are out of this plan's scope.
    id: 'scout',
    loadedMarker: '[data-slot="scout-full-analysis"][data-state="open"]',
    viewports: ['390x844'],
    prepare: [
      { type: 'type', selector: 'form input', text: 'guard-scout' },
      { type: 'click', selector: 'form button[type="submit"]' },
      { type: 'wait', selector: '[data-slot="scout-full-analysis"]' },
      { type: 'click', selector: '[data-slot="scout-full-analysis"] > button' },
      { type: 'wait', selector: '[data-slot="scout-full-analysis"][data-state="open"]' },
    ],
    // Plan 39.1-49 (orchestrator 2026-09-26, the Scout findings this plan
    // owns): mark-count (UI-SPEC §11 — the Recent Form trend at most 60
    // points) and brand-red-text (§4.3 — the event links), plus a text-fit
    // target on Recent Events at 1440 (its desktop half card clipped three
    // columns) and 390. The 1440 target gets its own shell=app load.
    checks: ['mark-count', 'brand-red-text'],
    fitTargets: [
      { selector: '[data-slot="scout-recent-events"]', viewports: ['390x844', '1440x900'] },
    ],
    clipTargets: [
      '[data-slot="opponent-table"]',
      '[data-slot="what-they-play"]',
      // Plan 39.1-49 Task 3: the converted recent-events table.
      '[data-slot="scout-recent-events"]',
    ],
  },
  {
    // Plan 39.1-49 (OOS-9): the GSP page on the harness's seeded `gsp` scale
    // (the one definition capture:design also reads), phone width only — its
    // desktop layout is Phase 41's contract (UI-SPEC §12). No `checks`: the
    // default families plus the text-fit target on the hero figures.
    id: 'gsp',
    loadedMarker: '[data-slot="gsp-body"]',
    scale: 'gsp',
    viewports: ['390x844'],
    fitTargets: [{ selector: '[data-slot="gsp-hero"]', viewports: ['390x844'] }],
  },
];

const HARD_TIMEOUT_MS = Number(process.env.GUARD_LAYOUT_HARD_TIMEOUT_MS) || 5 * 60 * 1000;
const ROUTE_LOAD_TIMEOUT_MS = 15_000;
/**
 * Plan 39.1-34: how long a career-timeline route waits for the timeline's
 * plot area after the page-loaded marker. On timeout it proceeds anyway —
 * `evaluateCareerTimeline` then reports what it finds (on production's
 * chart.js Trends: `career-timeline-unmeasured`), never a silent pass.
 */
const CAREER_TIMELINE_WAIT_MS = 5_000;

/**
 * `onTimeout` (plan 39.1-30 first_fix) is fired the instant the hard timeout
 * elapses, NOT awaited by this function — it is a fire-and-forget prompt-exit
 * hook (`main()`'s `forceExitOnTimeout`, below). `Promise.race` has no way to
 * cancel the losing `promise`: the measurement loop keeps running in the
 * background after this function's caller sees the rejection. Without
 * `onTimeout`, the ONLY cleanup left is the caller's own `finally` block
 * asking `browser.close()` to gracefully wait on the exact CDP connection an
 * orphaned `page.evaluate()` is still using — that wait was measured taking
 * minutes, defeating the whole point of a hard timeout.
 */
function withHardTimeout(promise, ms, label, onTimeout) {
  let timer;
  const timeout = new Promise((_resolve, reject) => {
    timer = setTimeout(() => {
      if (onTimeout) void onTimeout();
      reject(new Error(`${label} exceeded its ${ms}ms hard timeout`));
    }, ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/**
 * Runs entirely inside the browser context — no closures over outer scope.
 * `checks` (plan 39.1-30) is the requesting route's opted-in family list
 * (`[]` for every route except `matchups`); the four new measurement
 * categories below are only collected — at real DOM/CSS-computation cost —
 * for a route that actually asked for them.
 */
function collectPageMeasurements(checks, ceilingMarkers = [], familyConfig = {}) {
  const wantContentOverflow = checks.includes('content-overflow');
  const wantHeaderSqueeze = checks.includes('header-squeeze');
  const wantAxisTicks = checks.includes('axis-ticks');
  const wantGridBalance = checks.includes('grid-balance');
  const wantPickerAlignment = checks.includes('picker-alignment');
  const wantRowCohesion = checks.includes('row-cohesion');
  const wantRowTagLegibility = checks.includes('row-tag-legibility');
  const wantNestedScroll = checks.includes('nested-scroll');
  const wantCardHeightCeiling = checks.includes('card-height-ceiling');
  const wantFormStripFit = checks.includes('form-strip-fit');
  const wantCareerTimeline = checks.includes('career-timeline');
  const wantPlotAspect = checks.includes('plot-aspect');
  // Plan 39.1-38: the page-frame families.
  const wantFilterRow = checks.includes('filter-row');
  const wantStatRowColumns = checks.includes('stat-row-columns');
  const wantPlacement = checks.includes('placement');
  const wantInsightOrder = checks.includes('insight-order');
  const wantTableClip = checks.includes('table-clip');
  // Plan 39.1-39: brand-red-text and record-fit.
  const wantBrandRedText = checks.includes('brand-red-text');
  const wantRecordFit = checks.includes('record-fit');
  const wantMarkCount = checks.includes('mark-count');
  const wantMatrixHug = checks.includes('matrix-hug');
  // Plan 39.1-40: the reads-rail card count (layout reads only).
  const wantRailCards = checks.includes('rail-cards');
  // Plan 39.1-50 (OOS-40-A): a steady insight line's dash vs its first glyph.
  const wantInsightLineDash = checks.includes('insight-line-dash');
  // Plan 39.1-51 (OOS-8): the results list's last row.
  const wantLastRowVisible = checks.includes('last-row-visible');
  // Plan 39.1-41: the period trend's marks (sketch 003 A).
  const wantPeriodTrendMarks = checks.includes('period-trend-marks');
  // Plan 39.1-43b: the period trend's axis against the sketch CSS.
  const wantPeriodTrendAxis = checks.includes('period-trend-axis');
  // Plan 39.1-42: the strip's labelled events (sketch 003 `formStrip`).
  const wantFormStripLabels = checks.includes('form-strip-labels');

  function describeElement(el) {
    if (el.getAttribute('data-testid')) {
      return `[data-testid="${el.getAttribute('data-testid')}"]`;
    }
    if (el.id) {
      return `#${el.id}`;
    }
    const parts = [];
    let node = el;
    let depth = 0;
    while (node && node.nodeType === 1 && depth < 4) {
      let selector = node.tagName.toLowerCase();
      if (node.parentElement) {
        const siblingsOfType = Array.from(node.parentElement.children).filter(
          (child) => child.tagName === node.tagName,
        );
        if (siblingsOfType.length > 1) {
          selector += `:nth-of-type(${siblingsOfType.indexOf(node) + 1})`;
        }
      }
      parts.unshift(selector);
      node = node.parentElement;
      depth += 1;
    }
    return parts.join(' > ');
  }

  const cards = Array.from(document.querySelectorAll('[data-slot="card"]')).map((card) => {
    const rect = card.getBoundingClientRect();
    const style = window.getComputedStyle(card);
    const paddingBottom = parseFloat(style.paddingBottom) || 0;
    const lastChild = card.lastElementChild;
    const lastChildRect = lastChild ? lastChild.getBoundingClientRect() : rect;
    return {
      selectorPath: describeElement(card),
      height: rect.height,
      top: rect.top,
      lastChildBottom: lastChildRect.bottom,
      paddingBottom,
    };
  });

  const truncationElements = Array.from(document.querySelectorAll('[data-truncate-guard]')).map(
    (el) => ({
      selectorPath: describeElement(el),
      scrollWidth: el.scrollWidth,
      clientWidth: el.clientWidth,
      hasTitle: Boolean(el.getAttribute('title')),
    }),
  );

  // -------------------------------------------------------------------
  // Plan 39.1-30: the four new measurement categories, collected only for
  // a requesting route's opted-in families (see `wantX` flags above).
  // -------------------------------------------------------------------

  // Perf (plan 39.1-30 first_fix): a naive walk called `getComputedStyle`
  // TWICE per visited descendant (once for visibility, once for overflow-x).
  // `getComputedStyle` forces a style recalculation; on a chart-heavy page
  // (Recharts renders hundreds of SVG nodes) doubling that cost per node is
  // the difference between a route finishing in seconds and one blowing the
  // 300s hard timeout. One style object per element, reused by both checks.
  function isVisuallyHiddenFromStyle(style, rect, el) {
    if (style.position === 'fixed') return true;
    if (rect.width === 0 || rect.height === 0) return true;
    if (style.clip === 'rect(0px, 0px, 0px, 0px)' || style.clipPath === 'inset(50%)') return true;
    if ((el.offsetWidth <= 1 && el.offsetHeight <= 1) || style.visibility === 'hidden') return true;
    return false;
  }

  const overflowCards = [];
  if (wantContentOverflow) {
    for (const cardEl of document.querySelectorAll('[data-slot="card"]')) {
      const rect = cardEl.getBoundingClientRect();
      const cardStyle = window.getComputedStyle(cardEl);
      const borderLeft = parseFloat(cardStyle.borderLeftWidth) || 0;
      const borderRight = parseFloat(cardStyle.borderRightWidth) || 0;
      const innerLeft = rect.left + borderLeft;
      const innerRight = rect.right - borderRight;

      const offenders = [];
      const stack = Array.from(cardEl.children);
      while (stack.length > 0) {
        const el = stack.shift();
        const isSvg = el.tagName === 'svg';
        const style = window.getComputedStyle(el);
        const overflowContainer = ['auto', 'scroll', 'hidden', 'clip'].includes(style.overflowX);
        const elRect = el.getBoundingClientRect();
        if (!isVisuallyHiddenFromStyle(style, elRect, el)) {
          if (elRect.left < innerLeft - 1 || elRect.right > innerRight + 1) {
            offenders.push({
              selectorPath: describeElement(el),
              left: elRect.left,
              right: elRect.right,
            });
          }
        }
        // Never descend into SVG internals, and never past an
        // overflow/scroll/clip container's own boundary (UI-SPEC §6.5: a
        // horizontal scroll/clip container is the one enumerated
        // content-overflow exemption).
        if (!isSvg && !overflowContainer) {
          for (const child of el.children) stack.push(child);
        }
      }
      overflowCards.push({
        selectorPath: describeElement(cardEl),
        innerLeft,
        innerRight,
        offenders,
      });
    }
  }

  const headers = [];
  if (wantHeaderSqueeze) {
    // Plan 39.1-50: the route's headers and parts arrive through familyConfig
    // (`headerSqueezeConfigForRoute`); a route without its own declaration
    // gets the default card-header / card-title / card-description scan.
    const squeeze = familyConfig.headerSqueeze || {
      header: '[data-slot="card-header"]',
      parts: [
        { role: 'title', selector: '[data-slot="card-title"]' },
        { role: 'description', selector: '[data-slot="card-description"]' },
      ],
    };
    for (const headerEl of document.querySelectorAll(squeeze.header)) {
      const style = window.getComputedStyle(headerEl);
      const paddingLeft = parseFloat(style.paddingLeft) || 0;
      const paddingRight = parseFloat(style.paddingRight) || 0;
      const contentWidth = headerEl.clientWidth - paddingLeft - paddingRight;
      const parts = [];
      for (const { role, selector } of squeeze.parts) {
        for (const partEl of headerEl.querySelectorAll(selector)) {
          const partRect = partEl.getBoundingClientRect();
          const partStyle = window.getComputedStyle(partEl);
          let lineHeight = parseFloat(partStyle.lineHeight);
          if (!Number.isFinite(lineHeight)) {
            lineHeight = (parseFloat(partStyle.fontSize) || 14) * 1.2;
          }
          parts.push({
            role,
            width: partRect.width,
            height: partRect.height,
            lineHeight,
          });
        }
      }
      if (parts.length > 0) {
        headers.push({ selectorPath: describeElement(headerEl), contentWidth, parts });
      }
    }
  }

  const axisSurfaces = [];
  if (wantAxisTicks) {
    for (const surfaceEl of document.querySelectorAll('svg.recharts-surface')) {
      const rect = surfaceEl.getBoundingClientRect();

      function tickRects(containerSelector) {
        const out = [];
        const container = surfaceEl.querySelector(containerSelector);
        if (!container) return out;
        for (const g of container.querySelectorAll('.recharts-cartesian-axis-tick-label')) {
          const r = g.getBoundingClientRect();
          out.push({
            left: r.left,
            right: r.right,
            top: r.top,
            bottom: r.bottom,
            text: g.textContent ?? '',
          });
        }
        return out;
      }

      const xTicks = tickRects('.recharts-xAxis-tick-labels');
      const yTicks = tickRects('.recharts-yAxis-tick-labels');

      // Plan 39.1-37: the event trend's per-anchor W-L labels are value labels too.
      const valueLabels = Array.from(
        surfaceEl.querySelectorAll(
          '[data-slot="trend-period-value-label"], [data-slot="trend-event-value-label"]',
        ),
      ).map((el) => {
        const r = el.getBoundingClientRect();
        return {
          left: r.left,
          right: r.right,
          top: r.top,
          bottom: r.bottom,
          text: el.textContent ?? '',
        };
      });

      // Plan 39.1-37: the period trend's all-time reference label. Recharts 3
      // draws a ReferenceLine's label in a z-index layer, NOT inside
      // `.recharts-reference-line`, so it is found by Recharts' own
      // `recharts-label` text class (TrendLine keeps it next to its
      // `trend-period-reference-label` class), which also matches the label
      // on builds that predate that class.
      const referenceLabels = Array.from(
        surfaceEl.querySelectorAll('text.recharts-label, .trend-period-reference-label'),
      ).map((el) => {
        const r = el.getBoundingClientRect();
        return {
          left: r.left,
          right: r.right,
          top: r.top,
          bottom: r.bottom,
          text: el.textContent ?? '',
        };
      });

      // Plan 39.1-43 (OOS-6): every drawn dot, filled or hollow, with its key —
      // the reference-label-dot-collision check names the dot it hits.
      const dots = Array.from(surfaceEl.querySelectorAll('[data-slot="trend-period-dot"]')).map(
        (el) => {
          const r = el.getBoundingClientRect();
          return {
            selectorPath: describeElement(el),
            key: el.getAttribute('data-point-key') ?? undefined,
            subFloor: el.getAttribute('data-sub-floor') === 'true',
            left: r.left,
            right: r.right,
            top: r.top,
            bottom: r.bottom,
          };
        },
      );

      function axisLineRect(axisSelector) {
        const line = surfaceEl.querySelector(`${axisSelector} .recharts-cartesian-axis-line`);
        if (!line) return null;
        const r = line.getBoundingClientRect();
        return { left: r.left, right: r.right, top: r.top, bottom: r.bottom };
      }

      axisSurfaces.push({
        selectorPath: describeElement(surfaceEl),
        rect: { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom },
        xTicks,
        yTicks,
        valueLabels,
        dots,
        referenceLabels,
        xAxisLine: axisLineRect('.recharts-xAxis'),
        yAxisLine: axisLineRect('.recharts-yAxis'),
      });
    }
  }

  // Plan 39.1-37 (UI-SPEC §6.1): every chart plot surface inside a card —
  // read from rects the page already lays out, no style walk.
  const plotSurfaces = [];
  if (wantPlotAspect) {
    for (const surfaceEl of document.querySelectorAll('[data-slot="card"] svg.recharts-surface')) {
      const r = surfaceEl.getBoundingClientRect();
      plotSurfaces.push({
        selectorPath: describeElement(surfaceEl),
        width: r.width,
        height: r.height,
      });
    }
  }

  const grids = [];
  if (wantGridBalance) {
    // Perf (plan 39.1-30 first_fix): the naive form called `getComputedStyle`
    // — a forced style recalculation — for EVERY element in the document,
    // including every SVG internal a chart renders (paths, tick <text>
    // nodes, grid lines) and every table row. This codebase's CSS grid
    // containers are ALWAYS Tailwind-classed (`grid`, `grid-cols-12`,
    // `lg:grid`, …), so a cheap className substring check — no style/layout
    // read — first narrows thousands of candidates down to the handful that
    // could possibly be a grid container before paying for the real style
    // read. SVG elements' `className` is an `SVGAnimatedString`, not a
    // plain string (no `.includes`); the `typeof` guard skips them, which is
    // correct — no SVG internal is ever a CSS grid container here.
    const gridClassCandidates = [];
    for (const el of document.querySelectorAll('*')) {
      const cls = el.className;
      if (typeof cls === 'string' && cls.includes('grid')) {
        gridClassCandidates.push(el);
      }
    }
    for (const gridEl of gridClassCandidates) {
      const display = window.getComputedStyle(gridEl).display;
      if (display !== 'grid' && display !== 'inline-grid') continue;
      // Plan 39.1-40: a route may widen what counts as a card (Trends: its
      // reads rail's InsightCards carry data-slot="insight-card"); every
      // other route keeps the plain card selector.
      const gridCardSelector =
        (familyConfig.gridBalance && familyConfig.gridBalance.cardSelector) || '[data-slot="card"]';
      const cardBearingChildren = Array.from(gridEl.children).filter(
        (child) => child.matches(gridCardSelector) || child.querySelector(gridCardSelector),
      );
      if (cardBearingChildren.length < 2) continue;
      const rowGapPx = parseFloat(window.getComputedStyle(gridEl).rowGap) || 0;
      const items = cardBearingChildren.map((child) => {
        const r = child.getBoundingClientRect();
        return {
          selectorPath: describeElement(child),
          left: r.left,
          right: r.right,
          top: r.top,
          bottom: r.bottom,
        };
      });
      grids.push({ selectorPath: describeElement(gridEl), rowGapPx, items });
    }
  }

  // -------------------------------------------------------------------
  // Plan 39.1-32: the four mobile gap-closure measurement categories,
  // collected only for a requesting route's opted-in families.
  // -------------------------------------------------------------------

  const pickers = [];
  if (wantPickerAlignment) {
    for (const pickerEl of document.querySelectorAll('[data-slot="matchup-pairing-picker"]')) {
      const controls = Array.from(pickerEl.querySelectorAll('[data-slot="select-trigger"]')).map(
        (el) => {
          const r = el.getBoundingClientRect();
          return { left: r.left, right: r.right, top: r.top, bottom: r.bottom };
        },
      );
      const labels = Array.from(
        pickerEl.querySelectorAll('[data-slot="matchup-pairing-label"]'),
      ).map((el) => {
        const r = el.getBoundingClientRect();
        return { left: r.left, right: r.right, top: r.top, bottom: r.bottom };
      });
      const vsEls = pickerEl.querySelectorAll('[data-slot="matchup-pairing-vs"]');
      // Structure drift (not exactly 2 controls / 2 labels / 1 vs) is left
      // OUT of `pickers` on purpose — `evaluateFamilyPresence` then reports
      // `picker-alignment-unmeasured` rather than the evaluator indexing
      // into a missing array slot.
      if (controls.length === 2 && labels.length === 2 && vsEls.length === 1) {
        const vsRect = vsEls[0].getBoundingClientRect();
        pickers.push({
          selectorPath: describeElement(pickerEl),
          controls,
          labels,
          vs: { left: vsRect.left, right: vsRect.right, top: vsRect.top, bottom: vsRect.bottom },
        });
      }
    }
  }

  const rowCohesionRows = [];
  if (wantRowCohesion) {
    for (const rowEl of document.querySelectorAll('[data-fixed-columns]')) {
      const items = Array.from(rowEl.children).map((child) => {
        const r = child.getBoundingClientRect();
        return {
          selectorPath: describeElement(child),
          top: r.top,
          scrollWidth: child.scrollWidth,
          clientWidth: child.clientWidth,
        };
      });
      rowCohesionRows.push({ selectorPath: describeElement(rowEl), items });
    }
  }

  const rowTags = [];
  if (wantRowTagLegibility) {
    for (const tagEl of document.querySelectorAll('[data-slot="pairing-opponent-tag"]')) {
      const li = tagEl.closest('li');
      let rowContentWidth = tagEl.clientWidth;
      if (li) {
        const liStyle = window.getComputedStyle(li);
        const paddingLeft = parseFloat(liStyle.paddingLeft) || 0;
        const paddingRight = parseFloat(liStyle.paddingRight) || 0;
        rowContentWidth = li.clientWidth - paddingLeft - paddingRight;
      }
      rowTags.push({
        selectorPath: describeElement(tagEl),
        text: tagEl.textContent ?? '',
        scrollWidth: tagEl.scrollWidth,
        clientWidth: tagEl.clientWidth,
        rowContentWidth,
      });
    }
  }

  const nestedScrollers = [];
  if (wantNestedScroll) {
    // Layout reads (scrollHeight/clientHeight) first — cheap; `getComputedStyle`
    // (a forced style recalculation) only for the few candidates that already
    // scroll taller than their box, mirroring the grid-balance perf lesson
    // above (plan 39.1-30 first_fix).
    for (const el of document.body.getElementsByTagName('*')) {
      if (el.scrollHeight > el.clientHeight + 1) {
        const overflowY = window.getComputedStyle(el).overflowY;
        if (overflowY === 'auto' || overflowY === 'scroll') {
          nestedScrollers.push({
            selectorPath: describeElement(el),
            overflowY,
            scrollHeight: el.scrollHeight,
            clientHeight: el.clientHeight,
          });
        }
      }
    }
  }
  // Non-vacuity presence list (plan 39.1-32): the page's terminus list roots
  // — a missing results list is nested-scroll-unmeasured, never a silent
  // zero-violation pass.
  const nestedScrollPresenceList = wantNestedScroll
    ? Array.from(document.querySelectorAll('[data-total-rows]'))
    : [];

  // -------------------------------------------------------------------
  // Plan 39.1-33: card-height-ceiling + form-strip-fit, collected only for
  // a requesting route's opted-in families.
  // -------------------------------------------------------------------

  const cardHeightCards = [];
  if (wantCardHeightCeiling) {
    for (const ceiling of ceilingMarkers) {
      const markerEl = document.querySelector(ceiling.marker);
      const cardEl = markerEl ? markerEl.closest('[data-slot="card"]') : null;
      if (cardEl) {
        const rect = cardEl.getBoundingClientRect();
        cardHeightCards.push({
          marker: ceiling.marker,
          selectorPath: describeElement(cardEl),
          height: rect.height,
          maxViewportHeights: ceiling.maxViewportHeights,
        });
      } else {
        cardHeightCards.push({
          marker: ceiling.marker,
          selectorPath: null,
          height: null,
          maxViewportHeights: ceiling.maxViewportHeights,
        });
      }
    }
  }

  const formStrips = [];
  if (wantFormStripFit) {
    for (const rootEl of document.querySelectorAll('[data-slot="form-strip-root"]')) {
      const rowEl = rootEl.querySelector(':scope > [role="group"]');
      if (!rowEl) continue;
      const setTops = Array.from(rootEl.querySelectorAll('[data-slot="form-strip-set"]')).map(
        (setEl) => setEl.getBoundingClientRect().top,
      );
      formStrips.push({
        selectorPath: describeElement(rowEl),
        setTops,
        rowScrollWidth: rowEl.scrollWidth,
        rowClientWidth: rowEl.clientWidth,
      });
    }
  }

  // Plan 39.1-42: form-strip-labels — per strip root its data-event-count /
  // data-game-count, the drawn tick count and, per shown event, its
  // data-event-order and label (text + rect). A shipped caption-only root
  // (no data-event-count, no label nodes) is still collected as its event
  // list, so the family reports label-missing on it, never unmeasured.
  const formStripLabelStrips = [];
  if (wantFormStripLabels) {
    const numberAttr = (el, name) => {
      const raw = el.getAttribute(name);
      return raw === null || raw === '' ? null : Number(raw);
    };
    for (const rootEl of document.querySelectorAll('[data-slot="form-strip-root"]')) {
      const rootRect = rootEl.getBoundingClientRect();
      const events = Array.from(rootEl.querySelectorAll('[data-slot="form-strip-event"]')).map(
        (eventEl) => {
          const labelEl = eventEl.querySelector('[data-slot="form-strip-event-label"]');
          const r = labelEl ? labelEl.getBoundingClientRect() : null;
          const parts = labelEl
            ? Array.from(labelEl.children)
                .map((child) => (child.textContent ?? '').trim())
                .filter((text) => text.length > 0)
            : [];
          return {
            order: numberAttr(eventEl, 'data-event-order'),
            labelText: labelEl
              ? parts.length > 0
                ? parts.join(' ')
                : (labelEl.textContent ?? '').trim()
              : null,
            labelRect: r
              ? {
                  left: r.left,
                  right: r.right,
                  top: r.top,
                  bottom: r.bottom,
                  width: r.width,
                  height: r.height,
                }
              : null,
          };
        },
      );
      formStripLabelStrips.push({
        selectorPath: describeElement(rootEl),
        eventCount: numberAttr(rootEl, 'data-event-count'),
        gameCount: numberAttr(rootEl, 'data-game-count'),
        shownGames: rootEl.querySelectorAll('[data-slot="form-strip-tick"]').length,
        rootWidth: rootRect.width,
        events,
      });
    }
  }

  // Plan 39.1-34: the career-timeline family — layout reads only (rects and
  // data-* attributes, never getComputedStyle). One measurement per timeline
  // root; the rating line's anchors are the per-point `career-timeline-point`
  // markers the kit emits at the line's own x scale.
  const timelines = [];
  let canvasCount = 0;
  if (wantCareerTimeline) {
    canvasCount = document.querySelectorAll('canvas').length;
    const cellsOf = (rootEl, slot) =>
      Array.from(rootEl.querySelectorAll(`[data-slot="${slot}"]`)).map((cellEl) => {
        const r = cellEl.getBoundingClientRect();
        return {
          startMs: Number(cellEl.getAttribute('data-start-ms')),
          endMs: Number(cellEl.getAttribute('data-end-ms')),
          left: r.left,
          right: r.right,
        };
      });
    for (const rootEl of document.querySelectorAll('[data-slot="career-timeline"]')) {
      const plotEl = rootEl.querySelector('[data-slot="career-timeline-plot-area"]');
      const plotRect = plotEl ? plotEl.getBoundingClientRect() : null;
      const anchors = Array.from(
        rootEl.querySelectorAll('[data-slot="career-timeline-point"]'),
      ).map((pointEl) => {
        const r = pointEl.getBoundingClientRect();
        return { t: Number(pointEl.getAttribute('data-t')), cx: r.left + r.width / 2 };
      });
      let lineVertexCount = 0;
      for (const lineEl of rootEl.querySelectorAll('.career-timeline-line')) {
        const paths = lineEl.tagName.toLowerCase() === 'path' ? [lineEl] : [];
        paths.push(...lineEl.querySelectorAll('path'));
        for (const pathEl of paths) {
          lineVertexCount += ((pathEl.getAttribute('d') ?? '').match(/[ML]/g) ?? []).length;
        }
      }
      const stripsEl = rootEl.querySelector('[data-slot="career-timeline-strips"]');
      timelines.push({
        selectorPath: describeElement(rootEl),
        state: rootEl.getAttribute('data-state'),
        plotLeft: plotRect ? plotRect.left : 0,
        plotRight: plotRect ? plotRect.right : 0,
        plotWidth: plotRect ? plotRect.width : 0,
        stripGrain: stripsEl ? stripsEl.getAttribute('data-grain') : null,
        anchors,
        lineVertexCount,
        rateCells: cellsOf(rootEl, 'career-timeline-rate-cell'),
        gamesCells: cellsOf(rootEl, 'career-timeline-games-cell'),
        formStripTicks: rootEl.querySelectorAll('[data-slot="form-strip-tick"]').length,
      });
    }
  }

  // -------------------------------------------------------------------
  // Plan 39.1-38: the page-frame families — rects only, plus ONE
  // getComputedStyle per filter-row node (its border widths).
  // -------------------------------------------------------------------
  const plainRect = (el) => {
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { left: r.left, right: r.right, top: r.top, bottom: r.bottom };
  };

  const filterRows = [];
  const filterRowOwnedInCards = [];
  const filterRowOwners = (familyConfig.filterRow && familyConfig.filterRow.owns) || [];
  if (wantFilterRow) {
    for (const rowEl of document.querySelectorAll('[data-slot="page-filter-row"]')) {
      const style = window.getComputedStyle(rowEl);
      filterRows.push({
        selectorPath: describeElement(rowEl),
        borderWidths: [
          parseFloat(style.borderTopWidth) || 0,
          parseFloat(style.borderRightWidth) || 0,
          parseFloat(style.borderBottomWidth) || 0,
          parseFloat(style.borderLeftWidth) || 0,
        ],
        inCard: Boolean(rowEl.closest('[data-slot="card"]')),
        height: rowEl.getBoundingClientRect().height,
        ownedInside: filterRowOwners.filter((selector) => rowEl.querySelector(selector)),
      });
    }
    for (const selector of filterRowOwners) {
      for (const ownedEl of document.querySelectorAll(selector)) {
        if (ownedEl.closest('[data-slot="card"]')) {
          filterRowOwnedInCards.push({ selector, selectorPath: describeElement(ownedEl) });
        }
      }
    }
  }

  const statRows = [];
  if (wantStatRowColumns) {
    for (const rowEl of document.querySelectorAll('[data-slot="stat-row"]')) {
      statRows.push({
        selectorPath: describeElement(rowEl),
        fixedColumns: rowEl.hasAttribute('data-fixed-columns'),
        leadSpan: rowEl.hasAttribute('data-lead-span'),
        rowWidth: rowEl.getBoundingClientRect().width,
        children: Array.from(rowEl.children).map((child) => {
          const r = child.getBoundingClientRect();
          return { left: r.left, width: r.width };
        }),
      });
    }
  }

  const placementItems = [];
  if (wantPlacement) {
    const pageEl =
      document.querySelector('[data-slot="page-shell"]') ||
      document.querySelector('[data-slot="page-grid"]');
    for (const decl of familyConfig.placement || []) {
      if (decl.kind === 'within-column') {
        const ofEl = document.querySelector(decl.anchor.of);
        const anchorEl = ofEl ? ofEl.closest(decl.anchor.closest) : null;
        placementItems.push({
          kind: decl.kind,
          subjectSelector: decl.subject,
          subject: plainRect(document.querySelector(decl.subject)),
          anchor: plainRect(anchorEl),
          gapPx: decl.gapPx,
        });
      } else if (decl.kind === 'side-by-side') {
        const parentEl = document.querySelector(decl.parent);
        placementItems.push({
          kind: decl.kind,
          parentSelector: decl.parent,
          children: parentEl ? Array.from(parentEl.children).map(plainRect) : [],
          pageWidth: pageEl ? pageEl.getBoundingClientRect().width : null,
          minPageWidthPx: decl.minPageWidthPx,
        });
      } else if (decl.kind === 'above') {
        placementItems.push({
          kind: decl.kind,
          firstSelector: decl.first,
          thenSelector: decl.then,
          first: plainRect(document.querySelector(decl.first)),
          then: plainRect(document.querySelector(decl.then)),
        });
      }
    }
  }

  const orderPairs = [];
  if (wantInsightOrder) {
    const topOf = (selector) => {
      const el = document.querySelector(selector);
      return el ? el.getBoundingClientRect().top : null;
    };
    for (const pair of familyConfig.orderPairs || []) {
      orderPairs.push({
        first: pair.first,
        then: pair.then,
        firstTop: topOf(pair.first),
        thenTop: topOf(pair.then),
      });
    }
  }

  // Plan 39.1-38 Task 3: table-clip — each declared target's nearest
  // ancestor-or-self horizontal scroll/clip container (one getComputedStyle
  // per ancestor step, targets only), and its scroll / client widths.
  const clipTargets = [];
  if (wantTableClip) {
    for (const selector of familyConfig.clipTargets || []) {
      const targetEl = document.querySelector(selector);
      if (!targetEl) {
        clipTargets.push({ selector, found: false });
        continue;
      }
      let clipEl = null;
      for (let node = targetEl; node && node !== document.body; node = node.parentElement) {
        const overflowX = window.getComputedStyle(node).overflowX;
        if (overflowX === 'auto' || overflowX === 'scroll' || overflowX === 'hidden') {
          clipEl = node;
          break;
        }
      }
      clipTargets.push({
        selector,
        found: true,
        selectorPath: clipEl ? describeElement(clipEl) : null,
        scrollWidth: clipEl ? clipEl.scrollWidth : null,
        clientWidth: clipEl ? clipEl.clientWidth : null,
      });
    }
  }

  // Plan 39.1-39: brand-red-text — a hidden probe span styled
  // `color: var(--primary)` resolves the brand red to the browser's own
  // computed form; every visible element with at least one non-whitespace
  // direct text node (SVG text included; the HorizonSwitch — whose inset is
  // reserved red chrome — skipped) is compared against it EXACTLY. For SVG
  // text the painted colour is `fill`, so it is compared too. Only offenders
  // travel back, with the probe value and the scanned count.
  const brandRed = { probe: null, scanned: 0, elements: [] };
  if (wantBrandRedText) {
    const probeEl = document.createElement('span');
    probeEl.setAttribute('aria-hidden', 'true');
    probeEl.style.cssText =
      'position:absolute;visibility:hidden;pointer-events:none;color:var(--primary)';
    probeEl.textContent = 'x';
    document.body.appendChild(probeEl);
    const probe = window.getComputedStyle(probeEl).color;
    probeEl.remove();
    brandRed.probe = probe;
    for (const el of document.body.querySelectorAll('*')) {
      if (el.closest('[data-slot="horizon-switch"]')) continue;
      let hasText = false;
      for (const child of el.childNodes) {
        if (child.nodeType === 3 && child.textContent.trim().length > 0) {
          hasText = true;
          break;
        }
      }
      if (!hasText) continue;
      const box = el.getBoundingClientRect();
      if (box.width === 0 || box.height === 0) continue;
      const style = window.getComputedStyle(el);
      if (style.visibility === 'hidden' || style.display === 'none') continue;
      brandRed.scanned += 1;
      const isSvgText = el instanceof SVGElement;
      const painted = isSvgText ? style.fill : style.color;
      if (style.color === probe || painted === probe) {
        brandRed.elements.push({
          tag: el.tagName.toLowerCase(),
          text: (el.textContent ?? '').trim().replace(/\s+/g, ' ').slice(0, 40),
          selectorPath: describeElement(el),
          color: painted === probe ? painted : style.color,
        });
      }
    }
  }

  // Plan 39.1-39: record-fit — every [data-slot="record"] inside each card,
  // with its rect and the rect of its figure cell (the nearest ancestor whose
  // PARENT is a CSS grid; one getComputedStyle per ancestor step, records
  // only). A record with no grid ancestor inside its card is measured
  // against the card itself.
  const recordCards = [];
  if (wantRecordFit) {
    for (const card of document.querySelectorAll('[data-slot="card"]')) {
      const records = [];
      for (const recordEl of card.querySelectorAll('[data-slot="record"]')) {
        const box = recordEl.getBoundingClientRect();
        if (box.width === 0 || box.height === 0) continue;
        let cell = null;
        for (let node = recordEl; node && node !== card; node = node.parentElement) {
          const parent = node.parentElement;
          if (!parent) break;
          const display = window.getComputedStyle(parent).display;
          if (display === 'grid' || display === 'inline-grid') {
            cell = node;
            break;
          }
          if (parent === card) break;
        }
        const cellBox = (cell ?? card).getBoundingClientRect();
        records.push({
          text: (recordEl.textContent ?? '').trim().replace(/\s+/g, ' '),
          rect: { left: box.left, right: box.right, top: box.top, bottom: box.bottom },
          cellRect: {
            left: cellBox.left,
            right: cellBox.right,
            top: cellBox.top,
            bottom: cellBox.bottom,
          },
        });
      }
      if (records.length > 0) recordCards.push({ selectorPath: describeElement(card), records });
    }
  }

  // Plan 39.1-39: mark-count — per Recharts line inside a card, the number
  // of rendered point marks in its `.recharts-line-dots` group (UI-SPEC §11).
  // Recharts 3 draws the dots group in its own z-index layer, a SIBLING of
  // `.recharts-line` (not a descendant — the first RED run's all-unmeasured
  // result caught that), so the groups are read from the card directly.
  const markLines = [];
  if (wantMarkCount) {
    for (const card of document.querySelectorAll('[data-slot="card"]')) {
      for (const dots of card.querySelectorAll('.recharts-line-dots')) {
        markLines.push({ selectorPath: describeElement(dots), count: dots.children.length });
      }
    }
  }

  // Plan 39.1-39: matrix-hug — each MatrixHeat grid table's left edge vs its
  // card content box's left edge (one getComputedStyle per table's content box).
  const matrixTables = [];
  if (wantMatrixHug) {
    for (const table of document.querySelectorAll('[data-slot="matrix-heat-grid"] table')) {
      const box =
        table.closest('[data-slot="card-content"]') ?? table.closest('[data-slot="card"]');
      if (!box) continue;
      const boxRect = box.getBoundingClientRect();
      const boxStyle = window.getComputedStyle(box);
      const contentLeft =
        boxRect.left +
        (parseFloat(boxStyle.borderLeftWidth) || 0) +
        (parseFloat(boxStyle.paddingLeft) || 0);
      matrixTables.push({
        selectorPath: describeElement(table),
        left: table.getBoundingClientRect().left,
        contentLeft,
      });
    }
  }

  // Plan 39.1-40 (D-14, UI-SPEC §7.8): per reads-rail root, the real cards
  // (regular / unlocks-next), the synthetic fallback cards and the rendered
  // template ids in DOM order. Attribute and count reads only.
  const railCards = [];
  if (wantRailCards && familyConfig.railCards && familyConfig.railCards.selector) {
    for (const root of document.querySelectorAll(familyConfig.railCards.selector)) {
      const cardEls = Array.from(root.querySelectorAll('[data-slot="insight-rail-card"]'));
      const cardCount = cardEls.filter((el) => {
        const kind = el.getAttribute('data-card-kind');
        return kind === 'regular' || kind === 'unlocks-next';
      }).length;
      const fallback =
        root.querySelectorAll('[data-rail-fallback="true"]').length +
        root.querySelectorAll('[data-slot="insight-rail-card"][data-card-kind="fallback"]').length;
      const templates = Array.from(
        root.querySelectorAll('[data-slot="trends-read-card"][data-template-id]'),
      ).map((el) => el.getAttribute('data-template-id'));
      railCards.push({
        selectorPath: describeElement(root),
        cards: cardCount,
        fallback,
        templates,
      });
    }
  }

  // Plan 39.1-50 (OOS-40-A, UI-SPEC §7.8): each visible steady insight line's
  // dash box and the box of its text's first character (a DOM Range, so a
  // wrapped text's FIRST line is what the dash is compared with).
  const insightLineDashes = [];
  if (wantInsightLineDash) {
    for (const lineEl of document.querySelectorAll(
      '[data-slot="insight-line"][data-tone="steady"]',
    )) {
      const dashEl = lineEl.querySelector('svg');
      const textEl = lineEl.querySelector('[data-slot="insight-line-text"]');
      if (!dashEl || !textEl) continue;
      const lineRect = lineEl.getBoundingClientRect();
      if (lineRect.width === 0 || lineRect.height === 0) continue;
      const walker = document.createTreeWalker(textEl, NodeFilter.SHOW_TEXT);
      let node = walker.nextNode();
      while (node && !/\S/.test(node.textContent ?? '')) node = walker.nextNode();
      if (!node) continue;
      const offset = (node.textContent ?? '').search(/\S/);
      const range = document.createRange();
      range.setStart(node, offset);
      range.setEnd(node, offset + 1);
      const glyph = range.getBoundingClientRect();
      const dash = dashEl.getBoundingClientRect();
      insightLineDashes.push({
        selectorPath: describeElement(lineEl),
        text: (textEl.textContent ?? '').slice(0, 60),
        dash: { left: dash.left, right: dash.right, top: dash.top, bottom: dash.bottom },
        firstGlyph: { left: glyph.left, right: glyph.right, top: glyph.top, bottom: glyph.bottom },
      });
    }
  }

  // -------------------------------------------------------------------
  // Plan 39.1-51 (OOS-8, UI-SPEC §6.3 terminus allowance): every route, every
  // viewport — the laid-out height of each table-layout results list's flow
  // (the root's direct child holding the table), which the scroll budget
  // counts only up to 500 px. With `last-row-visible` requested, one record
  // per list root: layout reads first, then getComputedStyle on the last
  // row's ancestor walk only.
  // -------------------------------------------------------------------
  const terminusFlowsPx = [];
  const terminusLists = [];
  for (const root of document.querySelectorAll('[data-slot="filtered-match-list"]')) {
    const tableSlot = root.querySelector('[data-slot="filtered-match-table"]');
    const stackSlot = root.querySelector('[data-slot="filtered-match-stack"]');
    if (tableSlot) {
      let flow = tableSlot;
      while (flow.parentElement && flow.parentElement !== root) flow = flow.parentElement;
      if (flow.parentElement === root) terminusFlowsPx.push(flow.getBoundingClientRect().height);
    }
    if (!wantLastRowVisible) continue;
    const layout = tableSlot ? 'table' : stackSlot ? 'stack' : 'empty';
    const listEl = tableSlot ? tableSlot.querySelector('table') : stackSlot;
    const rows = tableSlot
      ? Array.from(tableSlot.querySelectorAll('tbody > tr'))
      : stackSlot
        ? Array.from(stackSlot.children).filter((child) => child.tagName === 'LI')
        : [];
    const totalEl = root.querySelector('[data-total-rows]');
    const lastEl = rows[rows.length - 1] ?? null;
    const lastRect = lastEl ? lastEl.getBoundingClientRect() : null;
    const record = {
      selectorPath: describeElement(root),
      layout,
      mounted: rows.length,
      total: totalEl ? Number(totalEl.getAttribute('data-total-rows')) : 0,
      contentPx: listEl ? listEl.getBoundingClientRect().height : 0,
      lastRow:
        lastRect && lastRect.height > 0 ? { top: lastRect.top, bottom: lastRect.bottom } : null,
      clips: [],
    };
    for (let el = lastEl ? lastEl.parentElement : null; el && el !== document.body;) {
      const style = window.getComputedStyle(el);
      if (style.overflowX !== 'visible' || style.overflowY !== 'visible') {
        const rect = el.getBoundingClientRect();
        const visTop = rect.top + el.clientTop;
        record.clips.push({
          selectorPath: describeElement(el),
          overflowY: style.overflowY,
          scrollHeight: el.scrollHeight,
          clientHeight: el.clientHeight,
          visTop,
          visBottom: visTop + el.clientHeight,
        });
      }
      el = el.parentElement;
    }
    terminusLists.push(record);
  }

  // Plan 39.2-07 (UI-SPEC §6.3): the Tournaments table is the same kind of
  // table-layout list — its scroll container's height counts toward the page
  // budget only up to the terminus allowance. The stacked phone list has no
  // `table` and counts in full.
  for (const table of document.querySelectorAll('table[data-slot="tournaments-table"]')) {
    const container = table.closest('[data-slot="table-container"]') ?? table;
    terminusFlowsPx.push(container.getBoundingClientRect().height);
  }

  // -------------------------------------------------------------------
  // Plan 39.1-41 (sketch 003 A): one record per period trend root. The root
  // (`[data-slot="trend-line-period"]`, layout-neutral) declares its state,
  // fitted y-domain and dot-sizing rule; before that root existed (the RED
  // run) the record falls back to the plot surface's parent and reads what
  // it can, so the family still reports the shipped trend instead of only
  // `-unmeasured`. Attribute and rect reads, plus one getComputedStyle per
  // line curve.
  // -------------------------------------------------------------------
  const periodTrends = [];
  if (wantPeriodTrendMarks || wantPeriodTrendAxis) {
    let roots = Array.from(document.querySelectorAll('[data-slot="trend-line-period"]'));
    if (roots.length === 0) {
      const fallback = new Set();
      for (const el of document.querySelectorAll(
        '[data-slot="trend-period-dot"], [data-slot="trend-line-period-locked"]',
      )) {
        const surfaceEl = el.closest('svg.recharts-surface');
        const host = surfaceEl
          ? surfaceEl.closest('.recharts-wrapper')?.parentElement
          : el.parentElement;
        if (host) fallback.add(host);
      }
      roots = [...fallback];
    }
    for (const root of roots) {
      const declaredState = root.getAttribute('data-state');
      const state =
        declaredState ??
        (root.querySelector('[data-slot="trend-line-period-locked"]')
          ? 'locked'
          : root.querySelector('svg.recharts-surface')
            ? 'drawn'
            : null);
      const domainAttr = root.getAttribute('data-y-domain');
      const yDomain = domainAttr ? domainAttr.split(',').map(Number) : null;
      const dots = Array.from(root.querySelectorAll('[data-slot="trend-period-dot"]')).map(
        (dot, i) => ({
          key: dot.getAttribute('data-point-key') ?? `index:${i}`,
          diameter: Math.round(2 * Number(dot.getAttribute('r') ?? '0')),
          subFloor: dot.getAttribute('data-sub-floor') === 'true',
        }),
      );
      const valueLabels = Array.from(
        root.querySelectorAll('[data-slot="trend-period-value-label"]'),
      ).map((label, i) => ({
        key: label.getAttribute('data-point-key') ?? `label:${i}`,
        text: (label.textContent ?? '').trim(),
      }));
      let strokedLineCount = 0;
      for (const curve of root.querySelectorAll('svg.recharts-surface path.recharts-line-curve')) {
        const style = window.getComputedStyle(curve);
        if (style.stroke && style.stroke !== 'none' && parseFloat(style.strokeWidth) > 0) {
          strokedLineCount += 1;
        }
      }
      const yTickTexts = Array.from(root.querySelectorAll('.recharts-yAxis-tick-labels text')).map(
        (tick) => (tick.textContent ?? '').trim(),
      );
      // Recharts 3 draws a ReferenceLine's label in a z-index layer, not
      // inside `.recharts-reference-line` — TrendLine tags it with its own
      // `trend-period-reference-label` class (the axis-ticks collector's rule).
      const referenceEl = root.querySelector('.trend-period-reference-label');
      // Plan 39.1-43 (OOS-6, UI-SPEC 7.13 as amended): when the kit declares
      // no free slot (`data-reference-label-position="none"`) it draws no
      // direct label and the head's reference legend item states the rate —
      // only then is the legend item the surface's reference text.
      const legendReferenceEl =
        root.getAttribute('data-reference-label-position') === 'none'
          ? root.querySelector('[data-slot="trend-legend-item"][data-kind="reference"]')
          : null;
      const referenceLabel = referenceEl
        ? (referenceEl.textContent ?? '').trim()
        : legendReferenceEl
          ? (legendReferenceEl.textContent ?? '').trim()
          : null;
      const referenceLabelSource = referenceEl ? 'direct' : legendReferenceEl ? 'legend' : null;
      // Plan 39.1-43 (PD-43-3): the value range = the span between the
      // fitted domain's lowest and highest HAIRLINES — the horizontal grid
      // lines drawn at a y-axis tick. Recharts 3's CartesianGrid also draws
      // the plot box's top and bottom edges, which are not domain hairlines,
      // so only a line whose y (SVG user units = px) matches a rendered y
      // tick counts. Should Recharts ever omit an edge hairline, the y ticks
      // themselves still bound the range (the plan's stated fallback).
      const tickYs = Array.from(
        root.querySelectorAll('svg.recharts-surface .recharts-yAxis-tick-labels text'),
      )
        .map((tick) => Number(tick.getAttribute('y')))
        .filter((y) => Number.isFinite(y));
      const hairlineYs = Array.from(
        root.querySelectorAll('svg.recharts-surface .recharts-cartesian-grid-horizontal line'),
      )
        .map((line) => Number(line.getAttribute('y1')))
        .filter((y) => Number.isFinite(y) && tickYs.some((tickY) => Math.abs(tickY - y) < 0.5));
      const rangeYs = hairlineYs.length >= 2 ? hairlineYs : tickYs;
      const valueRangePx = rangeYs.length >= 2 ? Math.max(...rangeYs) - Math.min(...rangeYs) : null;
      const valueRangeSource = hairlineYs.length >= 2 ? 'hairlines' : 'ticks';
      // Plan 39.1-43b: the ticks the range is read from, with their values —
      // the runner scales their px-per-point span to the declared domain
      // (`periodValueRangeFromTicks`), since a sketch-stepped axis need not
      // put a hairline on the domain's top ([20, 90] ticks 20..80).
      const rangeTicks = Array.from(
        root.querySelectorAll('svg.recharts-surface .recharts-yAxis-tick-labels text'),
      )
        .map((tick) => ({
          value: Number((tick.textContent ?? '').replace(/[^\d.-]/g, '')),
          y: Number(tick.getAttribute('y')),
        }))
        .filter(
          (tick) =>
            Number.isFinite(tick.value) &&
            Number.isFinite(tick.y) &&
            (hairlineYs.length < 2 || hairlineYs.some((y) => Math.abs(tick.y - y) < 0.5)),
        );
      // Plan 39.1-43b: the axis against sketch 003 A / 001-C's `trend()` CSS
      // (guardLayoutCore `evaluatePeriodTrendAxis`). Colours are reported as
      // the design token whose resolved value they equal (a probe span per
      // token, inside the root so any scoped override applies).
      let axis = null;
      const surfaceSvg = root.querySelector('svg.recharts-surface');
      if (wantPeriodTrendAxis && state === 'drawn' && surfaceSvg) {
        const tokenNames = ['muted-foreground', 'foreground', 'card', 'border', 'viz-context'];
        const probeHost = surfaceSvg.parentElement ?? root;
        const tokenColors = tokenNames.map((name) => {
          const probe = document.createElement('span');
          probe.style.color = `var(--${name})`;
          probeHost.appendChild(probe);
          const color = window.getComputedStyle(probe).color;
          probe.remove();
          return { name, color };
        });
        const tokenOf = (color) =>
          tokenColors.find((token) => token.color === color)?.name ?? color;
        const fontPx = (el) => parseFloat(window.getComputedStyle(el).fontSize);
        const fillToken = (el) => tokenOf(window.getComputedStyle(el).fill);
        const yTickEls = Array.from(
          surfaceSvg.querySelectorAll('.recharts-yAxis-tick-labels text'),
        );
        const xTickEls = Array.from(
          surfaceSvg.querySelectorAll('.recharts-xAxis-tick-labels text'),
        );
        const valueLabelEls = Array.from(
          root.querySelectorAll('[data-slot="trend-period-value-label"]'),
        );
        const referenceEls = Array.from(root.querySelectorAll('.trend-period-reference-label'));
        const horizontalLines = Array.from(
          surfaceSvg.querySelectorAll('.recharts-cartesian-grid-horizontal line'),
        );
        const svgRect = surfaceSvg.getBoundingClientRect();
        const plotLeftSvgPx = horizontalLines.length
          ? Math.min(...horizontalLines.map((line) => Number(line.getAttribute('x1'))))
          : null;
        const plotLeftClientPx =
          plotLeftSvgPx !== null && Number.isFinite(plotLeftSvgPx)
            ? svgRect.left + plotLeftSvgPx
            : null;
        // The sketch's gutter is measured from the content edge the trend's
        // head (overline + legend) starts at; with no head, the svg's own left.
        const headEl = root.querySelector('[data-slot="trend-period-head"]');
        const contentLeftPx = headEl ? headEl.getBoundingClientRect().left : svgRect.left;
        const tickRights = yTickEls.map((el) => el.getBoundingClientRect().right);
        const tickValueYs = yTickEls
          .map((el) => Number(el.getAttribute('y')))
          .filter((y) => Number.isFinite(y));
        axis = {
          yTickValues: yTickEls
            .map((el) => Number((el.textContent ?? '').replace(/[^\d.-]/g, '')))
            .filter((value) => Number.isFinite(value)),
          yTickFontPx: yTickEls.map(fontPx),
          yTickColorTokens: yTickEls.map(fillToken),
          xTickFontPx: xTickEls.map(fontPx),
          xTickColorTokens: xTickEls.map(fillToken),
          valueLabelFontPx: valueLabelEls.map(fontPx),
          valueLabelWeights: valueLabelEls.map((el) =>
            Number(window.getComputedStyle(el).fontWeight),
          ),
          valueLabelColorTokens: valueLabelEls.map(fillToken),
          referenceLabelFontPx: referenceEls.map(fontPx),
          gutterPx: plotLeftClientPx !== null ? plotLeftClientPx - contentLeftPx : null,
          tickGapPx:
            plotLeftClientPx !== null && tickRights.length
              ? plotLeftClientPx - Math.max(...tickRights)
              : null,
          verticalGridLines: surfaceSvg.querySelectorAll('.recharts-cartesian-grid-vertical line')
            .length,
          axisLines: surfaceSvg.querySelectorAll(
            '.recharts-cartesian-axis-line, .recharts-cartesian-axis-tick-line',
          ).length,
          strayHairlines: horizontalLines.filter((line) => {
            const y = Number(line.getAttribute('y1'));
            return !tickValueYs.some((tickY) => Math.abs(tickY - y) < 0.5);
          }).length,
        };
      }
      periodTrends.push({
        selectorPath: describeElement(root),
        state,
        yDomain,
        dotSizing: root.getAttribute('data-dot-sizing'),
        dots,
        valueLabels,
        strokedLineCount,
        yTickTexts,
        referenceLabel,
        referenceLabelSource,
        valueRangePx,
        valueRangeSource,
        rangeTicks,
        axis,
      });
    }
  }

  return {
    periodTrends,
    terminusFlowsPx,
    terminusLists,
    insightLineDashes,
    railCards,
    markLines,
    matrixTables,
    brandRed,
    recordCards,
    clipTargets,
    filterRows,
    filterRowOwnedInCards,
    statRows,
    placementItems,
    orderPairs,
    timelines,
    canvasCount,
    cards,
    truncationElements,
    overflowCards,
    headers,
    axisSurfaces,
    plotSurfaces,
    grids,
    pickers,
    rowCohesionRows,
    rowTags,
    nestedScrollers,
    nestedScrollPresenceList: nestedScrollPresenceList.length,
    cardHeightCards,
    formStrips,
    formStripLabelStrips,
    scrollHeight: document.documentElement.scrollHeight,
    scrollWidth: document.documentElement.scrollWidth,
    innerHeight: window.innerHeight,
    innerWidth: window.innerWidth,
  };
}

/**
 * Plan 39.1-49: the all-route table-clip sweep's collector. Runs entirely
 * inside the browser (no closures over module scope). Every match of
 * `scanSelector` plus each declared selector's first match, with `hidden`
 * for no client rects, visibility hidden, a box at most 1px in either axis,
 * or an ancestor-or-self clip-path / clip; visible items report their
 * nearest ancestor-or-self (before body) horizontal scroll / clip container
 * as a per-page `clipId`, its path and its scroll / client widths.
 */
function collectTableClipSweep(scanSelector, declaredSelectors) {
  function describeElement(el) {
    if (el.getAttribute('data-testid')) {
      return `[data-testid="${el.getAttribute('data-testid')}"]`;
    }
    if (el.id) {
      return `#${el.id}`;
    }
    if (el.getAttribute('data-slot')) {
      return `${el.tagName.toLowerCase()}[data-slot="${el.getAttribute('data-slot')}"]`;
    }
    const parts = [];
    let node = el;
    let depth = 0;
    while (node && node.nodeType === 1 && depth < 4) {
      let selector = node.tagName.toLowerCase();
      if (node.getAttribute('data-slot')) {
        selector += `[data-slot="${node.getAttribute('data-slot')}"]`;
      } else if (node.parentElement) {
        const siblingsOfType = Array.from(node.parentElement.children).filter(
          (child) => child.tagName === node.tagName,
        );
        if (siblingsOfType.length > 1) {
          selector += `:nth-of-type(${siblingsOfType.indexOf(node) + 1})`;
        }
      }
      parts.unshift(selector);
      node = node.parentElement;
      depth += 1;
    }
    return parts.join(' > ');
  }

  function isHidden(el) {
    if (el.getClientRects().length === 0) return true;
    const style = window.getComputedStyle(el);
    if (style.visibility === 'hidden') return true;
    const box = el.getBoundingClientRect();
    if (box.width <= 1 || box.height <= 1) return true;
    for (let node = el; node && node !== document.documentElement; node = node.parentElement) {
      const s = node === el ? style : window.getComputedStyle(node);
      if (s.clipPath && s.clipPath !== 'none') return true;
      if (s.clip && s.clip !== 'auto') return true;
    }
    return false;
  }

  const clipIds = new Map();
  function measure(el) {
    const kind = el.getAttribute('role') || el.tagName.toLowerCase();
    const targetPath = describeElement(el);
    if (isHidden(el)) {
      return { targetPath, kind, hidden: true, clipId: null, clipPath: null };
    }
    let clipEl = null;
    for (let node = el; node && node !== document.body; node = node.parentElement) {
      const overflowX = window.getComputedStyle(node).overflowX;
      if (overflowX === 'auto' || overflowX === 'scroll' || overflowX === 'hidden') {
        clipEl = node;
        break;
      }
    }
    if (!clipEl) {
      return {
        targetPath,
        kind,
        hidden: false,
        clipId: null,
        clipPath: null,
        scrollWidth: null,
        clientWidth: null,
      };
    }
    if (!clipIds.has(clipEl)) clipIds.set(clipEl, clipIds.size);
    return {
      targetPath,
      kind,
      hidden: false,
      clipId: clipIds.get(clipEl),
      clipPath: describeElement(clipEl),
      scrollWidth: clipEl.scrollWidth,
      clientWidth: clipEl.clientWidth,
    };
  }

  const candidates = Array.from(document.querySelectorAll(scanSelector)).map(measure);
  const declared = declaredSelectors.map((selector) => {
    const el = document.querySelector(selector);
    if (!el) return { selector, found: false };
    return { selector, found: true, ...measure(el) };
  });
  return {
    candidates,
    declared,
    page: {
      scrollWidth: document.documentElement.scrollWidth,
      innerWidth: window.innerWidth,
    },
  };
}

/**
 * Plan 39.1-49: the text-fit collector (runs inside the browser). For every
 * match of each target selector, a breadth-first walk of its descendants —
 * never into svg internals or a horizontal scroll container (the sweep owns
 * those). `hidden` ONLY for no client rects, visibility hidden, a zero clip
 * rect / inset clip-path, or an sr-only box (absolute and at most 1px both
 * ways): a zero-width, full-height text box stays visible, which is exactly
 * the starved Roster name the content-overflow walk cannot see.
 */
function collectTextFit(targetSelectors) {
  function describeElement(el) {
    if (el.getAttribute('data-testid')) {
      return `[data-testid="${el.getAttribute('data-testid')}"]`;
    }
    if (el.id) {
      return `#${el.id}`;
    }
    const parts = [];
    let node = el;
    let depth = 0;
    while (node && node.nodeType === 1 && depth < 4) {
      let selector = node.tagName.toLowerCase();
      if (node.getAttribute('data-slot')) {
        selector += `[data-slot="${node.getAttribute('data-slot')}"]`;
      } else if (node.parentElement) {
        const siblingsOfType = Array.from(node.parentElement.children).filter(
          (child) => child.tagName === node.tagName,
        );
        if (siblingsOfType.length > 1) {
          selector += `:nth-of-type(${siblingsOfType.indexOf(node) + 1})`;
        }
      }
      parts.unshift(selector);
      node = node.parentElement;
      depth += 1;
    }
    return parts.join(' > ');
  }

  const cardEdges = new Map();
  function edgesOf(card) {
    if (!cardEdges.has(card)) {
      const rect = card.getBoundingClientRect();
      const style = window.getComputedStyle(card);
      cardEdges.set(card, {
        left: rect.left + (parseFloat(style.borderLeftWidth) || 0),
        right: rect.right - (parseFloat(style.borderRightWidth) || 0),
      });
    }
    return cardEdges.get(card);
  }

  const targets = [];
  for (const selector of targetSelectors) {
    const roots = Array.from(document.querySelectorAll(selector));
    if (roots.length === 0) {
      targets.push({ selector, found: false, scanned: 0, items: [] });
      continue;
    }
    const items = [];
    let scanned = 0;
    let left = Infinity;
    let right = -Infinity;
    for (const root of roots) {
      const rootRect = root.getBoundingClientRect();
      if (rootRect.width > 0) {
        left = Math.min(left, rootRect.left);
        right = Math.max(right, rootRect.right);
      }
      const queue = Array.from(root.children);
      while (queue.length > 0) {
        const el = queue.shift();
        const style = window.getComputedStyle(el);
        const rect = el.getBoundingClientRect();
        const hidden =
          el.getClientRects().length === 0 ||
          style.visibility === 'hidden' ||
          style.clip === 'rect(0px, 0px, 0px, 0px)' ||
          (style.clipPath && style.clipPath.startsWith('inset')) ||
          (style.position === 'absolute' && rect.width <= 1 && rect.height <= 1);
        const isSvg = el.tagName.toLowerCase() === 'svg';
        const scroller = style.overflowX === 'auto' || style.overflowX === 'scroll';
        if (!hidden) {
          scanned += 1;
          const card = el.closest('[data-slot="card"]');
          const edges = card ? edgesOf(card) : null;
          const lineClamp = style.webkitLineClamp || style.getPropertyValue('-webkit-line-clamp');
          const lineClamped = Boolean(lineClamp) && lineClamp !== 'none';
          let titled = false;
          for (let node = el; node; node = node.parentElement) {
            if ((node.getAttribute('title') ?? '').trim().length > 0) {
              titled = true;
              break;
            }
            if (node === root) break;
          }
          items.push({
            selectorPath: describeElement(el),
            hidden: false,
            left: rect.left,
            right: rect.right,
            cardInnerLeft: edges ? edges.left : null,
            cardInnerRight: edges ? edges.right : null,
            hasText: !isSvg && (el.textContent ?? '').trim().length > 0,
            clips:
              !isSvg &&
              (style.overflowX === 'hidden' ||
                style.overflowX === 'clip' ||
                style.textOverflow === 'ellipsis' ||
                lineClamped),
            scrollWidth: el.scrollWidth,
            clientWidth: el.clientWidth,
            scrollHeight: el.scrollHeight,
            clientHeight: el.clientHeight,
            lineClamped,
            titled,
          });
        }
        if (!isSvg && !scroller) {
          for (const child of el.children) queue.push(child);
        }
      }
    }
    targets.push({
      selector,
      found: true,
      scanned,
      left: Number.isFinite(left) ? left : null,
      right: Number.isFinite(right) ? right : null,
      items,
    });
  }
  return { targets };
}

/**
 * Plan 39.2-12: a route declaring `storageSeed` ({ key, value }) gets that
 * localStorage entry written before any page script runs, so a device-local
 * store (the Dashboard digest) is in the state the route measures.
 */
async function seedRouteStorage(page, route) {
  if (!route.storageSeed) return;
  await page.evaluateOnNewDocument(
    (key, value) => {
      window.localStorage.setItem(key, value);
    },
    route.storageSeed.key,
    route.storageSeed.value,
  );
}

/**
 * Plan 39.1-49: one shell=app page load (production geometry — the harness's
 * MainLayout-geometry shell, what capture:design shoots) for the narrow
 * passes. Runs the route's prepare steps, waits for its loaded marker, then
 * (when asked) the table-clip sweep and the text-fit targets declared for
 * this viewport. A failed load or prepare is UNMEASURED, never a pass.
 */
async function measureShellPasses(browser, baseUrl, route, viewport, { sweep, fitTargets }) {
  const page = await browser.newPage();
  try {
    await page.setViewport({ width: viewport.width, height: viewport.height });
    if (route.scale) {
      await page.setExtraHTTPHeaders({ 'x-guard-layout-scale': route.scale });
    }
    await seedRouteStorage(page, route);
    await page.goto(`${baseUrl}/guard-layout.html?id=${encodeURIComponent(route.id)}&shell=app`, {
      waitUntil: 'networkidle0',
    });
    try {
      await runRoutePrepare(page, route.prepare ?? [], { timeoutMs: ROUTE_LOAD_TIMEOUT_MS });
    } catch (error) {
      return {
        unmeasured: true,
        reason: `shell=app prepare failed: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
    try {
      await page.waitForSelector(route.loadedMarker, { timeout: ROUTE_LOAD_TIMEOUT_MS });
    } catch {
      return {
        unmeasured: true,
        reason: `shell=app page-loaded marker "${route.loadedMarker}" never appeared within ${ROUTE_LOAD_TIMEOUT_MS}ms`,
      };
    }
    const result = { unmeasured: false, sweep: null, textFit: null };
    if (sweep) {
      const measured = await page.evaluate(
        collectTableClipSweep,
        TABLE_CLIP_SCAN_SELECTOR,
        route.clipTargets ?? [],
      );
      const mode = tableClipModeForRoute(route.id);
      const violations = evaluateTableClipSweep(measured, { mode });
      const clipped = violations.filter(
        (v) =>
          v.type === 'table-clipped' ||
          (v.type === 'table-clip-routed' && v.routedType === 'table-clipped'),
      ).length;
      result.sweep = { mode, violations, scanned: tableClipSweepScanned(measured), clipped };
    }
    if (fitTargets.length > 0) {
      const measured = await page.evaluate(
        collectTextFit,
        fitTargets.map((target) => target.selector),
      );
      const violations = evaluateTextFit(measured);
      result.textFit = {
        targets: fitTargets.length,
        scanned: measured.targets.reduce((sum, target) => sum + (target.scanned ?? 0), 0),
        violations,
      };
    }
    return result;
  } finally {
    await page.close();
  }
}

async function measureRouteAtViewport(browser, baseUrl, route, viewport) {
  const page = await browser.newPage();
  try {
    await page.setViewport({ width: viewport.width, height: viewport.height });
    // Plan 39.1-34: a route declaring `scale` selects one of the harness's
    // in-memory fixtures for its `/api/matches` reads; every other route
    // sends no such header (the server's initial scale, unchanged).
    if (route.scale) {
      await page.setExtraHTTPHeaders({ 'x-guard-layout-scale': route.scale });
    }
    await seedRouteStorage(page, route);
    await page.goto(`${baseUrl}/guard-layout.html?id=${encodeURIComponent(route.id)}`, {
      waitUntil: 'networkidle0',
    });

    // Plan 39.1-49: a route that needs input before its loaded marker exists
    // (Scout) drives the page first; a failed step is UNMEASURED.
    try {
      await runRoutePrepare(page, route.prepare ?? [], { timeoutMs: ROUTE_LOAD_TIMEOUT_MS });
    } catch (error) {
      return {
        unmeasured: true,
        reason: `prepare failed: ${error instanceof Error ? error.message : String(error)}`,
      };
    }

    try {
      await page.waitForSelector(route.loadedMarker, { timeout: ROUTE_LOAD_TIMEOUT_MS });
    } catch {
      return {
        unmeasured: true,
        reason: `page-loaded marker "${route.loadedMarker}" never appeared within ${ROUTE_LOAD_TIMEOUT_MS}ms`,
      };
    }

    // Plan 39.1-32: a route's `narrowChecks` (row-tag-legibility, nested-scroll)
    // are requested ONLY at viewports up to NARROW_VIEWPORT_MAX_WIDTH_PX wide
    // (UI-SPEC §6.6 "below 640") — every other route's `narrowChecks` is
    // `undefined`, so this adds nothing for them at any viewport.
    const checks = [
      ...(route.checks ?? []),
      ...(viewport.width <= NARROW_VIEWPORT_MAX_WIDTH_PX ? (route.narrowChecks ?? []) : []),
    ];
    // Plan 39.1-33: the route's own cardHeightCeilings markers, passed only
    // when card-height-ceiling was actually requested.
    const ceilingMarkers = checks.includes('card-height-ceiling')
      ? (route.cardHeightCeilings ?? [])
      : [];
    if (checks.includes('career-timeline')) {
      await page
        .waitForSelector('[data-slot="career-timeline-plot-area"]', {
          timeout: CAREER_TIMELINE_WAIT_MS,
        })
        .catch(() => {});
    }
    // Plan 39.1-38: the page-frame families' per-route declarations.
    const familyConfig = {
      filterRow: route.filterRow ?? null,
      placement: route.placement ?? [],
      orderPairs: route.orderPairs ?? [],
      clipTargets: route.clipTargets ?? [],
      railCards: route.railCards ?? null,
      gridBalance: route.gridBalance ?? null,
      // Plan 39.1-50: only when header-squeeze was requested.
      headerSqueeze: checks.includes('header-squeeze') ? headerSqueezeConfigForRoute(route) : null,
    };
    const measurements = await page.evaluate(
      collectPageMeasurements,
      checks,
      ceilingMarkers,
      familyConfig,
    );

    // Plan 39.1-51 (UI-SPEC §6.3 terminus allowance): a table-layout results
    // list counts at most 500 px toward the page budget; MEASUREMENT keeps the
    // raw ratio, TERMINUS_BUDGET prints both.
    const excludedPx = terminusBudgetExcessPx(measurements.terminusFlowsPx);
    const violations = [
      ...evaluateStretch(measurements.cards),
      ...evaluateScrollBudget(
        {
          scrollHeight: measurements.scrollHeight - excludedPx,
          innerHeight: measurements.innerHeight,
          viewportName: viewport.name,
        },
        { ...DEFAULT_SCROLL_BUDGETS, ...(route.scrollBudgets ?? {}) },
      ),
      ...evaluateHorizontalOverflow({
        scrollWidth: measurements.scrollWidth,
        innerWidth: measurements.innerWidth,
      }),
      ...evaluateTruncation(measurements.truncationElements),
    ];

    // Plan 39.1-30: the four new families, only for a route's opted-in
    // checks — each requested family also runs its own non-vacuity presence
    // check (a selector/structure drift must fail loudly, never silently
    // report zero violations).
    if (checks.includes('content-overflow')) {
      violations.push(...evaluateCardContentOverflow(measurements.overflowCards));
      violations.push(...evaluateFamilyPresence('content-overflow', measurements.overflowCards));
    }
    if (checks.includes('header-squeeze')) {
      violations.push(...evaluateHeaderSqueeze(measurements.headers));
      violations.push(...evaluateFamilyPresence('header-squeeze', measurements.headers));
    }
    if (checks.includes('axis-ticks')) {
      violations.push(...evaluateAxisTicks(measurements.axisSurfaces));
      violations.push(...evaluateAxisPresence(measurements.axisSurfaces));
    }
    // Plan 39.1-37: plot-aspect (its presence check is inside the evaluator).
    if (checks.includes('plot-aspect')) {
      violations.push(
        ...evaluatePlotAspect({
          viewportWidth: viewport.width,
          surfaces: measurements.plotSurfaces,
        }),
      );
    }
    if (checks.includes('grid-balance')) {
      violations.push(...evaluateGridBalance(measurements.grids));
      violations.push(...evaluateFamilyPresence('grid-balance', measurements.grids));
    }
    // Plan 39.1-32: the four mobile gap-closure families, same opt-in
    // discipline (requested + presence check together).
    if (checks.includes('picker-alignment')) {
      violations.push(...evaluatePickerAlignment(measurements.pickers));
      violations.push(...evaluateFamilyPresence('picker-alignment', measurements.pickers));
    }
    if (checks.includes('row-cohesion')) {
      violations.push(...evaluateRowCohesion(measurements.rowCohesionRows));
      violations.push(...evaluateFamilyPresence('row-cohesion', measurements.rowCohesionRows));
    }
    if (checks.includes('row-tag-legibility')) {
      violations.push(...evaluateRowTagLegibility(measurements.rowTags));
      violations.push(...evaluateFamilyPresence('row-tag-legibility', measurements.rowTags));
    }
    if (checks.includes('nested-scroll')) {
      violations.push(...evaluateNestedScrollers(measurements.nestedScrollers));
      violations.push(
        ...evaluateFamilyPresence(
          'nested-scroll',
          Array.from({ length: measurements.nestedScrollPresenceList }),
        ),
      );
    }
    // Plan 39.1-33: card-height-ceiling + form-strip-fit, same opt-in
    // discipline (requested + presence check together).
    if (checks.includes('card-height-ceiling')) {
      violations.push(
        ...evaluateCardHeightCeilings({
          innerHeight: measurements.innerHeight,
          cards: measurements.cardHeightCards,
        }),
      );
      violations.push(
        ...evaluateFamilyPresence('card-height-ceiling', measurements.cardHeightCards),
      );
    }
    if (checks.includes('form-strip-fit')) {
      violations.push(...evaluateFormStripFit(measurements.formStrips));
      violations.push(...evaluateFamilyPresence('form-strip-fit', measurements.formStrips));
    }
    // Plan 39.1-42: form-strip-labels (its own presence check is inside the
    // evaluator: an empty list is `form-strip-labels-unmeasured`).
    if (checks.includes('form-strip-labels')) {
      violations.push(...evaluateFormStripLabels(measurements.formStripLabelStrips));
    }
    // Plan 39.1-34: the career-timeline family (its own presence check is
    // inside the evaluator: an empty list is `career-timeline-unmeasured`).
    if (checks.includes('career-timeline')) {
      violations.push(
        ...evaluateCareerTimeline(
          { timelines: measurements.timelines, canvasCount: measurements.canvasCount },
          route.timelineExpect ?? {},
        ),
      );
    }

    // Plan 39.1-38: the page-frame families (each evaluator carries its own
    // non-vacuity `-unmeasured` path).
    if (checks.includes('filter-row')) {
      violations.push(
        ...evaluateFilterRow({
          viewportWidth: viewport.width,
          maxHeightPx: route.filterRow?.maxHeightPx,
          owners: route.filterRow?.owns ?? [],
          rows: measurements.filterRows,
          ownedInCards: measurements.filterRowOwnedInCards,
        }),
      );
    }
    if (checks.includes('stat-row-columns')) {
      violations.push(...evaluateStatRowColumns(measurements.statRows));
    }
    if (checks.includes('placement')) {
      violations.push(
        ...evaluatePlacement({ viewportWidth: viewport.width, items: measurements.placementItems }),
      );
    }
    if (checks.includes('insight-order')) {
      violations.push(...evaluateInsightOrder(measurements.orderPairs));
    }
    if (checks.includes('table-clip')) {
      violations.push(...evaluateTableClip(measurements.clipTargets));
    }
    // Plan 39.1-39 (each evaluator carries its own -unmeasured path).
    if (checks.includes('brand-red-text')) {
      violations.push(...evaluateBrandRedText(measurements.brandRed));
    }
    if (checks.includes('record-fit')) {
      violations.push(...evaluateRecordFit(measurements.recordCards));
    }
    if (checks.includes('mark-count')) {
      violations.push(...evaluateMarkCount(measurements.markLines));
    }
    if (checks.includes('matrix-hug')) {
      violations.push(
        ...evaluateMatrixHug({ viewportWidth: viewport.width, tables: measurements.matrixTables }),
      );
    }
    // Plan 39.1-40: rail-cards (requested + presence check together).
    if (checks.includes('rail-cards')) {
      violations.push(
        ...evaluateRailCards(measurements.railCards, { minCards: route.railCards?.minCards ?? 1 }),
      );
      violations.push(...evaluateFamilyPresence('rail-cards', measurements.railCards));
    }
    if (checks.includes('insight-line-dash')) {
      violations.push(...evaluateInsightLineDash(measurements.insightLineDashes));
      violations.push(
        ...evaluateFamilyPresence('insight-line-dash', measurements.insightLineDashes),
      );
    }
    // Plan 39.1-41: period-trend-marks against the route's own expectation;
    // the PERIOD_TREND lines print whether or not it passed.
    // Plan 39.1-43b: the value range is the hairlines' px-per-point scale
    // times the declared domain (a sketch-stepped axis may leave the
    // domain's top without a hairline); the raw span is kept when no tick
    // values were read.
    for (const surface of measurements.periodTrends ?? []) {
      const scaled = periodValueRangeFromTicks(surface.rangeTicks, surface.yDomain);
      if (scaled !== null) surface.valueRangePx = scaled;
    }
    if (checks.includes('period-trend-marks')) {
      violations.push(
        ...evaluatePeriodTrendMarks(measurements.periodTrends, route.periodTrendExpect ?? {}),
      );
    }
    if (checks.includes('period-trend-axis')) {
      violations.push(
        ...evaluatePeriodTrendAxis(measurements.periodTrends, route.periodTrendAxisExpect ?? {}),
      );
    }
    // Plan 39.1-51 (OOS-8): one LAST_ROW record per list root.
    const lastRows = [];
    if (checks.includes('last-row-visible')) {
      violations.push(...evaluateLastRowVisible(measurements.terminusLists));
      violations.push(...evaluateFamilyPresence('last-row-visible', measurements.terminusLists));
      for (const list of measurements.terminusLists) {
        const own = evaluateLastRowVisible([list]);
        lastRows.push({
          layout: list.layout,
          mounted: list.mounted,
          total: list.total,
          contentPx: list.contentPx,
          lastRowVisible: list.lastRow !== null && !own.some((v) => v.type === 'last-row-clipped'),
          innerScrollers: own.filter((v) => v.type === 'terminus-inner-scroller').length,
        });
      }
    }

    // Plan 39.1-20 Task 3: recorded regardless of pass/fail — the plan's own
    // output contract requires the measured maximum card stretch and the
    // measured scroll-height ratio for EVERY route at EVERY viewport, not
    // only the routes that were over budget.
    const maxStretchPx = measurements.cards.reduce((max, card) => {
      const contentHeight = card.lastChildBottom - card.top + card.paddingBottom;
      return Math.max(max, card.height - contentHeight);
    }, 0);
    const scrollRatio = measurements.scrollHeight / measurements.innerHeight;
    const terminusBudget =
      measurements.terminusFlowsPx.length > 0
        ? {
            tables: measurements.terminusFlowsPx.length,
            flowPx: measurements.terminusFlowsPx.reduce((sum, px) => sum + px, 0),
            excludedPx,
            scrollRatio,
            budgetRatio: (measurements.scrollHeight - excludedPx) / measurements.innerHeight,
          }
        : null;

    return {
      unmeasured: false,
      violations,
      maxStretchPx,
      scrollRatio,
      terminusBudget,
      lastRows,
      cardHeightCards: measurements.cardHeightCards,
      innerHeight: measurements.innerHeight,
      timelines: checks.includes('career-timeline') ? measurements.timelines : [],
      plotSurfaces: checks.includes('plot-aspect') ? measurements.plotSurfaces : [],
      railCards: checks.includes('rail-cards') ? measurements.railCards : [],
      periodTrends: checks.includes('period-trend-marks') ? measurements.periodTrends : [],
      periodTrendAxes: checks.includes('period-trend-axis')
        ? measurements.periodTrends.filter((surface) => surface.state !== 'locked')
        : [],
      formStripLabelStrips: checks.includes('form-strip-labels')
        ? measurements.formStripLabelStrips
        : [],
    };
  } finally {
    await page.close();
  }
}

/**
 * WR-B03 (39.1-REVIEW.md): the `try/catch/finally` below only unwinds on
 * normal completion, a thrown error, or the hard timeout — none of that
 * runs on `SIGINT`/`SIGTERM`, because Node's default behaviour for those
 * signals is to terminate immediately without ever reaching the `finally`
 * block. A developer/CI job cancelling a hung `pnpm guard:layout` with
 * Ctrl-C left an orphaned headless Chromium process and an orphaned Vite
 * dev server bound to a loopback port — this repo has a zombie-CLI history
 * (`enrichDemoAccounts.ts`) the hard timeout above already guards against
 * for hangs; this guards the OTHER half, operator cancellation.
 *
 * A FACTORY, not a bare function with module-level mutable state — each
 * call returns a fresh closure with its own `shuttingDown` guard and its
 * own injected `kill`/`offListeners`, so `guardLayoutShutdown.test.mjs` can
 * unit-test the exact shutdown ORDERING (browser closed, then server, then
 * listeners removed, then the signal re-raised — and a second signal during
 * cleanup is a no-op) against fake browser/server/process objects, with no
 * real Puppeteer, no real Vite server, and no interaction with this actual
 * process's real signal listeners.
 */
export function createShutdownHandler({
  browser,
  server,
  offListeners,
  kill = (signal) => process.kill(process.pid, signal),
}) {
  let shuttingDown = false;
  return async function shutdownOnSignal(signal) {
    if (shuttingDown) return;
    shuttingDown = true;
    await browser.close().catch(() => {});
    await server.close().catch(() => {});
    offListeners();
    // `signal` is re-raised via `kill` (rather than a bare `process.exit`)
    // so the exit reflects the conventional 128+signal code AND so a second
    // Ctrl-C during cleanup can't re-enter this handler (the listeners are
    // already removed above).
    kill(signal);
  };
}

/**
 * WR-10 (39.1-REVIEW.md): how long the hard-timeout exit waits for Vite's
 * `server.close()` (or, with no browser process handle, `browser.close()`)
 * before giving up on it and exiting anyway — the timeout path exists to
 * FORCE an exit, so no cleanup step may be allowed to hang it.
 */
export const HARD_TIMEOUT_CLOSE_BOUND_MS = 5_000;

/** Resolves when `promise` settles or `ms` elapses, whichever is first — never rejects. */
function settleWithin(promise, ms) {
  let timer;
  const bound = new Promise((resolve) => {
    timer = setTimeout(resolve, ms);
  });
  return Promise.race([Promise.resolve(promise).catch(() => {}), bound]).finally(() =>
    clearTimeout(timer),
  );
}

/**
 * WR-10 (39.1-REVIEW.md): the hard-timeout exit, as a factory so
 * `guardLayoutShutdown.test.mjs` can drive it with fakes. Puppeteer launches
 * Chrome `detached` on POSIX — Chrome is its own process-group leader — and
 * its own `kill()` signals `-pid`, the whole group. Signalling only the
 * leader (the previous code) could orphan helper processes (crashpad
 * handler, zygote), so this SIGKILLs the process GROUP via `kill(-pid)`,
 * falling back to the leader where a group kill is unsupported (Windows
 * rejects a negative pid). Every close it still awaits is bounded by
 * `serverCloseTimeoutMs`, then it prints the summary and exits 1. Idempotent:
 * a second call is a no-op.
 */
export function createHardTimeoutExit({
  browser,
  server,
  offListeners,
  printSummary,
  exit = (code) => process.exit(code),
  kill = (pid, signal) => process.kill(pid, signal),
  serverCloseTimeoutMs = HARD_TIMEOUT_CLOSE_BOUND_MS,
}) {
  let fired = false;
  return async function forceExit() {
    if (fired) return;
    fired = true;
    offListeners();
    const browserProcess = browser.process?.() ?? null;
    if (browserProcess && browserProcess.pid != null) {
      try {
        kill(-browserProcess.pid, 'SIGKILL');
      } catch {
        try {
          browserProcess.kill('SIGKILL');
        } catch {
          // Already gone — nothing left to kill.
        }
      }
    } else {
      await settleWithin(browser.close(), serverCloseTimeoutMs);
    }
    await settleWithin(server.close(), serverCloseTimeoutMs);
    printSummary();
    exit(1);
  };
}

async function main() {
  const { server, baseUrl } = await startGuardLayoutHarnessServer();
  // WR-B03 (39.1-REVIEW.md): Puppeteer's own launcher (`@puppeteer/browsers`)
  // defaults `handleSIGINT`/`handleSIGTERM`/`handleSIGHUP` to `true` — it
  // registers ITS OWN signal handler that kills the browser and then calls
  // `process.exit(130)` directly on SIGINT, with no knowledge of the Vite
  // server at all. Disabled here so it never competes with this script's
  // own handler below.
  const browser = await puppeteer.launch({
    handleSIGINT: false,
    handleSIGTERM: false,
    handleSIGHUP: false,
  });
  // Vite's OWN dev server ALSO installs a competing SIGTERM listener
  // (`setupSIGTERMListener` in its `createServer`), which gracefully closes
  // ONLY the Vite server and calls `process.exit()` — with no knowledge of
  // the Puppeteer browser. Left in place alongside this script's own
  // handler below, the two would race: whichever `process.exit`/`kill` call
  // resolves first wins, and Puppeteer's browser process (launched
  // `detached`, so it does NOT die automatically with its parent) could be
  // left running if Vite's handler wins that race. Removed here so this
  // script's own `createShutdownHandler` handler is the SOLE owner of the
  // whole shutdown (browser AND server, in order) on any signal — there is
  // no reason for either dependency's own signal handling to run instead.
  process.removeAllListeners('SIGINT');
  process.removeAllListeners('SIGTERM');
  // Diagnostic line — useful when debugging the harness by hand; never
  // parsed by any CI workflow (this repo has none) or `pnpm guard:layout`
  // consumer.
  console.log(`HARNESS_BASE_URL=${baseUrl}`);

  const shutdownOnSignal = createShutdownHandler({
    browser,
    server,
    offListeners: () => {
      process.off('SIGINT', sigintHandler);
      process.off('SIGTERM', sigtermHandler);
    },
  });
  const sigintHandler = () => void shutdownOnSignal('SIGINT');
  const sigtermHandler = () => void shutdownOnSignal('SIGTERM');
  process.on('SIGINT', sigintHandler);
  process.on('SIGTERM', sigtermHandler);

  let exitCode = 0;
  let measuredCount = 0;
  const unmeasuredIds = new Set();

  // Plan 39.1-30 first_fix: the hard timeout must exit PROMPTLY. `Promise.race`
  // cannot cancel the losing side — once the timeout branch rejects, the
  // measurement loop below keeps running unawaited in the background. The
  // original code's ONLY cleanup was the `finally` block's graceful
  // `browser.close()`, which itself waits on the SAME CDP connection the
  // orphaned `page.evaluate()` is still using — measured taking ~16 minutes
  // wall-clock to actually exit. `forceExitOnTimeout` is fired the instant
  // the timer elapses (see `withHardTimeout`'s `onTimeout` hook): it
  // SIGKILLs the browser's whole process GROUP directly (no graceful CDP
  // round trip, so it cannot be blocked by an in-flight orphaned evaluate),
  // closes the server within a bound (WR-10, `createHardTimeoutExit`),
  // prints the same summary lines the normal path prints, and calls
  // `process.exit(1)` itself — never returning control to the `try/catch`
  // below, whose own cleanup would otherwise still be racing the orphaned
  // loop.
  let hardTimedOut = false;
  const hardTimeoutExit = createHardTimeoutExit({
    browser,
    server,
    offListeners: () => {
      process.off('SIGINT', sigintHandler);
      process.off('SIGTERM', sigtermHandler);
    },
    printSummary: () => {
      console.log(`MEASURED_ROUTES=${measuredCount}`);
      console.log(
        `UNMEASURED_ROUTES=${unmeasuredIds.size > 0 ? [...unmeasuredIds].join(',') : 'NONE'}`,
      );
    },
  });
  const forceExitOnTimeout = async () => {
    hardTimedOut = true;
    console.error(`guardLayout exceeded its ${HARD_TIMEOUT_MS}ms hard timeout — force-exiting`);
    await hardTimeoutExit();
  };

  // Plan 39.1-49: the shell=app passes after a route's measurement at a
  // viewport — the all-route table-clip sweep at every narrow viewport (at
  // most NARROW_VIEWPORT_MAX_WIDTH_PX wide) and the text-fit targets the
  // route declares for that viewport. Always prints its TABLE_CLIP /
  // TEXT_FIT line; enforce-mode offenders are ordinary VIOLATION lines,
  // Matchups' routed ones TABLE_CLIP_ROUTED lines (exit code untouched).
  const sweptIds = new Set(tableClipSweepRoutes(LAYOUT_ORACLE_ROUTES).map((route) => route.id));
  async function runShellPasses(route, viewport) {
    const sweep = viewport.width <= NARROW_VIEWPORT_MAX_WIDTH_PX && sweptIds.has(route.id);
    const fitTargets = fitTargetsForViewport(route, viewport.name);
    if (!sweep && fitTargets.length === 0) return;
    const result = await measureShellPasses(browser, baseUrl, route, viewport, {
      sweep,
      fitTargets,
    });
    if (hardTimedOut) return;
    if (result.unmeasured) {
      console.log(
        `UNMEASURED route=${route.id} viewport=${viewport.name} reason="${result.reason}"`,
      );
      unmeasuredIds.add(route.id);
      exitCode = 1;
      return;
    }
    if (result.sweep) {
      const { mode, violations, scanned, clipped } = result.sweep;
      console.log(
        `TABLE_CLIP route=${route.id} viewport=${viewport.name} shell=app mode=${mode} scanned=${scanned} clipped=${clipped}`,
      );
      for (const violation of violations) {
        if (violation.type === 'table-clip-routed') {
          console.log(
            `TABLE_CLIP_ROUTED route=${route.id} viewport=${viewport.name} owner=39.1-41..48 selector=${violation.selectorPath ?? 'n/a'} detail=${JSON.stringify(violation)}`,
          );
          continue;
        }
        console.log(
          `VIOLATION route=${route.id} viewport=${viewport.name} type=${violation.type} selector=${violation.selectorPath ?? 'n/a'} detail=${JSON.stringify(violation)}`,
        );
        exitCode = 1;
      }
    }
    if (result.textFit) {
      const { targets, scanned, violations } = result.textFit;
      console.log(
        `TEXT_FIT route=${route.id} viewport=${viewport.name} shell=app targets=${targets} scanned=${scanned} offenders=${violations.length}`,
      );
      for (const violation of violations) {
        console.log(
          `VIOLATION route=${route.id} viewport=${viewport.name} type=${violation.type} selector=${violation.selectorPath ?? 'n/a'} detail=${JSON.stringify(violation)}`,
        );
        exitCode = 1;
      }
    }
  }

  try {
    await withHardTimeout(
      (async () => {
        for (const route of LAYOUT_ORACLE_ROUTES) {
          if (hardTimedOut) break;
          // Plan 39.1-30: a route's own `extraViewports` (keys of
          // `EXTRA_ORACLE_VIEWPORTS`) are measured IN ADDITION TO the three
          // standard viewports — every other route's viewport set is
          // unchanged (`extraViewports` is `undefined` for them).
          // CR-01: a route's own `viewports` (names from
          // `LAYOUT_ORACLE_VIEWPORTS`) restricts the standard set — only the
          // fixed-width period-axis fixture uses it.
          const standardViewports = route.viewports
            ? LAYOUT_ORACLE_VIEWPORTS.filter((viewport) => route.viewports.includes(viewport.name))
            : LAYOUT_ORACLE_VIEWPORTS;
          const routeViewports = [
            ...standardViewports,
            ...(route.extraViewports ?? []).map((key) => EXTRA_ORACLE_VIEWPORTS[key]),
          ];
          for (const viewport of routeViewports) {
            if (hardTimedOut) break;
            const result = await measureRouteAtViewport(browser, baseUrl, route, viewport);
            if (hardTimedOut) break;
            if (result.unmeasured) {
              console.log(
                `UNMEASURED route=${route.id} viewport=${viewport.name} reason="${result.reason}"`,
              );
              unmeasuredIds.add(route.id);
              exitCode = 1;
              await runShellPasses(route, viewport);
              continue;
            }
            measuredCount += 1;
            console.log(
              `MEASUREMENT route=${route.id} viewport=${viewport.name} maxStretchPx=${result.maxStretchPx.toFixed(1)} scrollRatio=${result.scrollRatio.toFixed(3)}`,
            );
            // Plan 39.1-51 (OOS-8): the terminus allowance's context line
            // (every route-viewport with a table-layout results list) and one
            // LAST_ROW line per list root when the family was requested.
            if (result.terminusBudget) {
              const tb = result.terminusBudget;
              console.log(
                `TERMINUS_BUDGET route=${route.id} viewport=${viewport.name} tables=${tb.tables} flowPx=${tb.flowPx.toFixed(1)} excludedPx=${tb.excludedPx.toFixed(1)} scrollRatio=${tb.scrollRatio.toFixed(3)} budgetRatio=${tb.budgetRatio.toFixed(3)}`,
              );
            }
            for (const row of result.lastRows ?? []) {
              console.log(
                `LAST_ROW route=${route.id} viewport=${viewport.name} layout=${row.layout} mounted=${row.mounted} total=${row.total} contentPx=${row.contentPx.toFixed(1)} lastRowVisible=${row.lastRowVisible} innerScrollers=${row.innerScrollers}`,
              );
            }
            // Plan 39.1-41: one PERIOD_TREND line per measured period trend.
            for (const surface of result.periodTrends ?? []) {
              console.log(formatPeriodTrendLine(route.id, viewport.name, surface));
            }
            // Plan 39.1-43b: one PERIOD_TREND_AXIS line per drawn period trend.
            for (const surface of result.periodTrendAxes ?? []) {
              console.log(formatPeriodTrendAxisLine(route.id, viewport.name, surface));
            }
            // Plan 39.1-42: one FORM_STRIP line per measured strip root.
            for (const strip of result.formStripLabelStrips ?? []) {
              console.log(formatFormStripLine(route.id, viewport.name, strip));
            }
            // Plan 39.1-40: one RAILCARDS line per measured reads rail,
            // right after the MEASUREMENT line, whether or not it passed.
            for (const rail of result.railCards ?? []) {
              console.log(
                `RAILCARDS route=${route.id} viewport=${viewport.name} cards=${rail.cards} fallback=${rail.fallback} templates=${rail.templates.length > 0 ? rail.templates.join(',') : 'none'}`,
              );
            }
            // Plan 39.1-33: one CARD_HEIGHT line per measured ceiling marker,
            // printed right after the MEASUREMENT line, regardless of
            // pass/fail — mirrors the MEASUREMENT line's own always-print
            // discipline.
            for (const card of result.cardHeightCards ?? []) {
              if (card.height == null) continue;
              const limitPx = card.maxViewportHeights * result.innerHeight;
              console.log(
                `CARD_HEIGHT route=${route.id} viewport=${viewport.name} marker=${card.marker} height=${card.height.toFixed(1)} limitPx=${limitPx.toFixed(1)}`,
              );
            }
            // Plan 39.1-37: one PLOT_ASPECT line per measured chart plot,
            // printed whether or not it passed — the recordable ratios.
            for (const surface of result.plotSurfaces ?? []) {
              console.log(
                `PLOT_ASPECT route=${route.id} viewport=${viewport.name} width=${surface.width.toFixed(1)} height=${surface.height.toFixed(1)} ratio=${(surface.width / surface.height).toFixed(2)}`,
              );
            }
            // Plan 39.1-34: one TIMELINE line per measured career timeline
            // (first root), printed right after the MEASUREMENT line whether
            // or not it passed — the recordable mark counts and alignment.
            const timeline = (result.timelines ?? [])[0];
            if (timeline) {
              const maxAlignDeltaPx = careerTimelineEdgeDeltas(timeline).reduce(
                (max, delta) => Math.max(max, delta.deltaPx),
                0,
              );
              console.log(
                `TIMELINE route=${route.id} viewport=${viewport.name} state=${timeline.state} plotWidth=${timeline.plotWidth.toFixed(1)} grain=${timeline.stripGrain ?? 'none'} points=${timeline.anchors.length} vertices=${timeline.lineVertexCount} rateCells=${timeline.rateCells.length} gamesCells=${timeline.gamesCells.length} maxAlignDeltaPx=${maxAlignDeltaPx.toFixed(1)}`,
              );
            }
            for (const violation of result.violations) {
              console.log(
                `VIOLATION route=${route.id} viewport=${viewport.name} type=${violation.type} selector=${violation.selectorPath ?? 'n/a'} detail=${JSON.stringify(violation)}`,
              );
              exitCode = 1;
            }
            await runShellPasses(route, viewport);
          }
          // Plan 39.1-49: a fit viewport the route loop never measured (Scout
          // at 1440) still gets its shell=app text-fit load.
          for (const name of fitViewportsOutsideRoute(
            route,
            routeViewports.map((viewport) => viewport.name),
          )) {
            if (hardTimedOut) break;
            const viewport = LAYOUT_ORACLE_VIEWPORTS.find((v) => v.name === name);
            if (viewport) await runShellPasses(route, viewport);
          }
        }
      })().catch((error) => {
        // Swallow errors from the ABANDONED loop after a hard timeout — the
        // browser process is already SIGKILLed by `forceExitOnTimeout`, so
        // an in-flight `page.evaluate()`/`browser.newPage()` throws almost
        // immediately ("Protocol error", "Target closed"). That rejection
        // has nothing left to report to — `forceExitOnTimeout` already
        // printed the summary and is calling `process.exit(1)`. Re-throwing
        // here would surface as an actual unhandled rejection.
        if (hardTimedOut) return;
        throw error;
      }),
      HARD_TIMEOUT_MS,
      'guardLayout',
      forceExitOnTimeout,
    );
  } catch (error) {
    if (hardTimedOut) {
      // `forceExitOnTimeout` already printed the summary and is calling
      // `process.exit(1)` — do not race it with a second summary/exit.
      return;
    }
    console.error(error instanceof Error ? (error.stack ?? error.message) : String(error));
    exitCode = 1;
  } finally {
    if (!hardTimedOut) {
      // Normal completion: unregister the signal handlers ABOVE actually
      // closing browser/server — a signal arriving in the narrow window
      // during this shutdown would otherwise race a second close against
      // the one already in flight (both `.close()` calls below are already
      // idempotent via `.catch(() => {})`, but there is no reason to leave
      // the listeners live past this point).
      process.off('SIGINT', sigintHandler);
      process.off('SIGTERM', sigtermHandler);
      await browser.close().catch(() => {});
      await server.close().catch(() => {});
    }
  }

  if (hardTimedOut) {
    // `forceExitOnTimeout` owns the exit in this path.
    return;
  }

  console.log(`MEASURED_ROUTES=${measuredCount}`);
  console.log(
    `UNMEASURED_ROUTES=${unmeasuredIds.size > 0 ? [...unmeasuredIds].join(',') : 'NONE'}`,
  );

  process.exit(exitCode);
}

// Only auto-run when this file is executed directly (`node guardLayout.mjs` /
// `pnpm guard:layout`) — NOT when imported as a module, e.g. by
// `guardLayoutShutdown.test.mjs`'s unit tests against `createShutdownHandler`
// above. Without this guard, importing this file for that ONE named export
// would also launch a real Puppeteer browser, a real Vite dev server, and
// the full route-measurement sweep as an unwanted side effect of the import.
if (import.meta.url === `file://${process.argv[1]}`) {
  void main();
}
