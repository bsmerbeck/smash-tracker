import { Component, type ReactNode } from 'react';

export interface InsightCardErrorBoundaryProps {
  /** The card's stable identifier — the ONLY thing named in the log line. */
  templateId: string;
  onError: (templateId: string) => void;
  children: ReactNode;
}

interface InsightCardErrorBoundaryState {
  hasError: boolean;
}

/**
 * A per-card error boundary (UI-SPEC §9.5, T-39.1-07-01/04): one broken
 * engine read is removed from the rail, never the whole page. Renders
 * `null` for its own slot on catch and calls `onError(templateId)` so the
 * rail can promote the next candidate — a crash is not a user preference,
 * so this NEVER calls a dismiss callback.
 *
 * The log line is composed from a fixed prefix plus `templateId` only. The
 * thrown error's own message is never interpolated into it — an engine
 * error's text can carry an opponent tag or an event name — and the error
 * object itself is logged separately, only in development.
 */
export class InsightCardErrorBoundary extends Component<
  InsightCardErrorBoundaryProps,
  InsightCardErrorBoundaryState
> {
  state: InsightCardErrorBoundaryState = { hasError: false };

  static getDerivedStateFromError(): InsightCardErrorBoundaryState {
    return { hasError: true };
  }

  componentDidCatch(error: Error): void {
    this.props.onError(this.props.templateId);
    console.error(`InsightCard render failed for template "${this.props.templateId}"`);
    if (process.env.NODE_ENV === 'development') {
      console.error(error);
    }
  }

  render(): ReactNode {
    if (this.state.hasError) {
      return null;
    }
    return this.props.children;
  }
}
