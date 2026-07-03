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
