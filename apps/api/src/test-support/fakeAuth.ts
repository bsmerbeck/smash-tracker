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

  // ---- user management + custom tokens (start.gg login flow) -------------

  seedUser(user: FakeUserRecord): void {
    if (user.email) {
      this.usersByEmail.set(user.email, user);
    }
  }

  async getUserByEmail(email: string): Promise<FakeUserRecord> {
    const user = this.usersByEmail.get(email);
    if (!user) {
      throw new Error(`No user record found for ${email}`);
    }
    return user;
  }

  async createUser(properties: { email: string }): Promise<FakeUserRecord> {
    this.userCounter += 1;
    const user = { uid: `fake-created-uid-${this.userCounter}`, email: properties.email };
    this.usersByEmail.set(properties.email, user);
    return user;
  }

  async createCustomToken(uid: string): Promise<string> {
    return `custom-token-for-${uid}`;
  }
}
