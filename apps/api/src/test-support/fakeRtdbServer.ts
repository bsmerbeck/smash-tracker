import { createHash } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo, Socket } from 'node:net';

/**
 * Code review R7-IN-06 (iteration 7): a fake of the Realtime Database
 * WebSocket wire protocol (v5), just enough to drive the REAL `firebase-admin`
 * SDK — its transactions, sets, updates, listens and gets — through the
 * connection faults the in-memory fakes (`fakeDatabase.ts`) cannot model:
 *
 * - a transaction's first run sees earlier OPTIMISTIC local writes, because
 *   the real client applies a pending write to its local state before the
 *   server acknowledges it;
 * - a transaction that was SENT is aborted with `disconnect` when the socket
 *   drops, while a plain `set` or `update` is re-sent on reconnect.
 *
 * Ported from the iteration-7 reviewer's probe (`scratchpad/r7/fakeRtdb.mts`).
 * The server hash-compares a transaction put the way the real server does
 * (the SDK's own node hash, no priorities), pushes data to listeners, and can
 * swallow chosen writes or drop every socket. It speaks RFC 6455 framing
 * itself on `node:http`, so it needs no WebSocket dependency. Test-only: it
 * lives under `test-support/`, which the build excludes.
 *
 * Point the SDK at it with `FIREBASE_DATABASE_EMULATOR_HOST=127.0.0.1:<port>`
 * before `getDatabase()`.
 */

type Json = unknown;
type JsonObject = Record<string, unknown>;

/** The kind of a client write, as the wire names it. */
export type WireWriteKind = 'tx' | 'put' | 'merge';

export interface FakeRtdbServer {
  readonly port: number;
  /** Every write the server saw, in order, for a failing test's message. */
  readonly log: string[];
  /**
   * When it returns true for a write, the server swallows it: no reply and no
   * state change (an unacknowledged write, or a stalled connection).
   */
  hold: ((kind: WireWriteKind, path: string, data: Json) => boolean) | null;
  /** Called before every write the server applies — a competing writer in another process can land here. */
  beforeWrite: ((kind: WireWriteKind, path: string, data: Json) => void) | null;
  /** A direct server-side write (another process), pushed to listeners. */
  serverSet(path: string, value: Json): void;
  /** Destroys every open client socket; the SDK sees a disconnect and reconnects. */
  dropAll(): void;
  /** The server's value at `path` (null when absent). */
  get(path: string): Json;
  close(): Promise<void>;
}

const WEBSOCKET_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

function segments(path: string): string[] {
  return path.split('/').filter((segment) => segment.length > 0);
}

function isObject(value: Json): value is JsonObject {
  return value !== null && typeof value === 'object';
}

/** The value at `path` in `root`, or null. */
function valueAt(root: Json, path: string): Json {
  let node = root;
  for (const segment of segments(path)) {
    if (!isObject(node) || !(segment in node)) {
      return null;
    }
    node = node[segment];
  }
  return node ?? null;
}

/** Drops nulls and empty objects, as RTDB stores nothing for them. */
function pruned(value: Json): Json {
  if (!isObject(value)) {
    return value;
  }
  const out: JsonObject = {};
  for (const [key, child] of Object.entries(value)) {
    const kept = pruned(child);
    if (
      kept !== null &&
      kept !== undefined &&
      !(isObject(kept) && Object.keys(kept).length === 0)
    ) {
      out[key] = kept;
    }
  }
  return Object.keys(out).length > 0 ? out : null;
}

function ieeeHex(value: number): string {
  const buffer = Buffer.alloc(8);
  buffer.writeDoubleBE(value);
  return buffer.toString('hex');
}

function sha1Base64(text: string): string {
  return createHash('sha1').update(Buffer.from(text, 'utf8')).digest('base64');
}

/** RTDB's child-key order: 32-bit integer keys first (numerically), then strings. */
function keyCompare(a: string, b: string): number {
  const asInt = (key: string): number | null =>
    /^(0|-?[1-9]\d{0,9})$/.test(key) && Math.abs(Number(key)) <= 2147483647 ? Number(key) : null;
  const ai = asInt(a);
  const bi = asInt(b);
  if (ai !== null && bi !== null) {
    return ai - bi === 0 ? a.length - b.length : ai - bi;
  }
  if (ai !== null) {
    return -1;
  }
  if (bi !== null) {
    return 1;
  }
  return a < b ? -1 : a > b ? 1 : 0;
}

/** The SDK's node hash (`LeafNode`/`ChildrenNode.hash`, no priorities), so a transaction's compare behaves as on the real server. */
export function nodeHash(value: Json): string {
  if (value === null || value === undefined) {
    return '';
  }
  if (!isObject(value)) {
    const type = typeof value;
    return sha1Base64(`${type}:${type === 'number' ? ieeeHex(value as number) : String(value)}`);
  }
  let toHash = '';
  for (const key of Object.keys(value).sort(keyCompare)) {
    const childHash = nodeHash(value[key]);
    if (childHash !== '') {
      toHash += `:${key}:${childHash}`;
    }
  }
  return toHash === '' ? '' : sha1Base64(toHash);
}

/** One server-side WebSocket connection, framed by hand (RFC 6455: masked client frames, unmasked server frames). */
class WireSocket {
  private buffer = Buffer.alloc(0);
  private fragments: Buffer[] = [];
  onText: (text: string) => void = () => {};

  constructor(readonly socket: Socket) {
    socket.on('data', (chunk: Buffer) => this.feed(chunk));
    socket.on('error', () => {
      // A dropped or reset socket is the point of several tests.
    });
  }

  get open(): boolean {
    return !this.socket.destroyed && this.socket.writable;
  }

  sendText(text: string): void {
    if (!this.open) {
      return;
    }
    const payload = Buffer.from(text, 'utf8');
    let header: Buffer;
    if (payload.length < 126) {
      header = Buffer.from([0x81, payload.length]);
    } else if (payload.length < 65536) {
      header = Buffer.alloc(4);
      header[0] = 0x81;
      header[1] = 126;
      header.writeUInt16BE(payload.length, 2);
    } else {
      header = Buffer.alloc(10);
      header[0] = 0x81;
      header[1] = 127;
      header.writeBigUInt64BE(BigInt(payload.length), 2);
    }
    this.socket.write(Buffer.concat([header, payload]));
  }

  /** Consumes raw bytes from the client (the socket's data, or the upgrade's leftover head). */
  feed(chunk: Buffer): void {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    this.drain();
  }

  private sendControl(opcode: number, payload: Buffer): void {
    if (this.open) {
      this.socket.write(Buffer.concat([Buffer.from([0x80 | opcode, payload.length]), payload]));
    }
  }

  private drain(): void {
    for (;;) {
      if (this.buffer.length < 2) {
        return;
      }
      const first = this.buffer[0]!;
      const second = this.buffer[1]!;
      const fin = (first & 0x80) !== 0;
      const opcode = first & 0x0f;
      const masked = (second & 0x80) !== 0;
      let length = second & 0x7f;
      let offset = 2;
      if (length === 126) {
        if (this.buffer.length < 4) {
          return;
        }
        length = this.buffer.readUInt16BE(2);
        offset = 4;
      } else if (length === 127) {
        if (this.buffer.length < 10) {
          return;
        }
        length = Number(this.buffer.readBigUInt64BE(2));
        offset = 10;
      }
      const maskLength = masked ? 4 : 0;
      if (this.buffer.length < offset + maskLength + length) {
        return;
      }
      const mask = masked ? this.buffer.subarray(offset, offset + 4) : null;
      const payload = Buffer.from(
        this.buffer.subarray(offset + maskLength, offset + maskLength + length),
      );
      if (mask) {
        for (let index = 0; index < payload.length; index += 1) {
          payload[index] = payload[index]! ^ mask[index % 4]!;
        }
      }
      this.buffer = this.buffer.subarray(offset + maskLength + length);
      if (opcode === 0x8) {
        this.sendControl(0x8, Buffer.alloc(0));
        this.socket.end();
        return;
      }
      if (opcode === 0x9) {
        this.sendControl(0xa, payload);
        continue;
      }
      if (opcode === 0x1 || opcode === 0x0) {
        this.fragments.push(payload);
        if (fin) {
          const text = Buffer.concat(this.fragments).toString('utf8');
          this.fragments = [];
          this.onText(text);
        }
      }
    }
  }
}

/** Starts a fake RTDB wire server seeded with `seed` on an ephemeral local port. */
export async function startFakeRtdbServer(seed: Json = {}): Promise<FakeRtdbServer> {
  const root: { value: Json } = { value: pruned(seed) ?? {} };
  const sockets = new Set<WireSocket>();
  const listens = new Map<WireSocket, Set<string>>();

  const setAt = (path: string, value: Json): void => {
    const parts = segments(path);
    if (parts.length === 0) {
      root.value = pruned(value) ?? {};
      return;
    }
    if (!isObject(root.value)) {
      root.value = {};
    }
    let node = root.value as JsonObject;
    for (const part of parts.slice(0, -1)) {
      if (!isObject(node[part])) {
        node[part] = {};
      }
      node = node[part] as JsonObject;
    }
    const leaf = parts[parts.length - 1]!;
    const kept = pruned(value);
    if (kept === null || kept === undefined) {
      delete node[leaf];
    } else {
      node[leaf] = kept;
    }
    root.value = pruned(root.value) ?? {};
  };

  const overlaps = (a: string, b: string): boolean => {
    const x = segments(a);
    const y = segments(b);
    for (let index = 0; index < Math.min(x.length, y.length); index += 1) {
      if (x[index] !== y[index]) {
        return false;
      }
    }
    return true;
  };

  const notify = (written: string): void => {
    for (const [socket, paths] of listens) {
      for (const listened of paths) {
        if (overlaps(listened, written)) {
          socket.sendText(
            JSON.stringify({
              t: 'd',
              d: { a: 'd', b: { p: listened, d: valueAt(root.value, listened) } },
            }),
          );
        }
      }
    }
  };

  const log: string[] = [];
  let port = 0;

  const fake: FakeRtdbServer = {
    get port() {
      return port;
    },
    log,
    hold: null,
    beforeWrite: null,
    serverSet(path, value) {
      setAt(path, value);
      notify(path);
    },
    dropAll() {
      for (const socket of sockets) {
        socket.socket.destroy();
      }
      sockets.clear();
      listens.clear();
    },
    get(path) {
      return valueAt(root.value, path);
    },
    close() {
      fake.dropAll();
      return new Promise((resolve) => server.close(() => resolve()));
    },
  };

  const handleMessage = (socket: WireSocket, message: JsonObject): void => {
    if (message.t !== 'd' || !isObject(message.d)) {
      return;
    }
    const { r, a, b } = message.d as { r?: number; a?: string; b?: JsonObject };
    const ok = (data: Json = {}): void =>
      socket.sendText(JSON.stringify({ t: 'd', d: { r, b: { s: 'ok', d: data } } }));
    const body = b ?? {};
    const path = typeof body.p === 'string' ? body.p : '/';
    switch (a) {
      case 'q':
        listens.get(socket)?.add(path);
        socket.sendText(
          JSON.stringify({ t: 'd', d: { a: 'd', b: { p: path, d: valueAt(root.value, path) } } }),
        );
        ok({});
        return;
      case 'n':
        listens.get(socket)?.delete(path);
        ok({});
        return;
      case 'g':
        ok(valueAt(root.value, path));
        return;
      case 'p': {
        const kind: WireWriteKind = 'h' in body ? 'tx' : 'put';
        if (fake.hold?.(kind, path, body.d)) {
          log.push(`HELD ${kind} ${path} ${JSON.stringify(body.d)}`);
          return;
        }
        fake.beforeWrite?.(kind, path, body.d);
        if (kind === 'tx' && body.h !== nodeHash(valueAt(root.value, path))) {
          log.push(`tx ${path} DATASTALE (client guessed ${JSON.stringify(body.d)})`);
          socket.sendText(JSON.stringify({ t: 'd', d: { r, b: { s: 'datastale', d: 'stale' } } }));
          return;
        }
        log.push(`${kind} ${path} ${JSON.stringify(body.d)}`);
        setAt(path, body.d);
        ok();
        notify(path);
        return;
      }
      case 'm': {
        if (fake.hold?.('merge', path, body.d)) {
          log.push(`HELD merge ${path} ${JSON.stringify(body.d)}`);
          return;
        }
        fake.beforeWrite?.('merge', path, body.d);
        log.push(`merge ${path} ${JSON.stringify(body.d)}`);
        const children = isObject(body.d) ? body.d : {};
        for (const [key, value] of Object.entries(children)) {
          setAt(`${path}/${key}`, value);
        }
        ok();
        for (const key of Object.keys(children)) {
          notify(`${path}/${key}`);
        }
        return;
      }
      default:
        // auth, stats, onDisconnect and the rest: acknowledged, no effect.
        ok();
    }
  };

  const server: Server = createServer((_request, response) => {
    response.writeHead(404);
    response.end();
  });
  server.on('upgrade', (request, rawSocket: Socket, head: Buffer) => {
    const key = request.headers['sec-websocket-key'];
    if (typeof key !== 'string') {
      rawSocket.destroy();
      return;
    }
    const accept = createHash('sha1').update(`${key}${WEBSOCKET_GUID}`).digest('base64');
    rawSocket.write(
      'HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n' +
        `Sec-WebSocket-Accept: ${accept}\r\n\r\n`,
    );
    const socket = new WireSocket(rawSocket);
    sockets.add(socket);
    listens.set(socket, new Set());
    // The client splits a long message into a frame count then that many frames.
    let pendingFrames = 0;
    let pendingText = '';
    socket.onText = (text) => {
      if (pendingFrames > 0) {
        pendingText += text;
        pendingFrames -= 1;
        if (pendingFrames === 0) {
          handleMessage(socket, JSON.parse(pendingText) as JsonObject);
          pendingText = '';
        }
        return;
      }
      if (/^\d+$/.test(text)) {
        // "0" is a keep-alive; any other count announces a split message.
        pendingFrames = Number(text);
        return;
      }
      handleMessage(socket, JSON.parse(text) as JsonObject);
    };
    rawSocket.on('close', () => {
      sockets.delete(socket);
      listens.delete(socket);
    });
    if (head.length > 0) {
      socket.feed(head);
    }
    socket.sendText(
      JSON.stringify({
        t: 'c',
        d: { t: 'h', d: { ts: Date.now(), v: '5', h: `127.0.0.1:${port}`, s: 'fake-session' } },
      }),
    );
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  port = (server.address() as AddressInfo).port;
  return fake;
}
