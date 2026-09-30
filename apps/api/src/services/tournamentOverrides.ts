import {
  rulesetOverrideStoredSchema,
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
 */
export const USER_OWNED_OVERRIDE_MEMBERS = ['tierOverride', 'rulesetOverride'] as const;
export type UserOwnedOverrideMember = (typeof USER_OWNED_OVERRIDE_MEMBERS)[number];

export interface CarriedOverrides {
  tierOverride?: TierOverrideStored;
  rulesetOverride?: RulesetOverrideStored;
}

/**
 * The override members to carry from a stored child onto the row a writer is
 * about to commit. Conditional members only — an absent override yields no
 * key, never a null write. Each member is validated on its own, so an
 * unrelated defect elsewhere in the stored row never costs the user their
 * override.
 */
export function carriedOverrides(stored: unknown): CarriedOverrides {
  if (stored === null || typeof stored !== 'object' || Array.isArray(stored)) {
    return {};
  }
  const record = stored as Record<string, unknown>;
  const tier = tierOverrideStoredSchema.safeParse(record.tierOverride);
  const ruleset = rulesetOverrideStoredSchema.safeParse(record.rulesetOverride);
  return {
    ...(tier.success ? { tierOverride: tier.data } : {}),
    ...(ruleset.success ? { rulesetOverride: ruleset.data } : {}),
  };
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
