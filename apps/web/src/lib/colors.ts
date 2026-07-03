/**
 * Deterministic color helper for chart slices, replacing legacy's
 * `jsgradient.generateGradient` (legacy/src/components/RandomColor/index.js).
 * Legacy generated a red-to-black gradient sized to the number of fighters
 * for FighterPieChart's slice colors on every render; ported here as a pure,
 * typed function so the same input always produces the same colors (no
 * "random" in the name or behavior — the legacy name was a misnomer, the
 * gradient itself was deterministic given its inputs).
 */

/** Parses a `#rgb` or `#rrggbb` hex color into an `[r, g, b]` triple (0-255 each). Falls back to white for malformed input, matching legacy's `hexToRgb`. */
function hexToRgb(hex: string): [number, number, number] {
  let cleaned = hex.replace('#', '');
  if (cleaned.length === 3) {
    cleaned = cleaned
      .split('')
      .map((c) => c + c)
      .join('');
  }
  if (cleaned.length !== 6) {
    return [255, 255, 255];
  }
  const r = parseInt(cleaned.slice(0, 2), 16);
  const g = parseInt(cleaned.slice(2, 4), 16);
  const b = parseInt(cleaned.slice(4, 6), 16);
  return [r, g, b];
}

function clampByte(value: number): number {
  return Math.max(0, Math.min(255, value));
}

function rgbToHex([r, g, b]: [number, number, number]): string {
  return [r, g, b].map((c) => clampByte(c).toString(16).padStart(2, '0')).join('');
}

/**
 * Generates `steps` hex colors (each `#rrggbb`) evenly spaced from `colorA`
 * to `colorB` inclusive, ports legacy `jsgradient.generateGradient`
 * behavior/output exactly for `steps >= 1`.
 */
export function generateGradient(colorA: string, colorB: string, steps: number): string[] {
  if (steps <= 0) {
    return [];
  }
  const a = hexToRgb(colorA);
  const b = hexToRgb(colorB);
  if (steps === 1) {
    return [`#${rgbToHex(a)}`];
  }

  const denominator = steps - 1;
  const rStep = Math.abs(a[0] - b[0]) / denominator;
  const gStep = Math.abs(a[1] - b[1]) / denominator;
  const bStep = Math.abs(a[2] - b[2]) / denominator;

  const result: string[] = [`#${rgbToHex(a)}`];
  let [rVal, gVal, bVal] = a;
  for (let i = 0; i < denominator - 1; i++) {
    rVal = a[0] < b[0] ? rVal + Math.round(rStep) : rVal - Math.round(rStep);
    gVal = a[1] < b[1] ? gVal + Math.round(gStep) : gVal - Math.round(gStep);
    bVal = a[2] < b[2] ? bVal + Math.round(bStep) : bVal - Math.round(bStep);
    result.push(`#${rgbToHex([rVal, gVal, bVal])}`);
  }
  result.push(`#${rgbToHex(b)}`);

  return result;
}
