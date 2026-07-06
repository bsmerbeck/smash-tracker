/**
 * Minimal stand-in for firebase-admin's Auth client, covering only
 * verifyIdToken. Tokens are opaque strings mapped to decoded claims in a
 * lookup table the test configures.
 */
export interface FakeDecodedToken {
  uid: string;
  email?: string;
}

export interface FakeUserRecord {
  uid: string;
  email?: string;
}

export class FakeAuth {
  private tokens = new Map<string, FakeDecodedToken>();
  private usersByEmail = new Map<string, FakeUserRecord>();
  private usersByUid = new Map<string, FakeUserRecord>();
  private userCounter = 0;

  registerToken(token: string, decoded: FakeDecodedToken): void {
    this.tokens.set(token, decoded);
  }

  async verifyIdToken(idToken: string): Promise<FakeDecodedToken> {
    const decoded = this.tokens.get(idToken);
    if (!decoded) {
      throw new Error('Invalid token');
    }
    return decoded;
  }

  // ---- user management + custom tokens (start.gg / parry.gg login flows) -

  seedUser(user: FakeUserRecord): void {
    if (user.email) {
      this.usersByEmail.set(user.email, user);
    }
    this.usersByUid.set(user.uid, user);
  }

  async getUserByEmail(email: string): Promise<FakeUserRecord> {
    const user = this.usersByEmail.get(email);
    if (!user) {
      throw new Error(`No user record found for ${email}`);
    }
    return user;
  }

  /**
   * Mirrors firebase-admin's `createUser`, which accepts either an `email`
   * (start.gg login: find-or-create by verified email) or an explicit `uid`
   * with no email (parry.gg login: deterministic `parrygg-{id}` uid, no
   * email available). Throws if the uid is already taken, same as the real
   * SDK (`auth/uid-already-exists`).
   */
  async createUser(properties: { email: string } | { uid: string }): Promise<FakeUserRecord> {
    if ('uid' in properties) {
      if (this.usersByUid.has(properties.uid)) {
        throw new Error(`uid already exists: ${properties.uid}`);
      }
      const user = { uid: properties.uid };
      this.usersByUid.set(user.uid, user);
      return user;
    }
    this.userCounter += 1;
    const user = { uid: `fake-created-uid-${this.userCounter}`, email: properties.email };
    this.usersByEmail.set(properties.email, user);
    this.usersByUid.set(user.uid, user);
    return user;
  }

  async createCustomToken(uid: string): Promise<string> {
    return `custom-token-for-${uid}`;
  }
}
