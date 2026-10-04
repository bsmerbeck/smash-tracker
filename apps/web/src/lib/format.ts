/**
 * The one sanctioned number / date formatting path for the Phase 41 chart hosts and the I18N-01
 * sweep (DD-41-15). Every function takes the locale as an explicit parameter — never a global, never
 * the OS default — so a reader on the app language `de` sees German grouping, month names and date
 * order wherever a figure is printed. The committed I18N-01 guard (plan 41-08) forbids a bare
 * locale-less `toLocale*` / `Intl.*` call outside this module, which is why this module exists.
 *
 * Eager-bundle hygiene: this module imports nothing (not `@smash-tracker/shared`, not React) because
 * `lib/` helpers that are reachable from eager modules are converted to call it.
 *
 * `Intl` formatter construction is far costlier than `format()`, so each formatter is cached per
 * (kind, locale, options) — the `timeAxisTicks.ts` shape. A module-level cache is fine in `apps/web`
 * (the no-module-state rule applies only to `packages/shared`).
 */

/** U+2212 — the typographic minus. `Intl`'s `signDisplay` emits the hyphen-minus U+002D instead. */
const MINUS_SIGN = '−';

/** The compact figure's default fraction digits (`9.5M`) when no tick step says otherwise. */
const COMPACT_DEFAULT_FRACTION_DIGITS = 1;

/** Fraction digits tried when deriving a compact figure's precision from a step (`10.005M` needs 3). */
const COMPACT_MAX_FRACTION_DIGITS = 6;

/** A decimal count is exact when `value * 10^digits` is this close to a whole number. */
const DECIMAL_EXACT_EPSILON = 1e-9;

const numberFormatterCache = new Map<string, Intl.NumberFormat>();
const dateFormatterCache = new Map<string, Intl.DateTimeFormat>();

function cachedNumberFormatter(
  kind: string,
  locale: string,
  options: Intl.NumberFormatOptions,
): Intl.NumberFormat {
  const cacheKey = `${kind}|${locale}|${JSON.stringify(options)}`;
  let formatter = numberFormatterCache.get(cacheKey);
  if (!formatter) {
    formatter = new Intl.NumberFormat(locale, options);
    numberFormatterCache.set(cacheKey, formatter);
  }
  return formatter;
}

function cachedDateFormatter(
  kind: string,
  locale: string,
  options: Intl.DateTimeFormatOptions,
): Intl.DateTimeFormat {
  const cacheKey = `${kind}|${locale}|${JSON.stringify(options)}`;
  let formatter = dateFormatterCache.get(cacheKey);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat(locale, options);
    dateFormatterCache.set(cacheKey, formatter);
  }
  return formatter;
}

const DEFAULT_DATE_OPTIONS: Intl.DateTimeFormatOptions = {
  year: 'numeric',
  month: 'numeric',
  day: 'numeric',
};

/** A whole number with the locale's digit grouping (`10,880,284` en, `10.880.284` de). */
export function formatGrouped(n: number, locale: string): string {
  return cachedNumberFormatter('grouped', locale, { maximumFractionDigits: 0 }).format(n);
}

/**
 * The value of one displayed unit of `n`'s compact figure (`1e6` for `9.5M`, `1e4` for ja `950万`),
 * read from the locale's own compact parts so no unit table is hardcoded.
 */
function compactUnitOf(n: number, locale: string): number {
  const magnitude = Math.abs(n);
  if (magnitude === 0) return 1;
  const parts = cachedNumberFormatter('compactParts', locale, {
    notation: 'compact',
    maximumFractionDigits: COMPACT_MAX_FRACTION_DIGITS,
  }).formatToParts(magnitude);
  const integer = parts.find((part) => part.type === 'integer')?.value ?? '';
  const fraction = parts.find((part) => part.type === 'fraction')?.value ?? '';
  const shown = Number(`${integer.replace(/\D/g, '')}.${fraction.replace(/\D/g, '') || '0'}`);
  if (!Number.isFinite(shown) || shown <= 0) return 1;
  return 10 ** Math.round(Math.log10(magnitude / shown));
}

/** The decimals `step` has when written in `unit`s (`250,000` in millions: 0.25, so 2). */
function stepFractionDigits(step: number, unit: number): number {
  const inUnits = Math.abs(step) / unit;
  for (let digits = 0; digits < COMPACT_MAX_FRACTION_DIGITS; digits += 1) {
    const scaled = inUnits * 10 ** digits;
    if (Math.abs(scaled - Math.round(scaled)) < DECIMAL_EXACT_EPSILON) return digits;
  }
  return COMPACT_MAX_FRACTION_DIGITS;
}

/**
 * A compact figure (`9.5M` en, `9,5 Mio.` de, `950万` ja). `stepHint` is the tick step the figure sits
 * on: ticks are multiples of it, so the fraction digits are the step's own decimals in the figure's
 * unit (a 250,000 step prints `9.25M`, a 20,000 step `10.02M`, a 5,000 step `10.005M`). Adjacent ticks
 * therefore never collapse to one label, and no tick is rounded away from its value. With no hint a
 * figure carries one fraction digit.
 */
export function formatCompact(n: number, locale: string, options?: { stepHint?: number }): string {
  const stepHint = options?.stepHint;
  const maximumFractionDigits =
    stepHint !== undefined && Number.isFinite(stepHint) && stepHint > 0
      ? stepFractionDigits(stepHint, compactUnitOf(n, locale))
      : COMPACT_DEFAULT_FRACTION_DIGITS;
  return cachedNumberFormatter('compact', locale, {
    notation: 'compact',
    maximumFractionDigits,
  }).format(n);
}

/** A signed grouped figure: `+1,234`, `−5` (typographic minus), `0` for zero. */
export function formatSigned(n: number, locale: string): string {
  if (n === 0) return formatGrouped(0, locale);
  const sign = n > 0 ? '+' : MINUS_SIGN;
  return `${sign}${formatGrouped(Math.abs(n), locale)}`;
}

/** A calendar date in the locale's order, in the host time zone like the `toLocaleDateString` it replaces. */
export function formatDate(
  ms: number,
  locale: string,
  options: Intl.DateTimeFormatOptions = DEFAULT_DATE_OPTIONS,
): string {
  return cachedDateFormatter('date', locale, options).format(ms);
}

function isSameLocalDay(aMs: number, bMs: number): boolean {
  const a = new Date(aMs);
  const b = new Date(bMs);
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  );
}

/** One date when both ends fall on the same (host-zone) calendar day, otherwise the locale's range form. */
export function formatDaySpan(fromMs: number, toMs: number, locale: string): string {
  if (isSameLocalDay(fromMs, toMs)) return formatDate(fromMs, locale);
  return cachedDateFormatter('daySpan', locale, DEFAULT_DATE_OPTIONS).formatRange(fromMs, toMs);
}

/**
 * The locale's name for a month (1-12). Built from a UTC date and formatted in UTC so the host time
 * zone can never shift the month.
 */
export function formatMonthName(
  month1to12: number,
  locale: string,
  style: 'short' | 'long',
): string {
  return cachedDateFormatter('month', locale, { month: style, timeZone: 'UTC' }).format(
    Date.UTC(2000, month1to12 - 1, 15),
  );
}
