import { z } from 'zod';

/**
 * Phase 30.3 (Gate 6 capture-evidence hardening, item 3): the API's own
 * deployment identity.
 *
 * WHY THIS EXISTS. The Gate-6 probe-capture operator drives a refused call
 * against a DEPLOYED API while snapshotting the RTDB configured in its OWN
 * local environment. Nothing bound the two. It sealed `databaseHost`, but
 * that value came from the same local `.env` as the snapshot, so it agreed
 * with itself by construction. An API with compatible Firebase Auth and
 * allowlists could therefore be paired with a DIFFERENT RTDB environment and
 * the probe would pass vacuously: the refusal would be real, the snapshots
 * would be real, and they would be about two different systems. The
 * independent verifier named this as the one axis the design left unproven.
 *
 * This endpoint is the missing half. It reports who the API is and which
 * database IT is talking to — as the API sees it, from the deployed process's
 * own environment, not as the operator's local environment sees it. The
 * operator compares the two and refuses to seal anything when they disagree.
 *
 * WHAT IS DELIBERATELY ABSENT. No credentials, tokens, secrets, allowlists,
 * or uids. Every member is either a public build/deploy coordinate or an
 * infrastructure hostname that is already published in the web client's
 * Firebase config. `databaseHost` is the URL's HOST only — never the full
 * `FIREBASE_DATABASE_URL`, which could in principle carry query credentials.
 */
export const DEPLOYMENT_IDENTITY_VERSION = 1;

export const deploymentIdentitySchema = z.object({
  /** Bumped when the MEANING of a member changes; a consumer must refuse an unknown version. */
  identityVersion: z.literal(DEPLOYMENT_IDENTITY_VERSION),
  /** `NODE_ENV`. The coarse environment claim an operator checks first. */
  environment: z.enum(['development', 'test', 'production']),
  /**
   * Cloud Run's `K_SERVICE`. Null off Cloud Run (local, emulator, any other
   * host) — an explicit "not applicable here", never a plausible-looking
   * placeholder.
   */
  service: z.string().min(1).nullable(),
  /**
   * Cloud Run's `K_REVISION` — an IMMUTABLE deployment coordinate. A revision
   * name is minted per deploy and never reused, which is what makes it usable
   * as the "is this the reviewed build?" check. Null off Cloud Run.
   */
  revision: z.string().min(1).nullable(),
  /**
   * The git SHA the image was built from, injected at BUILD time
   * (`API_RELEASE_SHA`). Null when the image was built without it — stated
   * plainly rather than defaulted to something that would look valid.
   */
  releaseSha: z.string().min(1).nullable(),
  /**
   * The GCP/Firebase project the API believes it is running against. Null
   * when the runtime does not publish one; the binding check that actually
   * carries weight is `databaseHost`, which is never null.
   */
  firebaseProjectId: z.string().min(1).nullable(),
  /** HOST of the API's own `FIREBASE_DATABASE_URL`. The load-bearing binding value. */
  databaseHost: z.string().min(1),
  /**
   * `FIREBASE_DATABASE_EMULATOR_HOST` when set. An API pointed at an emulator
   * is a different database environment from one pointed at the real
   * instance even when `databaseHost` matches, so this is part of the
   * identity rather than a footnote.
   */
  databaseEmulatorHost: z.string().min(1).nullable(),
});

export type DeploymentIdentity = z.infer<typeof deploymentIdentitySchema>;
