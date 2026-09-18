# Chart kit

Recharts-based chart primitives for grandfinals.gg. This is the ONE place a chart is allowed to
come from — read this before adding a sixth chart.

## Boundary: where this kit may be imported from

- **Recharts** (`recharts`) may only be imported from inside this directory
  (`apps/web/src/components/charts/**`).
- **chart.js** / **react-chartjs-2** may only be imported from this directory, or from the ten
  legacy chart.js components Phase 41 will migrate onto this kit (each one is named explicitly in
  the allowlists below — the list shrinks as Phase 41 lands, never grows).

Two independent, committed oracles enforce this, plus a third that enforces the runtime
consequence of getting it wrong:

1. **`eslint.config.js`** — a `no-restricted-imports` rule scoped to `apps/web/**/*.{ts,tsx}`,
   with an `ignores` array naming this directory and the ten legacy files. Catches a bad import at
   edit time (`pnpm lint`).
2. **`chartKitBoundary.test.ts`** — a committed test in the DEFAULT `pnpm test` suite that greps
   the source tree for the same two import patterns. It also proves the allowlist can't rot (every
   entry must still exist and still need the exemption) and proves the **frame rule** described
   below. This is the CI-independent half: it still catches a violation even somewhere lint isn't
   run.
3. **`bundleIsolation.guard.test.ts`** — a real production `vite build`, excluded from the default
   suite (`pnpm run guard:chart-bundle`), that proves the CONSEQUENCE of the boundary holding:
   Recharts and its runtime dependencies never land in the entry chunk or anywhere statically
   reachable from it, and the entry document's `modulepreload` count is locked at a measured
   integer. A page can pass the two source-level checks above and still leak a chart library into
   the eager boot graph if the Vite chunking config regresses — this guard is what catches that
   class of bug (it caught a real one during this kit's own build, see `vite.config.ts`'s doc
   comment on the `codeSplitting` predicate).

**The frame rule is structural, not lexical.** The rule is "a Recharts element is only ever
rendered inside a `ChartCard`" — NOT "a file that imports a kit primitive also imports
`ChartCard`". A page is allowed to own the `ChartCard` frame while a child component it renders
owns the actual chart primitive (see `MatchupChart.tsx`, which imports `TrendLine` but not
`ChartCard` — its host, `MatchupsPage.tsx`, supplies the frame). `chartKitBoundary.test.ts` proves
this by asserting, in both directions, that the set of kit files importing `recharts` exactly
equals a named `KIT_CHART_PRIMITIVES` list, and that every member of that list has a colocated
test proving it renders inside a `ChartCard`.

## Tokens (`tokens.ts`)

One token map, no colour-scheme branch — the app is dark-only, and `:root`/`.dark` share an
identical palette. SVG resolves CSS custom properties natively in `stroke`/`fill`, so unlike
chart.js this kit does NOT keep a resolved-hex mirror (`apps/web/src/lib/chartTheme.ts`'s pattern
is the one this kit deliberately does not repeat).

| Token       | Role                                                                                                                                 | Status                                                                                                                                                                                                                                                                                                                                                              |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `--chart-1` | The one series-identity colour this phase uses (the win-rate trend line). Single series → no legend box; the title already names it. | Validated: dark-band lightness, chroma floor, contrast on `--card` all pass.                                                                                                                                                                                                                                                                                        |
| `--chart-4` | RESERVED for a second series slot (a future two-series comparison, e.g. small-multiples). Not rendered anywhere yet.                 | Validated as the `{--chart-1, --chart-4}` pair — hand this pair to the next chart that needs two identity series, don't pick a fresh one.                                                                                                                                                                                                                           |
| `--chart-2` | De-emphasis ink only (reference lines, previous-period segments). NEVER an identity series.                                          | Achromatic — fails the categorical chroma floor by design; that's correct for de-emphasis, not a defect.                                                                                                                                                                                                                                                            |
| `--chart-5` | Same de-emphasis role as `--chart-2`, one step darker (gridlines, an unfilled meter track). NEVER an identity series.                | Same as `--chart-2`.                                                                                                                                                                                                                                                                                                                                                |
| `--chart-3` | **NOT USED anywhere in this kit.**                                                                                                   | **Documented defect, not silently dropped:** its lightness (`L 0.80`) sits above the dark-mode lightness ceiling (`0.67`) the palette validator enforces — it reads washed-out/low-contrast on `--card`. Needs re-stepping (darker `L`) before any future chart uses it as a mark colour. See `37-UI-SPEC.md`'s "Chart Kit Palette" table for the measured figures. |

**The collision rule:** a series that means good/bad wears status tokens (`emerald-500`/`600` for
"pick"/win, `--destructive` for "ban"/loss — the app's existing convention). A series that is only
identity wears a categorical token (`--chart-1..5`). Never both in one chart. The win-rate trend
line's colour (`--chart-1`) carries NO win/loss judgement on its own — a reader must never read
"the line is red, therefore losing" from hue alone. Meaning comes from the line's Y-position and
the tooltip's numeric value, never from its colour. (`--chart-1` and `--destructive` are both
red-family hues serving different jobs — never render both as marks in the same chart.)

## Where the jsdom stub is licensed

`apps/web/src/test/stubs/react-chartjs-2.tsx` is a test stub for the CANVAS library
(`react-chartjs-2`), reached through a vitest `resolve.alias` in `apps/web/vitest.config.ts` — not
through an `import`. That's why it is absent from both the lint `ignores` array and the boundary
test's allowlist: neither rule has anything to exempt there, since the stub file contains no
import of the package it stands in for. jsdom has no canvas implementation, so a real chart.js
component floods test output with `Not implemented: getContext` noise; this stub exists so
chart.js-based component tests get a stable placeholder instead. It has no equivalent for Recharts
— Recharts renders real SVG under jsdom (D-04), so kit primitives are tested with real DOM
assertions, not a stub.

## The frame: `ChartCard`

`ChartCard` is the ONE title/caption/header-right/abstention frame every kit chart renders inside
— a thin composition over the existing `Card` family (`Card`/`CardHeader`/`CardTitle`/
`CardDescription`/`CardAction`/`CardContent`), not a new visual system. It introduces no card
variant, no new surface colour, no new spacing value.

| Slot            | Prop                                          | Content                                                                                                                                               |
| --------------- | --------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| Title           | `title`                                       | `CardTitle`                                                                                                                                           |
| Insight caption | `caption?`                                    | `CardDescription` — typically the evidence-type sentence (`shared.evidence.type.*`)                                                                   |
| Header-right    | `headerRight?`                                | `CardAction` — the sample-size cue, a ruleset control, a min-matches select, etc.                                                                     |
| Abstention      | `abstained?: { gamesNeeded: number } \| null` | When non-null, the body swaps to `shared.evidence.abstained` instead of rendering `children` — the chart never renders on a sample too thin to trust. |
| Body            | `children`                                    | The chart or comparison-bar content.                                                                                                                  |
| Footer          | `footer?`                                     | Rendered below `children` when not abstained (e.g. a click hint).                                                                                     |

## The vocabulary — five members, three implemented (D-05)

### Implemented this phase

**Trend-with-context** (`TrendLine.tsx`) — a single-series `LineChart` over a fixed domain, with a
custom tooltip carrying full row context. Props: `points: TrendChartPoint[]`, `onSelectPoint?`,
`width?`/`height?` (D-04: explicit numeric size for tests — jsdom's no-op `ResizeObserver` stub
plus a zero-size bounding rect make a `ResponsiveContainer` render measure 0×0, so every test
renders at an explicit size and only the runtime page omits `width` for the responsive wrapper),
`tooltip?` (defaults to `ChartTooltip`). `TrendChartPoint`/`TrendChartPointContext` are exported
from `TrendLine.tsx` itself (not a separate types file) — import the vocabulary from there.

**Comparison bars** — horizontal bars per stage/category (see `CounterpickAdvisor.tsx`'s Pick/Ban
rows), status-coloured (`emerald-500`/`600` vs `--destructive`, never `--chart-*`), value label at
the tip, unfilled track at ~15% opacity (the "meter" convention — state reads across the whole
bar, not just the filled portion).

**Sparkline / stat tile** — a `ChartCard` used as a compact `label`/`value`/`trend` tile rather
than a full chart body (see `MatchWinLossCard`'s promotion to a stat tile: `label` = "Record",
`value` = the Wins/Total/Losses row, `trend` = the existing `WinLossPips` component reused as the
sparkline-equivalent — no new sparkline mechanism was invented for this).

### NOT implemented this phase — Phase 41 owns these (D-05)

**Small-multiples grid** — a repeated small chart per category (e.g. one mini trend line per
stage), for comparing many series' shapes at a glance without overlaying them. Sketched API:

```ts
interface SmallMultiplesGridProps<T> {
  items: T[];
  getKey: (item: T) => string;
  getTitle: (item: T) => string;
  renderChart: (item: T) => ReactNode; // typically a TrendLine at a small fixed size
  columns?: number; // responsive default; explicit for tests
}
```

Expected data shape: one `TrendChartPoint[]`-shaped series per grid cell, each rendered through the
existing `TrendLine` primitive at a smaller fixed size — this is a LAYOUT/composition primitive
over the existing trend primitive, not a new chart type. Interaction: clicking a cell's chart
follows the same click-to-matches contract as the full-size trend chart.

**Matrix heat** — a 2D heatmap (e.g. stage × opponent), each cell shaded by a scalar (win rate,
sample size). Sketched API:

```ts
interface MatrixHeatCell {
  rowKey: string;
  colKey: string;
  value: number | null; // null renders the abstained/no-data cell treatment
  sampleCue?: ReactNode;
}

interface MatrixHeatProps {
  rows: string[];
  cols: string[];
  cells: MatrixHeatCell[];
  colorScale: (value: number) => string; // must resolve to a --chart-* or status token, never a raw hex
  onSelectCell?: (cell: MatrixHeatCell) => void;
}
```

Expected data shape: a dense `rows × cols` cell list (missing pairs render the no-data treatment,
never a blank gap). Interaction: click-to-matches, same contract as every other kit member.

## Tooltips and interaction (D-06, D-07)

**Every displayed tooltip field arrives PRE-RESOLVED on the point/cell object.** The chart layer
(`ChartTooltip.tsx`) resolves nothing itself — no alias lookup, no stage lookup, no arithmetic
beyond rounding a rate that was already computed upstream. The host component (e.g.
`MatchupChart.tsx`'s `buildTrendChartPoints`) is the single place that builds this context, from
the same match row the point represents. This is load-bearing: it's what keeps a rate from ever
rendering stripped of the game it came from.

`ChartTooltip` is typed against a narrow, all-optional local interface
(`{ active?; payload? }`), not Recharts' exported `TooltipContentProps` (whose `payload`/
`coordinate`/`accessibilityLayer`/`activeIndex` fields are non-optional — they describe what
Recharts computes internally before cloning the element via `content={<ChartTooltip />}`). Every
custom Recharts tooltip content component in this kit follows that same narrower shape.

**Click-to-matches is the drill-down mechanism for this phase** (D-07): clicking a chart
point/bar/cell sets in-page selection state that filters/highlights a table and scrolls to it — no
new URL/query contract exists yet. Phase 38 owns the URL-addressable drill-down contract; every kit
member built before then should follow the same in-page pattern `MatchupChart`/`MatchupsContext`
establishes rather than inventing its own.

**Click surface on Recharts charts:** bind the click handler on the chart CONTAINER (e.g.
`LineChart`'s `onClick`), not on an individual mark like `Line`'s `dot`. Recharts 3.10.1's
container-level click argument (`MouseHandlerDataParam`) has NO `activePayload` field — that's a
recharts-2-era field that doesn't exist on this version's type (verified against the installed
package's own `.d.ts`). Read the numeric `activeTooltipIndex` it does carry and index directly into
the same array passed as the chart's `data` prop to recover the clicked point — see
`TrendLine.tsx`'s `handleClick` for the pattern.
