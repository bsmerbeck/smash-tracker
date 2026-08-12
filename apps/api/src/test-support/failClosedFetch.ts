/**
 * Phase 30.2 Plan 02 (ENR-11, cycle-1 review HIGH 4): a GLOBAL fail-closed
 * `fetch` stub, installed into every API test file through vitest's
 * `setupFiles`, that makes the no-network guarantee structural rather than
 * conventional.
 *
 * The defect this closes: a static scan of outbound targets necessarily
 * permits the real Liquipedia endpoint constant — declaring that constant is
 * the entire point of the scan — so a test that forgot to inject a fixture
 * fetch implementation would reach the live host and still pass CI, quietly
 * breaking both ENR-11's offline requirement and the owner's locked access
 * contract. Once this module's install function has run, any call to
 * `globalThis.fetch` that a test did not explicitly stub REJECTS immediately
 * with an error naming the attempted URL and method — a red test, never a
 * hang and never a quiet empty response.
 *
 * What this module does not do: it has no reach into a socket opened by a
 * transport other than the global `fetch` (a raw `net.connect`, a gRPC-Web
 * channel, and so on). That is precisely why the static outbound-target scan
 * from plan 12 stays in place as a second, independent layer rather than
 * being replaced by this one.
 *
 * This module intentionally offers no way to turn the check off, add an
 * exception for a given host, or let a specific request continue through to
 * the network — a lock a caller can switch back off mid-file is not a lock.
 * A test that legitimately needs an outbound call must supply its own
 * `fetchImpl` at the call site under test, where a reader can see exactly
 * what is being stubbed and why.
 */

export class UnstubbedNetworkAccessError extends Error {
  constructor(url: string, method: string) {
    super(
      `Unstubbed network access: ${method} ${url} — inject an explicit fetch ` +
        'implementation for this call.',
    );
    this.name = 'UnstubbedNetworkAccessError';
  }
}

function readMethod(input: Parameters<typeof fetch>[0], init?: RequestInit): string {
  if (init?.method) {
    return init.method;
  }
  if (typeof input === 'object' && input !== null && !(input instanceof URL) && 'method' in input) {
    return (input as Request).method;
  }
  return 'GET';
}

function readUrl(input: Parameters<typeof fetch>[0]): string {
  if (typeof input === 'string') {
    return input;
  }
  if (input instanceof URL) {
    return input.toString();
  }
  return (input as Request).url;
}

/**
 * Replaces `globalThis.fetch` with a function that always rejects with
 * {@link UnstubbedNetworkAccessError}. Call once, from a vitest `setupFiles`
 * entry, before any test runs.
 */
export function installFailClosedFetch(): void {
  globalThis.fetch = (async (
    input: Parameters<typeof fetch>[0],
    init?: RequestInit,
  ): Promise<Response> => {
    throw new UnstubbedNetworkAccessError(readUrl(input), readMethod(input, init));
  }) as unknown as typeof fetch;
}
