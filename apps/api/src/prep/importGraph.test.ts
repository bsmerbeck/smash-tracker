import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Owner test requirement 5 (26-CONTEXT.md, T-26-11): proves in product
 * terms that rendering or activating a prep brief can NEVER reach the
 * model pipeline or the credit ledger, because the only module allowed to
 * touch `prepBriefs/*` (`apps/api/src/prep/`, D-22) structurally cannot
 * import `reports/`, `billing/`, or the Anthropic SDK. This is a
 * content-based grep-gate rather than a `git diff`, mirroring
 * `apps/web/src/routes/coachChromeIntegrity.test.ts`'s precedent, so it
 * stays meaningful regardless of which commit or worktree it runs from —
 * and fails CI loudly the moment a future edit couples prep to reports,
 * billing, or the model SDK, rather than relying on code review alone.
 */
describe('prep module has no report/billing/Anthropic dependency (T-26 zero-model-call guarantee)', () => {
  const dir = resolve('src/prep');
  const files = readdirSync(dir).filter(
    (file) => file.endsWith('.ts') && !file.endsWith('.test.ts'),
  );

  it('discovers at least one source file to scan (a silently-empty readdirSync would make every case below vacuously pass)', () => {
    expect(files.length).toBeGreaterThan(0);
  });

  it.each(files)('%s never imports reports/, billing/, or @anthropic-ai', (file) => {
    const source = readFileSync(resolve(dir, file), 'utf-8');
    expect(source).not.toMatch(/from ['"].*\/reports\//);
    expect(source).not.toMatch(/from ['"].*\/billing\//);
    expect(source).not.toMatch(/@anthropic-ai/);
  });
});
