import { buildApp } from './app.js';
import {
  getClaimCodeConfig,
  getGa4Config,
  getInternalJobsConfig,
  getParryggConfig,
  getPrepPaidConfig,
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
const claimCode = getClaimCodeConfig(env);
const prepPaid = getPrepPaidConfig(env);

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
  claimCode,
  prepPaid,
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

// Phase 23 (Claim Credential & Atomic Ownership Transition): a single
// startup-time notice — never per-request — when the claim-code HMAC secret
// isn't configured. This is an operator-visible signal so a misconfigured
// deployment is obvious in Cloud Run logs rather than only discoverable when
// a coach's first issuance 503s.
if (!claimCode) {
  app.log.warn(
    'Claim codes are not configured (CLAIM_CODE_HMAC_SECRET unset); claim issuance and redemption will answer 503',
  );
}

// Phase 27 (Contextual Paid Prep Reports Behind the Activation Gate,
// RPT-04): a single startup-time notice — never per-request — while the
// paid-prep activation gate is off. This is expected in production until
// the owner flips PREP_PAID_REPORTS_ENABLED after the soak review passes;
// the notice exists so that state is obvious in Cloud Run logs rather than
// only discoverable from a 503 on the first paid prep submission.
if (!prepPaid) {
  app.log.warn(
    'Paid prep reports are not enabled (PREP_PAID_REPORTS_ENABLED unset); paid prep placements will render nothing and paid prep endpoints will answer 503',
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
