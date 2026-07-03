import '@testing-library/jest-dom/vitest';

/**
 * jsdom doesn't implement ResizeObserver, but cmdk (used by the shadcn
 * Command component, e.g. AddMatchForm's opponent combobox) calls it on
 * mount. A minimal no-op stub is enough for tests — nothing here asserts on
 * actual resize behavior.
 */
if (typeof globalThis.ResizeObserver === 'undefined') {
  class ResizeObserverStub {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
  globalThis.ResizeObserver = ResizeObserverStub as unknown as typeof ResizeObserver;
}

/**
 * jsdom also doesn't implement `Element.scrollIntoView`, which cmdk calls
 * when navigating/selecting items in the Command list.
 */
if (typeof Element !== 'undefined' && !Element.prototype.scrollIntoView) {
  Element.prototype.scrollIntoView = () => {};
}

/**
 * jsdom doesn't implement the Pointer Capture API, which Radix UI's Select
 * (used throughout Matchups/MatchData/FighterAnalysis for fighter/stage
 * pickers) calls on pointer-down. Minimal no-op/false stubs are enough —
 * nothing here asserts on actual pointer capture behavior.
 */
if (typeof Element !== 'undefined' && !Element.prototype.hasPointerCapture) {
  Element.prototype.hasPointerCapture = () => false;
}
if (typeof Element !== 'undefined' && !Element.prototype.setPointerCapture) {
  Element.prototype.setPointerCapture = () => {};
}
if (typeof Element !== 'undefined' && !Element.prototype.releasePointerCapture) {
  Element.prototype.releasePointerCapture = () => {};
}
