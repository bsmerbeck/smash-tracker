import { buildApp } from './app.js';
import { getReportsConfig, getStartggConfig, loadEnv, parseCorsOrigins } from './config/env.js';
import { initFirebase } from './firebase/admin.js';

let env;
try {
  env = loadEnv();
} catch (err) {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
}

const firebase = initFirebase(env);

const app = buildApp({
  firebase,
  corsOrigin: parseCorsOrigins(env.CORS_ORIGIN),
  startgg: getStartggConfig(env),
  reports: getReportsConfig(env),
});

app
  .listen({ port: env.PORT, host: env.HOST })
  .then(() => {
    app.log.info(`API listening on http://${env.HOST}:${env.PORT}`);
  })
  .catch((err) => {
    app.log.error(err);
    process.exit(1);
  });
