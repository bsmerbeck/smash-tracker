/**
 * Minimal in-memory stand-in for firebase-admin's Realtime Database client,
 * covering exactly the operations RtdbService relies on: ref(path).get(),
 * .set(), .update(), .remove(), .push(). No network, no emulator.
 *
 * Semantics mirror real RTDB closely enough for our purposes:
 * - Paths are `/`-delimited; intermediate segments are plain nested objects.
 * - `.set(null)` (or removing the last child) deletes the node.
 * - `.push()` generates a unique string key and returns a ref-like object
 *   whose `.key` is available synchronously (as real RTDB's push() does).
 * - `DataSnapshot.exists()`/`val()` reflect the current in-memory tree.
 * - `.transaction(updateFn)` runs synchronously against the in-memory tree
 *   (there's no concurrent access in tests, so every attempt "wins" on the
 *   first try) and mirrors the real SDK's `{ committed, snapshot }` result —
 *   `updateFn` returning `undefined` aborts the transaction without writing,
 *   matching real RTDB semantics.
 */

type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

export interface FakeSnapshot {
  exists(): boolean;
  val(): unknown;
}

export interface FakeTransactionResult {
  committed: boolean;
  snapshot: FakeSnapshot;
}

export interface FakeReference {
  key: string | null;
  get(): Promise<FakeSnapshot>;
  set(value: unknown): Promise<void>;
  update(value: Record<string, unknown>): Promise<void>;
  remove(): Promise<void>;
  push(value?: unknown): FakeReference & { key: string };
  transaction(updateFn: (current: unknown) => unknown): Promise<FakeTransactionResult>;
}

function makeSnapshot(value: unknown): FakeSnapshot {
  return {
    exists: () => value !== null && value !== undefined,
    val: () => (value === undefined ? null : value),
  };
}

let pushCounter = 0;
function generateKey(): string {
  pushCounter += 1;
  return `-fakeKey${pushCounter.toString().padStart(6, '0')}`;
}

export class FakeDatabase {
  private root: Record<string, JsonValue> = {};

  /** `path` defaults to the root, matching firebase-admin's `Database.ref()` (used for multi-path root updates). */
  ref(path = ''): FakeReference {
    const segments = path.split('/').filter(Boolean);
    return this.refForSegments(segments);
  }

  /** Test helper: seed data directly without going through set(). */
  seed(path: string, value: unknown): void {
    this.setAtPath(path.split('/').filter(Boolean), value);
  }

  /** Test helper: read the raw tree for assertions. */
  dump(): Record<string, JsonValue> {
    return this.root;
  }

  private getAtPath(segments: string[]): unknown {
    let node: unknown = this.root;
    for (const segment of segments) {
      if (node === null || typeof node !== 'object') {
        return null;
      }
      node = (node as Record<string, unknown>)[segment];
      if (node === undefined) {
        return null;
      }
    }
    return node ?? null;
  }

  private setAtPath(segments: string[], value: unknown): void {
    if (segments.length === 0) {
      this.root = (value ?? {}) as Record<string, JsonValue>;
      return;
    }

    if (value === null || value === undefined) {
      this.deleteAtPath(segments);
      return;
    }

    let node: Record<string, unknown> = this.root;
    for (let i = 0; i < segments.length - 1; i += 1) {
      const segment = segments[i]!;
      const next = node[segment];
      if (next === null || typeof next !== 'object') {
        node[segment] = {};
      }
      node = node[segment] as Record<string, unknown>;
    }
    node[segments[segments.length - 1]!] = value as JsonValue;
  }

  private deleteAtPath(segments: string[]): void {
    if (segments.length === 0) {
      this.root = {};
      return;
    }

    let node: Record<string, unknown> = this.root;
    for (let i = 0; i < segments.length - 1; i += 1) {
      const segment = segments[i]!;
      const next = node[segment];
      if (next === null || typeof next !== 'object') {
        return;
      }
      node = next as Record<string, unknown>;
    }
    delete node[segments[segments.length - 1]!];
  }

  private updateAtPath(segments: string[], values: Record<string, unknown>): void {
    for (const [key, value] of Object.entries(values)) {
      this.setAtPath([...segments, ...key.split('/').filter(Boolean)], value);
    }
  }

  private refForSegments(segments: string[]): FakeReference {
    const key = segments.length > 0 ? segments[segments.length - 1]! : null;

    const ref: FakeReference = {
      key,
      get: async () => makeSnapshot(this.getAtPath(segments)),
      set: async (value: unknown) => {
        this.setAtPath(segments, value);
      },
      update: async (values: Record<string, unknown>) => {
        this.updateAtPath(segments, values);
      },
      remove: async () => {
        this.deleteAtPath(segments);
      },
      push: (value?: unknown) => {
        const childKey = generateKey();
        const childRef = this.refForSegments([...segments, childKey]) as FakeReference & {
          key: string;
        };
        if (value !== undefined) {
          void childRef.set(value);
        }
        return childRef;
      },
      transaction: async (updateFn: (current: unknown) => unknown) => {
        const current = this.getAtPath(segments);
        const next = updateFn(current);
        if (next === undefined) {
          return { committed: false, snapshot: makeSnapshot(current) };
        }
        this.setAtPath(segments, next);
        return { committed: true, snapshot: makeSnapshot(this.getAtPath(segments)) };
      },
    };

    return ref;
  }
}
