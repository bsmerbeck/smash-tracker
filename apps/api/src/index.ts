import { buildApp } from './app.js';
import {
  getGa4Config,
  getInternalJobsConfig,
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
const internalJobs = getInternalJobsConfig(env);

const app = buildApp({
  firebase,
  corsOrigin: parseCorsOrigins(env.CORS_ORIGIN),
  startgg: getStartggConfig(env),
  reports: getReportsConfig(env),
  stripe: getStripeConfig(env),
  parrygg: getParryggConfig(env),
  webBaseUrl: env.WEB_BASE_URL,
  ga4,
  internalJobs,
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

// Phase 10 (Canonical Measurement & Money Safety): a single startup-time
// notice — never per-request — when /internal/jobs/* has no shared secret
// configured. The scope itself already answers 503 for every path in that
// case (internalJobs.ts); this is purely an operator-visible signal so a
// misconfigured deployment is obvious in Cloud Run logs rather than only
// discoverable when Cloud Scheduler's first invocation 503s.
if (!internalJobs) {
  app.log.warn(
    'Internal jobs are not configured (INTERNAL_JOBS_SECRET unset); /internal/jobs/* will answer 503',
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
