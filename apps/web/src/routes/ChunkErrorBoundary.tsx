import { Component, type ErrorInfo, type ReactNode } from 'react';
import { withTranslation, type WithTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';

interface ChunkErrorBoundaryState {
  hasError: boolean;
}

/**
 * P1 2026-08-12: the app had no error boundary at all, so a lazy chunk that
 * exhausted retryableLazy's retries (and the reload cooldown) threw straight
 * into render and React unmounted the entire root — a permanently blank
 * page. This boundary sits around the router's Suspense and turns that
 * terminal failure into a message with a Retry button. A class component
 * because error boundaries still require getDerivedStateFromError;
 * withTranslation because hooks are unavailable in classes.
 */
class ChunkErrorBoundaryBase extends Component<
  WithTranslation & { children: ReactNode },
  ChunkErrorBoundaryState
> {
  state: ChunkErrorBoundaryState = { hasError: false };

  static getDerivedStateFromError(): ChunkErrorBoundaryState {
    return { hasError: true };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error('Route render failed', error, info.componentStack);
  }

  render(): ReactNode {
    if (!this.state.hasError) {
      return this.props.children;
    }
    const { t } = this.props;
    return (
      <div className="flex min-h-svh flex-col items-center justify-center gap-4 px-4 text-center">
        <p className="text-sm text-muted-foreground">{t('chrome.chunkLoadError')}</p>
        <Button variant="outline" onClick={() => window.location.reload()}>
          {t('chrome.retry')}
        </Button>
      </div>
    );
  }
}

export const ChunkErrorBoundary = withTranslation()(ChunkErrorBoundaryBase);
