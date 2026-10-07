import type { ReactNode } from 'react';
import { useActiveSubject } from '@/hooks/useActiveSubject';
import { useOwnedWorkspaceSubject } from '@/hooks/useOwnedWorkspaceSubject';
import {
  useOwnAccountRecapCandidate,
  useSubjectRecapCandidate,
  type RecapCandidateResult,
  type UseRecapCandidateInput,
} from '@/hooks/useRecapCandidate';

export interface RecapCandidateGateProps extends UseRecapCandidateInput {
  /** Receives the ONE candidate the page shares between the recap card and the prep slot (DD-07). */
  children: (recap: RecapCandidateResult) => ReactNode;
}

/**
 * The component-level gate that keeps the recap's hooks unconditional (plan 39.2-13, D-17):
 * under `/coach/:clientId/*` and `/workspace/:tenantId/*` only the matches-only source mounts,
 * so no tournament-registry request is issued for a client's Dashboard; on the own account the
 * registry-enriched source mounts. It is the `DashboardPrepActionSlot` pattern, with a render
 * prop so a single candidate instance feeds both consumers and adds no DOM of its own.
 */
export function RecapCandidateGate({ children, ...input }: RecapCandidateGateProps) {
  const { clientId } = useActiveSubject();
  const { tenantId } = useOwnedWorkspaceSubject();
  if (clientId || tenantId) {
    return <SubjectSource input={input}>{children}</SubjectSource>;
  }
  return <OwnAccountSource input={input}>{children}</OwnAccountSource>;
}

interface SourceProps {
  input: UseRecapCandidateInput;
  children: (recap: RecapCandidateResult) => ReactNode;
}

function SubjectSource({ input, children }: SourceProps) {
  const recap = useSubjectRecapCandidate(input);
  return <>{children(recap)}</>;
}

function OwnAccountSource({ input, children }: SourceProps) {
  const recap = useOwnAccountRecapCandidate(input);
  return <>{children(recap)}</>;
}
