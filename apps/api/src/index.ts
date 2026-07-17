import { buildApp } from './app.js';
import {
  getGa4Config,
  getParryggConfig,
  getReportsConfig,
  getStartggConfig,
  getStripeConfig,
  loadEnv,
  parseCorsOrigins,
} from './config/env.js';
import { initFirebase } from './firebase/admin.js';

let env;
try {
  env = loadEnv();
} catch (err) {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
}

const firebase = initFirebase(env);
const ga4 = getGa4Config(env);

const app = buildApp({
  firebase,
  corsOrigin: parseCorsOrigins(env.CORS_ORIGIN),
  startgg: getStartggConfig(env),
  reports: getReportsConfig(env),
  stripe: getStripeConfig(env),
  parrygg: getParryggConfig(env),
  webBaseUrl: env.WEB_BASE_URL,
  ga4,
});

// Phase 7 (Recap Cards & Share-Loop Analytics): a single startup-time notice
// when GA4 Measurement Protocol isn't configured — never a per-request log
// (Pitfall 5). `review_shared` then silently no-ops on every share-create
// until GA4_MEASUREMENT_ID/GA4_API_SECRET are set (USER-COURT deploy item).
if (!ga4) {
  app.log.warn(
    'GA4 Measurement Protocol not configured (GA4_MEASUREMENT_ID/GA4_API_SECRET unset); review_shared events will not be sent',
  );
}

app
  .listen({ port: env.PORT, host: env.HOST })
  .then(() => {
    app.log.info(`API listening on http://${env.HOST}:${env.PORT}`);
  })
  .catch((err) => {
    app.log.error(err);
    process.exit(1);
  });
