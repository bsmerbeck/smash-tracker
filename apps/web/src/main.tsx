import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App.tsx';
import './i18n';
import './index.css';
import { isReloadOnCooldown, stampReload } from '@/lib/retryableLazy';

// P1 2026-08-12: signals the inline boot watchdog in index.html that the
// entry module graph finished loading — the watchdog covers the window
// where a static chunk hangs and no bundled code can run at all.
declare global {
  interface Window {
    __appBooted?: boolean;
  }
}
window.__appBooted = true;

// Deploy-skew recovery: when a lazy chunk's dependency preload 404s (an old
// tab requesting hashes replaced by a new deploy), reload to pick up the
// fresh HTML and module graph. Shares the reload-cooldown stamp with
// retryableLazy and the index.html watchdog so the recovery paths can never
// ping-pong reloads: at most one automatic reload per cooldown window,
// deliberately never cleared on success.
window.addEventListener('vite:preloadError', (event) => {
  if (!isReloadOnCooldown()) {
    stampReload();
    event.preventDefault();
    window.location.reload();
  }
});

const rootElement = document.getElementById('root');
if (!rootElement) {
  throw new Error('Root element #root not found');
}

createRoot(rootElement).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
