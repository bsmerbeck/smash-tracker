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
 * - `.transaction(updateFn)` emulates the real SDK's null-local-cache first
 *   run (review CR-01): `updateFn` is ALWAYS invoked with `null` first —
 *   exactly what a listener-less server process sees even when server data
 *   exists. Returning `undefined` on that first run aborts PERMANENTLY (no
 *   retry with server data — the real SDK's documented behavior); returning
 *   a value triggers the hash-compare: it commits directly when the stored
 *   node is truly empty, otherwise `updateFn` re-runs with the real stored
 *   value. Mirrors the real `{ committed, snapshot }` result either way.
 *   Without this emulation, an update function that aborts on a null/empty
 *   node passes every test here and 404s on every call in production.
 * - `.set()` drops any key (at any depth) whose value is an empty array,
 *   matching real RTDB's documented empty-array-drop-on-write behavior
 *   (see RtdbService's `getStageFavorites`/tags comments).
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

/**
 * Recursively drops any object key whose value is an empty array, mirroring
 * real RTDB's behavior of never persisting empty-array values on write.
 * Arrays themselves are left intact (RTDB arrays hold sparse/dense element
 * lists, not keys to strip); only nested object keys are inspected.
 */
function stripEmptyArrays(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(stripEmptyArrays);
  }
  if (value !== null && typeof value === 'object') {
    const result: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
      if (Array.isArray(val) && val.length === 0) {
        continue;
      }
      result[key] = stripEmptyArrays(val);
    }
    return result;
  }
  return value;
}

export class FakeDatabase {
  private root: Record<string, JsonValue> = {};

  /**
   * `ref()` (no argument) is the root, matching firebase-admin's
   * `Database.ref()` for multi-path root updates. An *explicit* empty string
   * is rejected exactly as real firebase-admin does — `database.ref('')`
   * throws "path argument was an invalid path" there, so accepting it here
   * would let a prod-only 500 pass the test suite (it did: all group
   * mutations used `ref('')` and only 500'd in production). The same
   * prod-parity rule applies to firebase-admin's illegal path characters
   * (`.`, `#`, `$`, `[`, `]`), which the real SDK rejects with a synchronous
   * throw — without replicating that here, a user-controlled URL param
   * interpolated into a ref path (e.g. a crafted share token like
   * `foo.bar`) 500s only in production while every test stays green.
   */
  ref(path?: string): FakeReference {
    if (path === '') {
      throw new Error(
        'path argument was an invalid path = "". Paths must be non-empty strings and can\'t contain ".", "#", "$", "[", or "]". Use ref() with no argument for the root.',
      );
    }
    // eslint-disable-next-line no-control-regex -- mirrors firebase-admin INVALID_PATH_REGEX (controls + DEL are path-illegal)
    if (path !== undefined && /[.#$[\]\u0000-\u001f\u007f]/.test(path)) {
      throw new Error(
        `path argument was an invalid path = "${path}". Paths must be non-empty strings and can't contain ".", "#", "$", "[", or "]".`,
      );
    }
    const segments = (path ?? '').split('/').filter(Boolean);
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
      this.root = stripEmptyArrays(value ?? {}) as Record<string, JsonValue>;
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
    node[segments[segments.length - 1]!] = stripEmptyArrays(value) as JsonValue;
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
        // Real-RTDB emulation (review CR-01): the FIRST run always sees the
        // SDK's local cache — `null` on a listener-less server process, even
        // when server data exists. Aborting (undefined) here is FINAL: the
        // real SDK never retries an aborted transaction with server data.
        const firstRun = updateFn(null);
        if (firstRun === undefined) {
          return { committed: false, snapshot: makeSnapshot(current) };
        }
        if (current === null) {
          // Local guess matched the server (node truly empty): the first
          // run's return value commits directly.
          this.setAtPath(segments, firstRun);
          return { committed: true, snapshot: makeSnapshot(this.getAtPath(segments)) };
        }
        // Hash mismatch: re-run the update function with the REAL stored
        // value — the retry path a correct update function must survive.
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
