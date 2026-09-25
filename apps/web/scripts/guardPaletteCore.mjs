/**
 * Palette-validation PURE core (Phase 39.1 Plan 10, UIX-05, UI-SPEC §13.6):
 * the CSS-parsing + colour-math logic, separated from the thin
 * read-the-real-file runner in `guardPalette.mjs` — the same "pure core plus
 * a thin runner" split `guardLayoutCore.mjs`/`guardLayout.mjs` (plan 39.1-09)
 * and `scl01BrowserBudgetCore.mjs`/`scl01BrowserBudget.mjs` already use.
 *
 * The colour math (OKLab/OKLCH conversion, the Machado-Oliveira-Fernandes
 * 2009 CVD simulation matrices, WCAG relative luminance/contrast) is PORTED
 * — not imported — from the dataviz skill's `validate_palette.js` reference
 * implementation, the same "ported, doc-commented, named source" discipline
 * `packages/shared/src/insight/periodSeries.ts`'s `EVENT_SESSION_PROXIMITY_MS`
 * already establishes in this codebase: the skill's script is not a
 * repository dependency, so its formulas are reproduced here directly rather
 * than imported. The forward OKLCH→sRGB conversion (needed to resolve this
 * project's `oklch(...)` CSS literals to hex before validating them) is the
 * standard Björn Ottosson reference matrix — the algebraic inverse of the
 * skill script's own sRGB→OKLab conversion.
 *
 * Every `check*` function takes already-resolved hex values and returns a
 * LIST of violations, never a boolean and never only the first violation —
 * matching `guardLayoutCore.mjs`'s "report every offender" discipline.
 */

// -- thresholds (ported from the dataviz skill's validate_palette.js) ----------

/** OKLCH L band per mode — this app is dark-only, so `guardPalette.mjs` always validates with `mode: 'dark'`. */
export const LIGHTNESS_BAND = { light: [0.43, 0.77], dark: [0.48, 0.67] };
/** OKLCH C floor — below it a hue reads as gray and stops doing identity work. */
export const CHROMA_FLOOR = 0.1;
/** WCAG contrast ratio floor for a mark against the chart surface. */
export const CONTRAST_MIN = 3.0;
/** OKLab ΔE×100 (Euclidean distance), min(protan, deutan), adjacent/named pairs. Below this floor is a hard FAIL — the 6-8 "WARN" band UI-SPEC §13.6 documents is not modelled here because none of this palette's three named pairs land in it (recorded in the plan SUMMARY from a real run). */
export const CVD_FLOOR = 6.0;

/**
 * Visualization tokens intentionally EXEMPT from the lightness-band and
 * chroma-floor checks — UI-SPEC §4.1 and the kit README both document these
 * as deliberately achromatic/neutral ink, not categorical identity or status
 * marks: `--viz-context`/`--viz-context-strong` are baselines/tracks/grid
 * (never an identity series), and `--steady` is the flat/no-direction glyph
 * colour (`var(--muted-foreground)`, chroma 0 by design). Running the
 * categorical checks on them would fail a correct, intentional palette —
 * exactly the "don't fix a good ramp to satisfy the wrong check" trap the
 * dataviz skill's own `color-formula.md` warns about for non-categorical ink.
 */
export const CHROMA_AND_LIGHTNESS_EXEMPT = ['viz-context', 'viz-context-strong', 'steady'];

/**
 * `--viz-context-strong` is UI-SPEC §4.1's one documented exception to the
 * 3:1 contrast floor (2.40:1, explicitly "decorative" — it is never the only
 * carrier of a value, per the token's own role description).
 */
export const CONTRAST_EXEMPT = ['viz-context-strong'];

/** UI-SPEC §13.6's three named CVD-separation pairs, checked against the card surface. */
export const CVD_PAIRS = [
  ['viz-series-1', 'viz-series-2'],
  ['viz-series-1', 'loss'],
  ['win', 'loss'],
];

/** The seven visualization tokens `guardPalette.mjs` resolves and validates — every one of `parseTokenHexes`'s inputs, by name (no leading `--`). */
export const TOKEN_NAMES = [
  'viz-series-1',
  'viz-series-2',
  'viz-context',
  'viz-context-strong',
  'win',
  'loss',
  'steady',
];

/** The card surface custom property name (no leading `--`) every contrast/CVD check validates against. */
export const CARD_SURFACE_NAME = 'card';

// Machado, Oliveira & Fernandes (2009) CVD transforms at severity 1.0 (linear RGB) — ported verbatim from the dataviz skill's validate_palette.js.
const MACHADO = {
  protan: [
    [0.152286, 1.052583, -0.204868],
    [0.114503, 0.786281, 0.099216],
    [-0.003882, -0.048116, 1.051998],
  ],
  deutan: [
    [0.367322, 0.860646, -0.227968],
    [0.280085, 0.672501, 0.047413],
    [-0.01182, 0.04294, 0.968881],
  ],
};

// -- colour conversions (ported from the dataviz skill's validate_palette.js) --

function hexToSrgb(hex) {
  const h = hex.trim().replace(/^#/, '');
  return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16) / 255);
}

function toHexByte(component) {
  const clamped = Math.max(0, Math.min(1, component));
  return Math.round(clamped * 255)
    .toString(16)
    .padStart(2, '0');
}

const s2lin = (c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
const lin2s = (c) => {
  const clamped = Math.max(0, Math.min(1, c));
  return clamped <= 0.0031308 ? 12.92 * clamped : 1.055 * clamped ** (1 / 2.4) - 0.055;
};
const linFromHex = (hex) => hexToSrgb(hex).map(s2lin);
const relLuminance = (hex) => {
  const [r, g, b] = linFromHex(hex);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};

/** WCAG contrast ratio between two hex colours (exported for `checkContrastOnSurface`'s consumers and for direct reuse, mirroring the skill script's own exported `contrast`). */
export function contrastRatio(hexA, hexB) {
  const [hi, lo] = [relLuminance(hexA), relLuminance(hexB)].sort((a, b) => b - a);
  return (hi + 0.05) / (lo + 0.05);
}

function oklabFromLin([r, g, b]) {
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  return [
    0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
  ];
}

function oklabFromHex(hex) {
  return oklabFromLin(linFromHex(hex));
}

/** `[L, C]` in OKLCH for a hex colour. */
export function oklch(hex) {
  const [L, a, b] = oklabFromHex(hex);
  return [L, Math.hypot(a, b)];
}

/**
 * Forward OKLCH(L, C, H-degrees)→sRGB hex — the algebraic inverse of
 * `oklabFromLin`/`oklch` above (Björn Ottosson's reference matrices). Needed
 * because this project's `index.css` declares several tokens as raw
 * `oklch(L C H)` literals (e.g. `--chart-4`, `--destructive`) rather than
 * hex — `parseTokenHexes` must resolve those to hex before any check below
 * can run.
 */
export function oklchToHex(L, C, hueDegrees) {
  const hRad = (hueDegrees * Math.PI) / 180;
  const a = C * Math.cos(hRad);
  const b = C * Math.sin(hRad);
  const l_ = L + 0.3963377774 * a + 0.2158037573 * b;
  const m_ = L - 0.1055613458 * a - 0.0638541728 * b;
  const s_ = L - 0.0894841775 * a - 1.291485548 * b;
  const l = l_ ** 3;
  const m = m_ ** 3;
  const s = s_ ** 3;
  const rLin = 4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s;
  const gLin = -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s;
  const bLin = -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s;
  return `#${toHexByte(lin2s(rLin))}${toHexByte(lin2s(gLin))}${toHexByte(lin2s(bLin))}`;
}

function simulate(hex, kind) {
  const [r, g, b] = linFromHex(hex);
  const M = MACHADO[kind];
  const clamp = (c) => Math.max(0, Math.min(1, c));
  return [
    clamp(M[0][0] * r + M[0][1] * g + M[0][2] * b),
    clamp(M[1][0] * r + M[1][1] * g + M[1][2] * b),
    clamp(M[2][0] * r + M[2][1] * g + M[2][2] * b),
  ];
}

/** OKLab ΔE×100 between two hex colours, optionally under a Machado CVD simulation ('protan' | 'deutan'). No `kind` = unsimulated (normal) vision. */
export function deltaE(hexA, hexB, kind) {
  const a = oklabFromLin(kind ? simulate(hexA, kind) : linFromHex(hexA));
  const b = oklabFromLin(kind ? simulate(hexB, kind) : linFromHex(hexB));
  return 100 * Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
}

// -- CSS parsing ----------------------------------------------------------------

/** Finds the FIRST top-level `selector { ... }` block's body in `cssSource` via brace counting (values may contain parens, e.g. `oklch(...)`/`var(...)`, but never braces in this stylesheet). */
function extractBlockBody(cssSource, selector) {
  const openBraceSearch = new RegExp(`${selector.replace(/[.[\]]/g, '\\$&')}\\s*\\{`);
  const match = openBraceSearch.exec(cssSource);
  if (!match) {
    return null;
  }
  const bodyStart = match.index + match[0].length;
  let depth = 1;
  let i = bodyStart;
  for (; i < cssSource.length && depth > 0; i++) {
    if (cssSource[i] === '{') depth++;
    else if (cssSource[i] === '}') depth--;
  }
  return cssSource.slice(bodyStart, i - 1);
}

/** `{ name (no leading `--`) -> raw declared value }` for every `--custom-property: value;` in a block body. */
function extractCustomProperties(blockBody) {
  const values = new Map();
  const declRegex = /--([a-zA-Z0-9-]+)\s*:\s*([^;]+);/g;
  let m;
  while ((m = declRegex.exec(blockBody))) {
    values.set(m[1], m[2].trim());
  }
  return values;
}

function resolveTokenValue(name, rawValues, seen) {
  if (seen.has(name)) {
    return { error: `--${name}: circular var() reference (${[...seen, name].join(' -> ')})` };
  }
  const nextSeen = new Set(seen).add(name);
  const raw = rawValues.get(name);
  if (raw === undefined) {
    return { error: `--${name} is not declared in :root` };
  }
  const varMatch = /^var\(\s*--([a-zA-Z0-9-]+)\s*\)$/.exec(raw);
  if (varMatch) {
    return resolveTokenValue(varMatch[1], rawValues, nextSeen);
  }
  const hexMatch = /^#([0-9a-fA-F]{6})$/.exec(raw);
  if (hexMatch) {
    return { hex: `#${hexMatch[1].toLowerCase()}` };
  }
  const oklchMatch = /^oklch\(\s*([\d.]+)\s+([\d.]+)\s+([\d.]+)\s*\)$/.exec(raw);
  if (oklchMatch) {
    const [, L, C, H] = oklchMatch;
    return { hex: oklchToHex(Number(L), Number(C), Number(H)) };
  }
  return { error: `--${name} has an unrecognized value shape for the palette oracle: "${raw}"` };
}

/**
 * Resolves each of `tokenNames` to a hex value by reading `cssSource`'s
 * `:root` block DIRECTLY (never a copied table) — `guardPalette.mjs`'s whole
 * anti-repudiation contract (T-39.1-10-01) rests on this function reading
 * the real file. A token the stylesheet does not declare — or whose value
 * this parser cannot resolve (an unrecognized shape, a dangling `var()`) —
 * is reported as `{ missing: true, error }`, never silently skipped, so
 * moving a declaration to an earlier wave (or a future value-shape change)
 * cannot quietly shrink the oracle's scope.
 */
export function parseTokenHexes(cssSource, tokenNames) {
  const rootBody = extractBlockBody(cssSource, ':root');
  const rawValues = extractCustomProperties(rootBody ?? '');
  const result = {};
  for (const name of tokenNames) {
    const resolved = resolveTokenValue(name, rawValues, new Set());
    result[name] = resolved.hex !== undefined ? { hex: resolved.hex } : { missing: true, error: resolved.error };
  }
  return result;
}

// -- checks -----------------------------------------------------------------

function resolvedEntries(tokenHexes, exempt) {
  return Object.entries(tokenHexes).filter(([name, entry]) => !exempt.includes(name) && !entry.missing);
}

/** UI-SPEC §13.6: every resolved, non-exempt token's OKLCH lightness must sit inside the dark band. */
export function checkLightnessBand(tokenHexes, { exempt = CHROMA_AND_LIGHTNESS_EXEMPT } = {}) {
  const [lo, hi] = LIGHTNESS_BAND.dark;
  const violations = [];
  for (const [name, entry] of resolvedEntries(tokenHexes, exempt)) {
    const [L] = oklch(entry.hex);
    if (L < lo || L > hi) {
      violations.push({ check: 'lightness-band', token: name, hex: entry.hex, lightness: L, band: [lo, hi] });
    }
  }
  return violations;
}

/** UI-SPEC §13.6: every resolved, non-exempt token's OKLCH chroma must clear the floor (below it a hue reads as gray). */
export function checkChromaFloor(tokenHexes, { exempt = CHROMA_AND_LIGHTNESS_EXEMPT } = {}) {
  const violations = [];
  for (const [name, entry] of resolvedEntries(tokenHexes, exempt)) {
    const [, C] = oklch(entry.hex);
    if (C < CHROMA_FLOOR) {
      violations.push({ check: 'chroma-floor', token: name, hex: entry.hex, chroma: C, floor: CHROMA_FLOOR });
    }
  }
  return violations;
}

/** UI-SPEC §13.6: every resolved, non-exempt token must clear 3:1 WCAG contrast against the card surface. */
export function checkContrastOnSurface(tokenHexes, surfaceHex, { exempt = CONTRAST_EXEMPT } = {}) {
  const violations = [];
  for (const [name, entry] of resolvedEntries(tokenHexes, exempt)) {
    const ratio = contrastRatio(entry.hex, surfaceHex);
    if (ratio < CONTRAST_MIN) {
      violations.push({ check: 'contrast-on-surface', token: name, hex: entry.hex, ratio, floor: CONTRAST_MIN });
    }
  }
  return violations;
}

/**
 * UI-SPEC §13.6: for each named pair, the worst of the protan/deutan
 * simulated OKLab ΔE must clear `CVD_FLOOR` — a pair below the floor is a
 * hard FAIL (§13.6's "Failing case: `emerald-500` in place of `--win`" is a
 * `checkLightnessBand` failure, not this check's named case; this check's
 * own load-bearing property is proven directly on the real `{win, loss}`
 * pair moving below the floor in `guardPaletteCore.test.mjs`).
 */
export function checkColourVisionSeparation(tokenHexes, pairs = CVD_PAIRS, { floor = CVD_FLOOR } = {}) {
  const violations = [];
  for (const [nameA, nameB] of pairs) {
    const a = tokenHexes[nameA];
    const b = tokenHexes[nameB];
    if (!a || !b || a.missing || b.missing) {
      violations.push({ check: 'colour-vision-separation', pair: [nameA, nameB], error: 'a token in this pair is missing/unresolved' });
      continue;
    }
    const protan = deltaE(a.hex, b.hex, 'protan');
    const deutan = deltaE(a.hex, b.hex, 'deutan');
    const worst = Math.min(protan, deutan);
    if (worst < floor) {
      violations.push({
        check: 'colour-vision-separation',
        pair: [nameA, nameB],
        worstDeltaE: worst,
        protan,
        deutan,
        floor,
      });
    }
  }
  return violations;
}
