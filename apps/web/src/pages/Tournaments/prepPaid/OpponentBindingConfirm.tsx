import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import type {
  PrepScoutBindingCandidate,
  PrepScoutBindingConfirmRequest,
  ScoutBinding,
} from '@smash-tracker/shared';
import { ApiError } from '@/lib/api';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Command, CommandGroup, CommandItem, CommandList } from '@/components/ui/command';
import {
  useClearScoutBinding,
  useConfirmScoutBinding,
  usePrepBindingCandidates,
} from '@/hooks/useScoutBindings';

export interface OpponentBindingConfirmProps {
  /** The tournament entry this brief belongs to — threaded through to the confirm/clear/candidates hooks. */
  entryKey: string;
  /** The curated canonical opponent name this affordance resolves an identity for. */
  name: string;
  /** The currently confirmed binding for this opponent, or `undefined` when unresolved. */
  binding?: ScoutBinding;
}

/**
 * Maps ONE candidate (already provider-tagged by the server) onto the
 * confirm-request shape. This is the only place a "side" is chosen for a
 * candidate-based confirmation — a `combined` candidate carries both
 * identities already, so both branches are sent in that one case; a plain
 * `startgg`/`parrygg` candidate sends only its own branch. No re-ranking or
 * re-ordering happens here — the candidate is rendered in the exact position
 * the server returned it.
 */
function candidateToConfirmRequest(
  candidate: PrepScoutBindingCandidate,
): PrepScoutBindingConfirmRequest {
  const startggQuery = candidate.startggUserSlug ?? candidate.startggPlayerId?.toString();
  const parryggQuery = candidate.parryUserId;
  if (candidate.provider === 'parrygg') {
    return { parrygg: { query: parryggQuery as string } };
  }
  if (candidate.provider === 'startgg') {
    return { startgg: { query: startggQuery as string } };
  }
  return {
    startgg: { query: startggQuery as string },
    parrygg: { query: parryggQuery as string },
  };
}

interface BindingFlowContentProps {
  name: string;
  candidateList: PrepScoutBindingCandidate[];
  highlightedIndex: number | null;
  onSelectCandidate: (index: number) => void;
  onConfirmHighlighted: () => void;
  manualInput: string;
  onManualInputChange: (value: string) => void;
  onConfirmManual: () => void;
  errorMessage: string | null;
  onCancel: () => void;
  manualInputId: string;
}

/**
 * The popover body shared by BOTH the unconfirmed ("Confirm player") and
 * confirmed ("Change player") triggers below — identical content either
 * way, so this is the single place the candidate list / manual-paste form /
 * error / cancel action are defined, rather than two drifting copies.
 */
function BindingFlowContent({
  name,
  candidateList,
  highlightedIndex,
  onSelectCandidate,
  onConfirmHighlighted,
  manualInput,
  onManualInputChange,
  onConfirmManual,
  errorMessage,
  onCancel,
  manualInputId,
}: BindingFlowContentProps) {
  const { t } = useTranslation();
  return (
    <div className="flex flex-col gap-3">
      <div>
        <h4 className="text-sm font-medium">{t('prepPaid.binding.dialogTitle', { name })}</h4>
        <p className="text-xs text-muted-foreground">{t('prepPaid.binding.dialogDescription')}</p>
      </div>

      <div className="flex flex-col gap-1">
        <span className="text-xs font-medium text-muted-foreground">
          {t('prepPaid.binding.candidatesLabel')}
        </span>
        {candidateList.length === 0 ? (
          <p className="text-xs text-muted-foreground">{t('prepPaid.binding.candidatesEmpty')}</p>
        ) : (
          <Command shouldFilter={false}>
            <CommandList>
              <CommandGroup>
                {candidateList.map((candidate, index) => (
                  <CommandItem
                    key={`${candidate.provider}-${index}`}
                    value={`${candidate.provider}-${index}`}
                    aria-selected={highlightedIndex === index}
                    onSelect={() => onSelectCandidate(index)}
                  >
                    <span className="flex w-full items-center justify-between gap-2">
                      <span>{candidate.displayTag}</span>
                      <span className="text-xs text-muted-foreground">
                        {t('prepPaid.binding.matchCount', { count: candidate.matchCount })}
                      </span>
                    </span>
                  </CommandItem>
                ))}
              </CommandGroup>
            </CommandList>
          </Command>
        )}
        {candidateList.length > 1 && (
          <p className="text-xs text-muted-foreground">{t('prepPaid.binding.multipleHint')}</p>
        )}
        {candidateList.length > 0 && (
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={highlightedIndex === null}
            onClick={onConfirmHighlighted}
          >
            {t('prepPaid.binding.confirmAction')}
          </Button>
        )}
      </div>

      <div className="flex flex-col gap-1">
        <Label htmlFor={manualInputId}>{t('prepPaid.binding.manualLabel')}</Label>
        <Input
          id={manualInputId}
          value={manualInput}
          placeholder={t('prepPaid.binding.manualPlaceholder')}
          onChange={(event) => onManualInputChange(event.target.value)}
        />
        <p className="text-xs text-muted-foreground">{t('prepPaid.binding.manualHint')}</p>
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={!manualInput.trim()}
          onClick={onConfirmManual}
        >
          {t('prepPaid.binding.confirmAction')}
        </Button>
      </div>

      {errorMessage && <p className="text-xs text-destructive">{errorMessage}</p>}

      <div className="flex items-center justify-end">
        <Button type="button" variant="ghost" size="sm" onClick={onCancel}>
          {t('prepPaid.binding.cancelAction')}
        </Button>
      </div>
    </div>
  );
}

/**
 * The per-row confirm-player affordance (27-CONTEXT.md "UI delta — binding
 * confirmation"): resolves which real start.gg/parry.gg profile a curated
 * opponent is, with NO charge and NO model call — pure identity resolution.
 * Rendered by `PrepPaidReportsCard` once per curated opponent, independent
 * of that opponent's purchase/job state.
 */
export function OpponentBindingConfirm({ entryKey, name, binding }: OpponentBindingConfirmProps) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  // Owner rule (27-CONTEXT.md "Resolution flow"): a single candidate is
  // pre-highlighted but NEVER auto-submitted — the player still confirms
  // explicitly. `selectedIndex` starts `null`; the derived `highlightedIndex`
  // below is what actually drives the UI.
  const [selectedIndex, setSelectedIndex] = useState<number | null>(null);
  const [manualInput, setManualInput] = useState('');
  const [errorKind, setErrorKind] = useState<'notFound' | 'failed' | null>(null);

  // Owner rule: the candidates query is opt-in, only while this specific
  // opponent's flow is open (usePrepBindingCandidates defaults to disabled) —
  // a brief with many curated opponents must not fan out a candidates
  // request per row on mount.
  const candidates = usePrepBindingCandidates(entryKey, name, { enabled: open });
  const confirmBinding = useConfirmScoutBinding(entryKey);
  const clearBinding = useClearScoutBinding(entryKey);

  const candidateList = candidates.data?.candidates ?? [];

  // Owner rule: exactly one candidate -> pre-highlight it (index 0) without
  // submitting; more than one candidate -> leave the selection empty and
  // show the multiple-identity hint instead. There is no ordering by match
  // count or recency here — `candidateList` is rendered in the server's own
  // deterministic order, never sorted or sliced by this component.
  const highlightedIndex = candidateList.length === 1 ? 0 : selectedIndex;

  function resetFlowState() {
    setSelectedIndex(null);
    setManualInput('');
    setErrorKind(null);
  }

  function handleOpenChange(next: boolean) {
    setOpen(next);
    if (!next) {
      resetFlowState();
    }
  }

  function submitConfirm(input: PrepScoutBindingConfirmRequest) {
    setErrorKind(null);
    confirmBinding.mutate(
      { name, input },
      {
        onSuccess: () => {
          handleOpenChange(false);
        },
        onError: (error) => {
          // A resolution failure leaves the flow OPEN so the player can
          // correct the input, rather than closing on error.
          if (error instanceof ApiError && error.status === 404) {
            setErrorKind('notFound');
          } else {
            setErrorKind('failed');
          }
        },
      },
    );
  }

  function handleConfirmHighlighted() {
    if (highlightedIndex === null) {
      return;
    }
    const candidate = candidateList[highlightedIndex];
    if (!candidate) {
      return;
    }
    submitConfirm(candidateToConfirmRequest(candidate));
  }

  // Owner rule (27-CONTEXT.md "no silent fallback to the canonical tag" /
  // this plan's "do not implement client-side provider parsing"): a pasted
  // reference could be a start.gg OR a parry.gg profile link, and this
  // component has no way to tell which without parsing the URL itself
  // (forbidden). Rather than guess, the SAME raw reference is submitted
  // under BOTH branches — each provider's own server-side resolver either
  // parses it or rejects it; a link only ever matches its own provider's
  // format, so at most one branch actually resolves. This is the literal
  // reading of "submit the raw reference and let the server resolve it."
  function handleConfirmManual() {
    const trimmed = manualInput.trim();
    if (!trimmed) {
      return;
    }
    submitConfirm({ startgg: { query: trimmed }, parrygg: { query: trimmed } });
  }

  function handleRemove() {
    clearBinding.mutate(name);
  }

  const errorMessage =
    errorKind === 'notFound'
      ? t('prepPaid.binding.error.notFound')
      : errorKind === 'failed'
        ? t('prepPaid.binding.error.failed')
        : null;

  const manualInputId = `prep-binding-manual-${entryKey}-${name}`;

  const flowContent = (
    <BindingFlowContent
      name={name}
      candidateList={candidateList}
      highlightedIndex={highlightedIndex}
      onSelectCandidate={setSelectedIndex}
      onConfirmHighlighted={handleConfirmHighlighted}
      manualInput={manualInput}
      onManualInputChange={setManualInput}
      onConfirmManual={handleConfirmManual}
      errorMessage={errorMessage}
      onCancel={() => handleOpenChange(false)}
      manualInputId={manualInputId}
    />
  );

  if (binding) {
    return (
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-xs text-muted-foreground">
          {t('prepPaid.binding.confirmedLabel', { tag: binding.displayTag })}
        </span>
        <Popover open={open} onOpenChange={handleOpenChange}>
          <PopoverTrigger asChild>
            <Button type="button" variant="ghost" size="sm" className="h-auto p-0 text-xs">
              {t('prepPaid.binding.changeCta')}
            </Button>
          </PopoverTrigger>
          <PopoverContent className="w-80">{flowContent}</PopoverContent>
        </Popover>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="h-auto p-0 text-xs"
          onClick={handleRemove}
        >
          {t('prepPaid.binding.clearCta')}
        </Button>
      </div>
    );
  }

  return (
    <div className="flex flex-wrap items-center gap-2">
      <span className="text-xs text-muted-foreground">{t('prepPaid.binding.unresolved')}</span>
      <Popover open={open} onOpenChange={handleOpenChange}>
        <PopoverTrigger asChild>
          <Button type="button" variant="outline" size="sm">
            {t('prepPaid.binding.confirmCta')}
          </Button>
        </PopoverTrigger>
        <PopoverContent className="w-80">{flowContent}</PopoverContent>
      </Popover>
    </div>
  );
}
