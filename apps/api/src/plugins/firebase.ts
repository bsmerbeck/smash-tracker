import fp from 'fastify-plugin';
import type { FastifyInstance } from 'fastify';
import type { FirebaseServices } from '../firebase/admin.js';

declare module 'fastify' {
  interface FastifyInstance {
    firebase: FirebaseServices;
  }
}

/**
 * Decorates the Fastify instance with the initialized firebase-admin
 * services (auth + database) so routes/plugins can access them via
 * `app.firebase`.
 */
export default fp(async function firebasePlugin(app: FastifyInstance, opts: FirebaseServices) {
  app.decorate('firebase', opts);
});
