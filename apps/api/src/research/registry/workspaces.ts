import { z } from 'zod';

/**
 * Phase 30.3 registry-operator hardening: the four ordinary demo workspaces
 * the tournament-registry backfill targets, hoisted out of the operator
 * script so that anything else which has to speak the same language — the
 * receipt schema in this directory, and any external audit tool — can import
 * them WITHOUT importing an owner-only CLI (and the firebase-admin
 * composition root behind it).
 *
 * The frozen Phase 30.1 research tenants are deliberately absent: they are
 * not workspaces this projector may ever target.
 */

export const registryWorkspaceKeys = ['hbox', 'mkleo', 'sparg0', 'izaw'] as const;
export type RegistryWorkspaceKey = (typeof registryWorkspaceKeys)[number];

export const registryWorkspaceKeySchema = z.enum(registryWorkspaceKeys);

/** Destination uid per workspace. All four are always supplied together, so the uniqueness cross-check can run. */
export type RegistryUidMap = Record<RegistryWorkspaceKey, string>;

/** Display labels — the tracked player behind each demo account. */
export const registryWorkspaceLabels: Record<RegistryWorkspaceKey, string> = {
  hbox: 'Hungrybox',
  mkleo: 'MkLeo',
  sparg0: 'Sparg0',
  izaw: 'IzAw',
};

/** Narrows an arbitrary string to a workspace key, or `null` when it names none. */
export function asRegistryWorkspaceKey(value: string): RegistryWorkspaceKey | null {
  return (registryWorkspaceKeys as readonly string[]).includes(value)
    ? (value as RegistryWorkspaceKey)
    : null;
}
