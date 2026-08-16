/**
 * Phase 30.3 registry-operator hardening: per-operation deadlines for the
 * registry projector's RTDB calls.
 *
 * The enrichment operator learned this the hard way at the network layer —
 * an unbounded request is indistinguishable from a hung process. RTDB reads
 * and transactions have exactly the same property: `ref().get()` against an
 * unreachable database simply never settles, and the operator would sit
 * there looking healthy.
 *
 * Every awaited RTDB call in `reconcile.ts` therefore goes through
 * `withRegistryDeadline`, which bounds it by `--request-timeout-ms`
 * (default 30s at the CLI) and by the operator's shutdown/stall signal.
 *
 * Honest limitation, stated rather than papered over: firebase-admin's
 * promises are not cancellable, so a timed-out call keeps running in the
 * background. The deadline unblocks the OPERATOR (which then fails, writes
 * its receipt, and exits nonzero); the lifecycle wrapper's unref'd
 * hard-exit backstop is what guarantees the process itself still dies on
 * time. The timer here is unref'd for the same reason — a pending deadline
 * must never be the thing keeping the event loop alive.
 */

export const DEFAULT_REGISTRY_REQUEST_TIMEOUT_MS = 30_000;

export interface RegistryDeadlineOptions {
  /** Per-operation ceiling in ms. Omitted or `0` disables the timeout (the signal still applies). */
  requestTimeoutMs?: number;
  /** Shutdown/stall signal. An abort rejects the wait immediately. */
  signal?: AbortSignal;
}

export class RegistryOperationTimeoutError extends Error {
  constructor(
    readonly label: string,
    readonly timeoutMs: number,
  ) {
    super(`registry operation "${label}" exceeded its ${timeoutMs}ms request timeout`);
    this.name = 'RegistryOperationTimeoutError';
  }
}

export class RegistryOperationAbortedError extends Error {
  constructor(
    readonly label: string,
    reason: unknown,
  ) {
    const detail = reason instanceof Error ? reason.message : String(reason ?? 'aborted');
    super(`registry operation "${label}" aborted: ${detail}`);
    this.name = 'RegistryOperationAbortedError';
  }
}

/**
 * Runs `operation` bounded by the request timeout and the abort signal.
 * Rejects with `RegistryOperationTimeoutError` / `RegistryOperationAbortedError`
 * so the operator can attribute the failure precisely in its receipt.
 */
export async function withRegistryDeadline<T>(
  label: string,
  operation: () => Promise<T>,
  options: RegistryDeadlineOptions = {},
): Promise<T> {
  const { requestTimeoutMs, signal } = options;
  if (signal?.aborted) {
    // Fail before issuing the call at all: an interrupted operator must stop
    // starting new work, not merely stop waiting on it.
    throw new RegistryOperationAbortedError(label, signal.reason);
  }
  const work = operation();
  if ((requestTimeoutMs == null || requestTimeoutMs <= 0) && signal == null) {
    return work;
  }

  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;
  const guard = new Promise<never>((_resolve, reject) => {
    if (requestTimeoutMs != null && requestTimeoutMs > 0) {
      timer = setTimeout(() => {
        reject(new RegistryOperationTimeoutError(label, requestTimeoutMs));
      }, requestTimeoutMs);
      timer.unref?.();
    }
    if (signal) {
      onAbort = () => reject(new RegistryOperationAbortedError(label, signal.reason));
      signal.addEventListener('abort', onAbort, { once: true });
    }
  });
  // The losing side of the race is never awaited again; pre-attach a swallow
  // handler so a late rejection can never surface as an unhandled rejection.
  void work.catch(() => undefined);

  try {
    return await Promise.race([work, guard]);
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
    if (onAbort && signal) {
      signal.removeEventListener('abort', onAbort);
    }
  }
}
