import type { ReactNode } from 'react';

export interface InsightCardErrorBoundaryProps {
  templateId: string;
  onError: (templateId: string) => void;
  children: ReactNode;
}

// RED stub (#3770): not an error boundary yet — types compile so the named
// target test fails on a real assertion, not a module-resolution error.
// GREEN implements the real class component next.
export function InsightCardErrorBoundary(props: InsightCardErrorBoundaryProps) {
  return props.children;
}
