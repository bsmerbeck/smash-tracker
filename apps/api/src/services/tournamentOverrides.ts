import {
  RULESET_CONTRACT_VERSION,
  rulesetOverrideStoredSchema,
  TIER_OVERRIDE_CONTRACT_VERSION,
  tierOverrideStoredSchema,
  type RulesetOverrideStored,
  type TierOverrideStored,
} from '@smash-tracker/shared';

/**
 * The user-owned members of a `tournamentEntries/{uid}/{entryKey}` child:
 * the 39.2 `tierOverride` and the 37-04 `rulesetOverride`. Only the tier and
 * ruleset PATCH routes author them. Every whole-child writer (start.gg sync,
 * parry.gg sync, the research-registry reconcile) rebuilds the rest of the
 * row from provider data and must carry these two from the value stored AT
 * COMMIT TIME, inside the same per-entry transaction as the write (39.2 code
 * review API-CR-01 / API-WR-01): a value read before a long network phase, or
 * at plan time, would delete an override the user set in between, or bring
 * back one the user cleared.
 *
 * The ONE stored-override policy (API-WR-02), shared by every writer and by
 * `GET /tournaments`, per member:
 * - `valid` — the stored schema reads it (whatever its `contractVersion`; the
 *   resolver ignores and reports a newer one). Readers serve it; writers carry
 *   the RAW stored value byte-for-byte, so members a newer writer added are
 *   never stripped and reconcile never sees a perpetual difference.
 * - `future-contract` — unreadable, but stamped with a `contractVersion`
 *   newer than this build's contract (a rollback after a newer release wrote
 *   it). Readers treat it as absent; writers carry it byte-for-byte so a
 *   rollback never destroys it.
 * - `invalid` — anything else (a hand edit, a corrupt write). Readers treat
 *   it as absent; writers do not copy it forward (reported to the caller so
 *   it can log the drop — never the value).
 * Treating an unreadable override as absent keeps the EVENT readable: one bad
 * member must never hide the event, since the event page is where the user
 * replaces or clears the override.
 */
export const USER_OWNED_OVERRIDE_MEMBERS = ['tierOverride', 'rulesetOverride'] as const;
export type UserOwnedOverrideMember = (typeof USER_OWNED_OVERRIDE_MEMBERS)[number];

export type StoredOverrideStatus = 'absent' | 'valid' | 'future-contract' | 'invalid';

const OVERRIDE_CONTRACTS = {
  tierOverride: {
    schema: tierOverrideStoredSchema,
    contractVersion: TIER_OVERRIDE_CONTRACT_VERSION,
  },
  rulesetOverride: {
    schema: rulesetOverrideStoredSchema,
    contractVersion: RULESET_CONTRACT_VERSION,
  },
} as const;

/** Classifies one stored override member under the policy above. */
export function classifyStoredOverride(
  member: UserOwnedOverrideMember,
  value: unknown,
): StoredOverrideStatus {
  if (value === null || value === undefined) {
    return 'absent';
  }
  const contract = OVERRIDE_CONTRACTS[member];
  if (contract.schema.safeParse(value).success) {
    return 'valid';
  }
  if (typeof value === 'object' && !Array.isArray(value)) {
    const version = (value as Record<string, unknown>).contractVersion;
    if (
      typeof version === 'number' &&
      Number.isInteger(version) &&
      version > contract.contractVersion
    ) {
      return 'future-contract';
    }
  }
  return 'invalid';
}

/**
 * Carried values are the RAW stored bytes. A `future-contract` value does not
 * satisfy these v1 types; it is typed as one only so a writer can spread it
 * onto the row it commits — no code in this build reads it.
 */
export interface CarriedOverrides {
  tierOverride?: TierOverrideStored;
  rulesetOverride?: RulesetOverrideStored;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/**
 * The override members to carry from a stored child onto the row a writer is
 * about to commit: `valid` and `future-contract` members byte-for-byte,
 * `invalid` ones dropped and reported through `onDropped`. Conditional
 * members only — an absent override yields no key, never a null write. Each
 * member is judged on its own, so an unrelated defect elsewhere in the stored
 * row never costs the user their override.
 */
export function carriedOverrides(
  stored: unknown,
  onDropped?: (member: UserOwnedOverrideMember) => void,
): CarriedOverrides {
  const record = asRecord(stored);
  if (record === null) {
    return {};
  }
  const carried: Record<string, unknown> = {};
  for (const member of USER_OWNED_OVERRIDE_MEMBERS) {
    const status = classifyStoredOverride(member, record[member]);
    if (status === 'valid' || status === 'future-contract') {
      carried[member] = record[member];
    } else if (status === 'invalid') {
      onDropped?.(member);
    }
  }
  return carried as CarriedOverrides;
}

/**
 * The READER's half of the policy: a copy of a stored child with every
 * override member the stored schema cannot read (`future-contract` or
 * `invalid`) omitted, plus what was omitted and why, for a value-free log.
 * A non-object is returned unchanged (the row parse rejects it on its own).
 */
export function withoutUnreadableOverrides(stored: unknown): {
  row: unknown;
  omitted: Array<{ member: UserOwnedOverrideMember; status: StoredOverrideStatus }>;
} {
  const record = asRecord(stored);
  if (record === null) {
    return { row: stored, omitted: [] };
  }
  const row: Record<string, unknown> = { ...record };
  const omitted: Array<{ member: UserOwnedOverrideMember; status: StoredOverrideStatus }> = [];
  for (const member of USER_OWNED_OVERRIDE_MEMBERS) {
    const status = classifyStoredOverride(member, record[member]);
    if (status === 'future-contract' || status === 'invalid') {
      delete row[member];
      omitted.push({ member, status });
    }
  }
  return { row, omitted };
}

/**
 * A copy of `row` without either override member. Writers strip the members
 * from a row built off an earlier read before adding `carriedOverrides` of the
 * value stored now, so a plan-time or pre-network-phase override can never
 * ride along into the commit.
 */
export function withoutOverrides<T extends object>(row: T): Omit<T, UserOwnedOverrideMember> {
  const copy: Record<string, unknown> = { ...(row as Record<string, unknown>) };
  for (const member of USER_OWNED_OVERRIDE_MEMBERS) {
    delete copy[member];
  }
  return copy as Omit<T, UserOwnedOverrideMember>;
}
