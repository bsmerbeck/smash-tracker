import fp from 'fastify-plugin';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

declare module 'fastify' {
  interface FastifyInstance {
    authenticate: (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
  }
  interface FastifyRequest {
    uid: string;
    userEmail: string;
  }
}

const BEARER_PREFIX = 'Bearer ';

/**
 * Decorates the app with an `authenticate` hook that verifies the
 * `Authorization: Bearer <idToken>` header via firebase-admin's
 * `auth().verifyIdToken`, attaching `request.uid` on success. Routes opt in
 * by adding `{ preHandler: app.authenticate }`. Responds 401 on any missing
 * header, malformed header, or verification failure — no details about the
 * failure reason are leaked to the client.
 */
export default fp(async function authPlugin(app: FastifyInstance) {
  app.decorate('authenticate', async (request: FastifyRequest, reply: FastifyReply) => {
    const header = request.headers.authorization;

    if (!header || !header.startsWith(BEARER_PREFIX)) {
      return reply.code(401).send({
        error: 'Unauthorized',
        message: 'Missing or malformed Authorization header',
        statusCode: 401,
      });
    }

    const idToken = header.slice(BEARER_PREFIX.length).trim();

    if (!idToken) {
      return reply.code(401).send({
        error: 'Unauthorized',
        message: 'Missing bearer token',
        statusCode: 401,
      });
    }

    try {
      const decoded = await app.firebase.auth.verifyIdToken(idToken);
      if (!decoded.email) {
        return reply.code(401).send({
          error: 'Unauthorized',
          message: 'Token does not contain a verified email address',
          statusCode: 401,
        });
      }
      request.uid = decoded.uid;
      request.userEmail = decoded.email;
    } catch {
      return reply.code(401).send({
        error: 'Unauthorized',
        message: 'Invalid or expired token',
        statusCode: 401,
      });
    }
  });
});
