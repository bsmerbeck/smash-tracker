import { describe, expect, it } from 'vitest';
import { webUserProfileSchema } from './demoAccount';

function baseProfile() {
  return {
    uid: 'uid-1',
    email: 'test@example.com',
    fighters: { primary: [], secondary: [] },
    coachingModeEnabled: false,
    onboardingIntent: null,
  };
}

describe('webUserProfileSchema', () => {
  it("parses today's exact GET /api/users/me response — before the API sends isDemoAccount — with isDemoAccount undefined", () => {
    const result = webUserProfileSchema.parse(baseProfile());
    expect(result.isDemoAccount).toBeUndefined();
  });

  it('parses a response carrying isDemoAccount: true once the API sends it', () => {
    const result = webUserProfileSchema.parse({ ...baseProfile(), isDemoAccount: true });
    expect(result.isDemoAccount).toBe(true);
  });

  it('parses a response carrying isDemoAccount: false', () => {
    const result = webUserProfileSchema.parse({ ...baseProfile(), isDemoAccount: false });
    expect(result.isDemoAccount).toBe(false);
  });

  it('rejects a non-boolean isDemoAccount value rather than silently coercing it', () => {
    expect(() => webUserProfileSchema.parse({ ...baseProfile(), isDemoAccount: 'true' })).toThrow();
  });

  it('still enforces every field the shared userProfileSchema requires', () => {
    expect(() => webUserProfileSchema.parse({ ...baseProfile(), uid: undefined })).toThrow();
  });
});
