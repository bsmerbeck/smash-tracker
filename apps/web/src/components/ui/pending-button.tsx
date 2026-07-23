import * as React from 'react';
import { useEffect, useRef, useState } from 'react';
import { Loader2 } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';

/** Delay before the in-button spinner appears — avoids flicker on near-instant saves (UXFB-01). */
export const SPINNER_DELAY_MS = 400;
/** Delay before the optional sonner "still working" toast fires for genuinely long operations. */
export const TOAST_DELAY_MS = 2000;

export interface PendingButtonProps extends React.ComponentProps<typeof Button> {
  /** Whether the operation this button triggers is currently in flight (e.g. `mutation.isPending`). */
  pending: boolean;
  /**
   * When provided, a `toast.loading` fires if `pending` is still true after
   * `TOAST_DELAY_MS` (~2s) — for the rare save that's genuinely slow, not
   * just the common near-instant case. Omit to never show a toast.
   */
  pendingToastLabel?: string;
}

/**
 * Shared submit-button primitive (UXFB-01): wraps the existing `Button` (never
 * forked) and adds a single processing-state pattern every long-running save
 * in the app should use instead of a per-site inline `Loader2`/`isPending`
 * JSX. Disables the instant `pending` flips true (no delay on the disable),
 * but only shows the `Loader2` spinner once `pending` has held for
 * `SPINNER_DELAY_MS` — so a near-instant save never flickers a spinner in and
 * back out. When `pendingToastLabel` is set and `pending` is still true after
 * `TOAST_DELAY_MS`, a `sonner` `toast.loading` fires once; it's dismissed the
 * moment `pending` clears (or the component unmounts).
 */
export function PendingButton({
  pending,
  pendingToastLabel,
  disabled,
  children,
  ...props
}: PendingButtonProps) {
  const [showSpinner, setShowSpinner] = useState(false);
  const toastIdRef = useRef<string | null>(null);
  if (toastIdRef.current === null) {
    toastIdRef.current = crypto.randomUUID();
  }

  useEffect(() => {
    if (!pending) {
      setShowSpinner(false);
      return;
    }
    const timer = setTimeout(() => setShowSpinner(true), SPINNER_DELAY_MS);
    return () => clearTimeout(timer);
  }, [pending]);

  useEffect(() => {
    if (!pending || !pendingToastLabel) {
      return;
    }
    const id = toastIdRef.current!;
    const timer = setTimeout(() => {
      toast.loading(pendingToastLabel, { id });
    }, TOAST_DELAY_MS);
    return () => {
      clearTimeout(timer);
      toast.dismiss(id);
    };
  }, [pending, pendingToastLabel]);

  return (
    <Button disabled={disabled || pending} {...props}>
      {showSpinner && <Loader2 className="animate-spin" aria-hidden="true" />}
      {children}
    </Button>
  );
}
