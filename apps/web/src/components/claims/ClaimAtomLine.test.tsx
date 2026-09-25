import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import type { ClaimAtomRecord } from '@smash-tracker/shared';
import { ClaimAtomLine, ClaimSectionBody } from './ClaimAtomLine';
import { resolveClaimSection } from './claimSection';

/**
 * Phase 39 (plan 39-09, RPT-06): `ClaimAtomLine` renders every figure from
 * the stored claim object. Rendered BARE — no QueryClient, no router, no
 * auth provider — which is itself the proof the component reads nothing but
 * its props.
 */

const SAMPLE: ClaimAtomRecord['sample'] = {
  rawSampleSize: 55,
  eligibleDenominator: 55,
  knownFieldCoverage: 1,
  refreshedAt: 1_700_000_000_000,
  evidencePolicyVersion: 1,
  recencyTreatment: 'unweighted',
  confidenceTier: 'medium',
};

function makeClaim(overrides: Partial<ClaimAtomRecord> = {}): ClaimAtomRecord {
  return {
    id: 'claim-stage-record',
    predicate: 'stage_record',
    // stageId 1 = Battlefield in the shared stage table.
    subject: { stageId: 1 },
    value: { kind: 'record', wins: 34, losses: 21, games: 55 },
    claimKind: 'fact',
    evidenceIds: ['row-1'],
    tier: 'medium',
    policyVersion: 1,
    sample: SAMPLE,
    ...overrides,
  };
}

const ABSTAINED_CLAIM = makeClaim({
  id: 'claim-abstained',
  value: { kind: 'abstained', gamesNeeded: 2 },
  tier: null,
  sample: { ...SAMPLE, rawSampleSize: 1, eligibleDenominator: 1, confidenceTier: null },
});

function evidenceLine(container: HTMLElement): HTMLElement {
  const line = container.querySelector<HTMLElement>('[data-claim-evidence]');
  if (!line) throw new Error('evidence line not rendered');
  return line;
}

describe('ClaimAtomLine', () => {
  it('renders the prose on the verdict line and the record, sample count and tier phrase on the evidence line', () => {
    const { container } = render(
      <ClaimAtomLine claim={makeClaim()} prose="Steer the set toward the stage you win on." />,
    );

    expect(screen.getByText('Steer the set toward the stage you win on.')).toBeInTheDocument();
    const line = evidenceLine(container);
    expect(line).toHaveTextContent('Battlefield — 34–21 · 62% · 55 games · medium confidence');
    const figure = line.querySelector('[data-claim-figure]');
    expect(figure).toHaveTextContent('34–21 · 62%');
    expect(figure).toHaveClass('font-medium', 'tabular-nums', 'text-foreground');
  });

  it('shows the CLAIM value on the evidence line when the prose states a different number (D-01, T-39-09-01)', () => {
    const { container } = render(
      <ClaimAtomLine claim={makeClaim()} prose="You are 9-1 here, a 90% win rate over 10 games." />,
    );

    const line = evidenceLine(container);
    const figure = line.querySelector('[data-claim-figure]');
    expect(figure).toHaveTextContent('34–21 · 62%');
    for (const proseNumber of ['9', '90%', '10']) {
      expect(figure?.textContent ?? '').not.toContain(proseNumber);
    }
    expect(line.textContent ?? '').not.toMatch(/\b9-1\b|90%|10 games/);
    // The prose itself still renders, verbatim, on the verdict line.
    expect(screen.getByText('You are 9-1 here, a 90% win rate over 10 games.')).toBeInTheDocument();
  });

  it('formats a rate claim as a percent with its numerator/denominator, from the claim value', () => {
    const { container } = render(
      <ClaimAtomLine
        claim={makeClaim({
          id: 'claim-rate',
          predicate: 'stage_pick_rate',
          value: { kind: 'rate', numerator: 34, denominator: 55 },
        })}
      />,
    );
    expect(evidenceLine(container).querySelector('[data-claim-figure]')).toHaveTextContent(
      '62% (34/55)',
    );
  });

  it('renders an abstained claim as the shipped abstention sentence with no figure and no tier phrase', () => {
    const { container } = render(<ClaimAtomLine claim={ABSTAINED_CLAIM} prose="Early read." />);

    const line = evidenceLine(container);
    expect(line).toHaveTextContent('Not enough data yet — 2 more games needed.');
    expect(line.querySelector('[data-claim-figure]')).toBeNull();
    expect(line.textContent ?? '').not.toMatch(/confidence/);
  });

  it("carries the shipped shared.evidence.type.* sentence as the claim-kind marker's accessible label", () => {
    render(<ClaimAtomLine claim={makeClaim({ claimKind: 'inference' })} />);

    const marker = screen.getByRole('img', {
      name: 'Statistical inference from your recorded games.',
    });
    expect(marker).toHaveAttribute('title', 'Statistical inference from your recorded games.');
    // 39.1 ClaimChip branch: the chip's closed vocabulary word (inference -> Trend).
    expect(within(marker).getByText('Trend')).toBeInTheDocument();
  });

  it('labels the verdict line with the predicate when the host supplies no prose', () => {
    render(<ClaimAtomLine claim={makeClaim()} />);
    expect(screen.getByText('Stage record')).toBeInTheDocument();
  });

  it('source read: no uid, no query hook, no subject-type branch, no raw HTML, no paid brand treatment', () => {
    const source = readFileSync(resolve('src/components/claims/ClaimAtomLine.tsx'), 'utf8');
    const code = source
      .split('\n')
      .filter((line) => !/^\s*(\*|\/\/|\/\*)/.test(line))
      .join('\n');
    expect(code).not.toMatch(/\buid\b/);
    expect(code).not.toMatch(/use(Query|Mutation|InfiniteQuery)\b|@tanstack/);
    expect(code).not.toMatch(/subjectType|isCoach|workspaceClient/);
    expect(code).not.toMatch(/dangerouslySetInnerHTML/);
    expect(code).not.toMatch(/Sparkles|text-primary|bg-primary|variant="default"/);
    // D-03: the confidence sentence is never composed locally — only SampleCue renders it.
    expect(code).not.toMatch(/shared\.evidence\.sampleCue/);
    expect(code).toMatch(/<SampleCue sample=/);
  });
});

describe('ClaimSectionBody (UI-SPEC E1 empty / partial / zero-one-many)', () => {
  const live = makeClaim({ id: 'live-1' });
  const live2 = makeClaim({
    id: 'live-2',
    subject: { stageId: 3 },
    value: { kind: 'record', wins: 5, losses: 10, games: 15 },
  });
  const claims = { 'live-1': live, 'live-2': live2, 'claim-abstained': ABSTAINED_CLAIM };

  it('an all-abstained section renders the abstention sentence in place of the list — never an empty <ul>', () => {
    const { container } = render(
      <ClaimSectionBody
        section={{ claimIds: ['claim-abstained'], connective: 'Too early to call.' }}
        claims={claims}
      />,
    );
    expect(screen.getByText('Not enough data yet — 2 more games needed.')).toBeInTheDocument();
    expect(container.querySelector('ul')).toBeNull();
  });

  it('a partially-abstained section renders ONLY the surviving bullets and not the abstention sentence', () => {
    const { container } = render(
      <ClaimSectionBody
        section={{ claimIds: ['claim-abstained', 'live-1'], connective: 'Lean on it.' }}
        claims={claims}
      />,
    );
    expect(container.querySelectorAll('li')).toHaveLength(1);
    expect(screen.queryByText(/Not enough data yet/)).not.toBeInTheDocument();
  });

  it('one claim and many claims render through the same list shape, in stored order', () => {
    const one = render(
      <ClaimSectionBody section={{ claimIds: ['live-1'], connective: '' }} claims={claims} />,
    );
    expect(one.container.querySelectorAll('ul > li')).toHaveLength(1);
    one.unmount();

    const many = render(
      <ClaimSectionBody
        section={{ claimIds: ['live-2', 'live-1'], connective: '' }}
        claims={claims}
      />,
    );
    const ids = [...many.container.querySelectorAll('[data-claim-id]')].map((node) =>
      node.getAttribute('data-claim-id'),
    );
    expect(ids).toEqual(['live-2', 'live-1']);
  });

  it('an empty connective renders the bullets with no verdict prose and no empty paragraph (C1-H4)', () => {
    const { container } = render(
      <ClaimSectionBody section={{ claimIds: ['live-1'], connective: '' }} claims={claims} />,
    );
    expect(container.querySelectorAll('li')).toHaveLength(1);
    for (const paragraph of container.querySelectorAll('p')) {
      expect((paragraph.textContent ?? '').trim()).not.toBe('');
    }
  });

  it('renders nothing for a section with no prose and no resolvable claim', () => {
    const { container } = render(
      <ClaimSectionBody section={{ claimIds: ['missing'], connective: '' }} claims={claims} />,
    );
    expect(container).toBeEmptyDOMElement();
    expect(resolveClaimSection({ claimIds: [], connective: '  ' }, claims)).toEqual({
      kind: 'empty',
    });
  });
});
