import '@testing-library/jest-dom/vitest';
import { configure } from '@testing-library/react';
// i18n initialized with the bundled English resources (V15): components use
// t() but every existing English text assertion keeps working — jsdom has no
// navigator language worth detecting, and localStorage starts empty, so
// tests always run under the 'en' fallback.
import '@/i18n';

// GitHub Actions runners are ~3x slower than dev hardware; heavy chart pages
// (GspPage) can take >1s to paint async data, so testing-library's 1s default
// for findBy*/waitFor flakes there. 5s stays well under vitest's 15s test cap.
configure({ asyncUtilTimeout: 5_000 });

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
