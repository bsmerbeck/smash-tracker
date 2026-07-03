/**
 * Minimal stand-in for firebase-admin's Auth client, covering only
 * verifyIdToken. Tokens are opaque strings mapped to decoded claims in a
 * lookup table the test configures.
 */
export interface FakeDecodedToken {
  uid: string;
  email?: string;
}

export class FakeAuth {
  private tokens = new Map<string, FakeDecodedToken>();

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
}
