import { z } from 'zod';

/**
 * `opponents/{uid}` is stored as a set-membership map: keys are lowercased
 * free-text opponent names, values are always the boolean literal `true`
 * (see AddMatchForm.js / EditMatchForm.js: `firebase.set(`/opponents/${uid}/${name}`,
 * true)`). There is no numeric id — the name itself is the identity.
 */
export const opponentMapSchema = z.record(z.string(), z.literal(true));
export type OpponentMap = z.infer<typeof opponentMapSchema>;

/** GET /api/opponents response: the flat list of known opponent names. */
export const opponentListSchema = z.array(z.string());
export type OpponentList = z.infer<typeof opponentListSchema>;
