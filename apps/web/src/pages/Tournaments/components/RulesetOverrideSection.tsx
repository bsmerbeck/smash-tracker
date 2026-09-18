import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import {
  DSR_VARIANTS,
  getStageById,
  resolveRuleset,
  RULESET_CONTRACT_VERSION,
  SET_FORMATS,
  stageIdKey,
  TOURNAMENT_LEGAL_STAGE_IDS,
  type DsrVariant,
  type Ruleset,
  type RulesetOverrideStored,
  type SetFormat,
  type TournamentEntry,
} from '@smash-tracker/shared';
import { Card, CardAction, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { useRulesetOverride } from '@/hooks/useRulesetOverride';

export interface RulesetOverrideSectionProps {
  entry: Pick<TournamentEntry, 'entryKey' | 'rulesetOverride'>;
}

type StageRole = 'starter' | 'counterpick' | 'notLegal';

function buildInitialStageRoles(ruleset: {
  starterStageIds: number[];
  counterpickStageIds: number[];
}): Record<number, StageRole> {
  const roles: Record<number, StageRole> = {};
  for (const stageId of TOURNAMENT_LEGAL_STAGE_IDS) {
    roles[stageId] = ruleset.starterStageIds.includes(stageId)
      ? 'starter'
      : ruleset.counterpickStageIds.includes(stageId)
        ? 'counterpick'
        : 'notLegal';
  }
  return roles;
}

/** Ascending-sorted stage ids assigned `role` in `stageRoles`, scoped to this app's own legal-stage list (the only ids this editor's toggles ever assign). */
function stageIdsWithRole(stageRoles: Record<number, StageRole>, role: StageRole): number[] {
  return TOURNAMENT_LEGAL_STAGE_IDS.filter((stageId) => stageRoles[stageId] === role).sort(
    (a, b) => a - b,
  );
}

/** Both inputs are pre-sorted ascending (every caller here sorts via `stageIdsWithRole`/`Ruleset`'s own documented invariant). */
function sameIdList(a: number[], b: number[]): boolean {
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

function presenceMapFromIds(ids: number[]): Record<string, true> {
  const map: Record<string, true> = {};
  for (const id of ids) {
    map[stageIdKey(id)] = true;
  }
  return map;
}

/**
 * Tournament-detail ruleset disclosure + editor (EVID-04, D-10, D-16). Renders
 * for every entry including admin-imported ones (see `TournamentDetailPage`'s
 * mount comment): the retrospective in plan 37-06 grades historical picks
 * under whichever ruleset applied to that event, and this is where that
 * ruleset is disclosed and — own-account only, D-18 — edited.
 *
 * The editor offers only this app's own tournament-legal stage list
 * (`TOURNAMENT_LEGAL_STAGE_IDS`) — a deliberate UI scope choice. The stored
 * schema (`rulesetOverrideStoredSchema`) accepts any stage id, so a later
 * phase can widen the picker without a schema change.
 *
 * The editor never exposes a field for `strikeOrder`: it is disclosed
 * verbatim from the preset and is never paraphrased or edited here, so it is
 * intentionally omitted from every payload this component submits (an
 * "untouched" member, per the RTDB conditional-spread convention every other
 * member below follows).
 *
 * **WR-01/WR-02 fix (2026-09-18): every editable member follows that same
 * "untouched -> omitted" rule, not just `strikeOrder`.** `buildPayload()`
 * diffs the CURRENT form state against `baseline` — the fully resolved
 * `Ruleset` snapshotted at the moment the dialog opened (same instant the
 * other fields are re-seeded, below) — and includes a member only when it
 * differs from that snapshot. This was verified against the PATCH route's
 * actual behaviour (`apps/api/src/routes/tournaments.ts`): a single
 * `entryRef.update({ rulesetOverride: stored })` call replaces the WHOLE
 * `rulesetOverride` child every write — there is no server-side member-wise
 * merge across separate saves, so "omit" unambiguously means "drop" (revert
 * that member to inherit from the preset via `resolveRuleset`), never "keep
 * whatever was stored before." Before this fix, `starterStageIds`/
 * `counterpickStageIds` (built from every one of `TOURNAMENT_LEGAL_STAGE_IDS`
 * via `buildInitialStageRoles`) were included on EVERY save regardless of
 * whether any stage toggle was touched — so editing an unrelated field (say,
 * the DSR radio) permanently froze that event's entire stage-legality split
 * as an explicit, stored snapshot, silently opting it out of any future
 * `DEFAULT_RULESET` revision.
 *
 * `starterStageIds` and `counterpickStageIds` are diffed INDEPENDENTLY of
 * each other (not as one all-or-nothing pair): each is included only if ITS
 * OWN derived id set differs from `baseline`'s. This matches
 * `resolveRuleset`'s own documented "each declared member REPLACES the
 * preset's WHOLE-MEMBER" contract — an omitted sibling list is not claimed
 * by this override at all, so it correctly falls through to
 * `DEFAULT_RULESET`'s raw value, exactly as if this override had never
 * declared it. Known, accepted consequence: if a stored override already
 * customises ONE list differently from the raw preset and a later save
 * touches only the OTHER list, the untouched list's customisation is not
 * re-declared and so reverts to the raw preset default (not to its last
 * stored value) — the same behaviour the shared contract already documents
 * for any other omitted member, not something this component papers over.
 */
export function RulesetOverrideSection({ entry }: RulesetOverrideSectionProps) {
  const { t } = useTranslation();
  const entryKey = entry.entryKey ?? '';
  const mutation = useRulesetOverride(entryKey);
  const resolved = resolveRuleset(entry.rulesetOverride);
  const { ruleset } = resolved;
  const isOverride = resolved.source === 'event-override';

  const [dialogOpen, setDialogOpen] = useState(false);
  const [stageRoles, setStageRoles] = useState<Record<number, StageRole>>(() =>
    buildInitialStageRoles(ruleset),
  );
  const [banBo3, setBanBo3] = useState(String(ruleset.banCounts.bo3));
  const [banBo5, setBanBo5] = useState(String(ruleset.banCounts.bo5));
  const [dsr, setDsr] = useState<DsrVariant>(ruleset.dsr);
  const [setFormatDefault, setSetFormatDefault] = useState<SetFormat>(ruleset.setFormat.default);
  const [setFormatTopCut, setSetFormatTopCut] = useState<SetFormat>(ruleset.setFormat.topCut);
  // WR-02 fix: the resolved ruleset AT THE MOMENT THE DIALOG OPENED —
  // `buildPayload` diffs the current form state against this snapshot, never
  // against the live `ruleset` (which could theoretically move under the
  // dialog if `entry` refetches while it's open).
  const [baseline, setBaseline] = useState<Ruleset>(ruleset);

  // Render-time state adjustment (mirrors GenerateRecapDialog's `wasOpen`
  // pattern): re-seeds every field from the CURRENTLY resolved ruleset the
  // moment the dialog transitions closed->open, so reopening after a save
  // (or against a different entry) never shows stale edited values.
  const [wasDialogOpen, setWasDialogOpen] = useState(dialogOpen);
  if (dialogOpen !== wasDialogOpen) {
    setWasDialogOpen(dialogOpen);
    if (dialogOpen) {
      setStageRoles(buildInitialStageRoles(ruleset));
      setBanBo3(String(ruleset.banCounts.bo3));
      setBanBo5(String(ruleset.banCounts.bo5));
      setDsr(ruleset.dsr);
      setSetFormatDefault(ruleset.setFormat.default);
      setSetFormatTopCut(ruleset.setFormat.topCut);
      setBaseline(ruleset);
    }
  }

  const starterClause = t('shared.ruleset.preset.starterClause', {
    count: ruleset.starterStageIds.length,
  });
  const banClause = t('shared.ruleset.preset.banClause', {
    count: ruleset.banCounts[ruleset.setFormat.default],
  });
  const dsrLabel = t(`shared.ruleset.dsr.${ruleset.dsr}`);
  const setFormatLabel = t(`shared.ruleset.setFormat.${ruleset.setFormat.default}`);
  const detailLine = t('shared.ruleset.preset.default.detail', {
    starters: starterClause,
    bans: banClause,
    strikeOrder: ruleset.strikeOrder,
    dsr: dsrLabel,
    setFormat: setFormatLabel,
    source: ruleset.source.url,
    date: ruleset.source.retrievedAt,
  });

  function buildPayload(): RulesetOverrideStored {
    const currentStarterIds = stageIdsWithRole(stageRoles, 'starter');
    const currentCounterpickIds = stageIdsWithRole(stageRoles, 'counterpick');
    const starterChanged = !sameIdList(currentStarterIds, baseline.starterStageIds);
    const counterpickChanged = !sameIdList(currentCounterpickIds, baseline.counterpickStageIds);

    const parsedBanBo3 = Number(banBo3) || 0;
    const parsedBanBo5 = Number(banBo5) || 0;
    const banCountsChanged =
      parsedBanBo3 !== baseline.banCounts.bo3 || parsedBanBo5 !== baseline.banCounts.bo5;

    const dsrChanged = dsr !== baseline.dsr;
    const setFormatChanged =
      setFormatDefault !== baseline.setFormat.default ||
      setFormatTopCut !== baseline.setFormat.topCut;

    // WR-02 fix: every member below is conditional-spread — an untouched
    // member (its current form value equals the `baseline` it was seeded
    // from) is OMITTED, never resent as an explicit snapshot. See the
    // component doc comment for why `starterStageIds`/`counterpickStageIds`
    // are diffed independently of each other, and why "omit" unambiguously
    // means "drop" under this route's actual whole-child-replace semantics.
    return {
      contractVersion: RULESET_CONTRACT_VERSION,
      ...(starterChanged ? { starterStageIds: presenceMapFromIds(currentStarterIds) } : {}),
      ...(counterpickChanged
        ? { counterpickStageIds: presenceMapFromIds(currentCounterpickIds) }
        : {}),
      ...(banCountsChanged ? { banCounts: { bo3: parsedBanBo3, bo5: parsedBanBo5 } } : {}),
      ...(dsrChanged ? { dsr } : {}),
      ...(setFormatChanged
        ? { setFormat: { default: setFormatDefault, topCut: setFormatTopCut } }
        : {}),
      // strikeOrder is deliberately OMITTED — this editor exposes no field
      // for it, so it always stays inherited from the preset via
      // `resolveRuleset`.
    };
  }

  function handleSubmit() {
    mutation.mutate(buildPayload(), {
      onSuccess: () => {
        toast.success(t('tournaments.detail.rulesetOverride.saved'));
        setDialogOpen(false);
      },
      onError: () => {
        toast.error(t('tournaments.detail.rulesetOverride.saveFailed'));
      },
    });
  }

  function handleReset() {
    mutation.mutate(null, {
      onSuccess: () => {
        toast.success(t('tournaments.detail.rulesetOverride.saved'));
      },
      onError: () => {
        toast.error(t('tournaments.detail.rulesetOverride.saveFailed'));
      },
    });
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t('tournaments.detail.rulesetOverride.title')}</CardTitle>
        {isOverride && (
          <CardAction>
            <Badge variant="outline">{t('shared.ruleset.overrideBadge')}</Badge>
          </CardAction>
        )}
      </CardHeader>
      <CardContent className="flex flex-col gap-2 text-sm">
        <p>
          {t(
            isOverride
              ? 'tournaments.detail.rulesetOverride.usingOverride'
              : 'tournaments.detail.rulesetOverride.usingDefault',
          )}
        </p>
        <p className="text-muted-foreground">{detailLine}</p>
        {resolved.ignoredOverrideReason && (
          <p className="text-xs text-muted-foreground">{t('shared.ruleset.overrideIgnored')}</p>
        )}
        <div className="flex gap-2">
          <Button type="button" variant="outline" size="sm" onClick={() => setDialogOpen(true)}>
            {t('tournaments.detail.rulesetOverride.editButton')}
          </Button>
          {isOverride && (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              disabled={mutation.isPending}
              onClick={handleReset}
            >
              {t('tournaments.detail.rulesetOverride.resetButton')}
            </Button>
          )}
        </div>
      </CardContent>

      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent className="max-h-[85vh] max-w-lg overflow-y-auto">
          <DialogHeader>
            <DialogTitle>{t('tournaments.detail.rulesetOverride.title')}</DialogTitle>
          </DialogHeader>

          <div className="flex flex-col gap-4">
            <div className="flex flex-col gap-2">
              {TOURNAMENT_LEGAL_STAGE_IDS.map((stageId) => (
                <div key={stageId} className="flex items-center justify-between gap-2">
                  <Label className="min-w-0 flex-1 truncate">
                    {getStageById(stageId)?.name ?? stageId}
                  </Label>
                  <ToggleGroup
                    type="single"
                    variant="outline"
                    size="sm"
                    value={stageRoles[stageId] ?? 'notLegal'}
                    onValueChange={(value) => {
                      if (!value) {
                        return;
                      }
                      setStageRoles((prev) => ({ ...prev, [stageId]: value as StageRole }));
                    }}
                  >
                    <ToggleGroupItem value="starter">
                      {t('tournaments.detail.rulesetOverride.stageRole.starter')}
                    </ToggleGroupItem>
                    <ToggleGroupItem value="counterpick">
                      {t('tournaments.detail.rulesetOverride.stageRole.counterpick')}
                    </ToggleGroupItem>
                    <ToggleGroupItem value="notLegal">
                      {t('tournaments.detail.rulesetOverride.stageRole.notLegal')}
                    </ToggleGroupItem>
                  </ToggleGroup>
                </div>
              ))}
            </div>

            <div className="flex items-center gap-4">
              <div className="flex flex-1 flex-col gap-1">
                <Label htmlFor="ruleset-ban-bo3">
                  {t('tournaments.detail.rulesetOverride.banCountBo3')}
                </Label>
                <Input
                  id="ruleset-ban-bo3"
                  type="number"
                  min={0}
                  max={5}
                  value={banBo3}
                  onChange={(event) => setBanBo3(event.target.value)}
                />
              </div>
              <div className="flex flex-1 flex-col gap-1">
                <Label htmlFor="ruleset-ban-bo5">
                  {t('tournaments.detail.rulesetOverride.banCountBo5')}
                </Label>
                <Input
                  id="ruleset-ban-bo5"
                  type="number"
                  min={0}
                  max={5}
                  value={banBo5}
                  onChange={(event) => setBanBo5(event.target.value)}
                />
              </div>
            </div>

            <div className="flex flex-col gap-1">
              <Label>{t('tournaments.detail.rulesetOverride.dsrLabel')}</Label>
              <RadioGroup
                value={dsr}
                onValueChange={(value) => setDsr(value as DsrVariant)}
                className="flex flex-row gap-4"
              >
                {DSR_VARIANTS.map((variant) => (
                  <div key={variant} className="flex items-center gap-2">
                    <RadioGroupItem id={`ruleset-dsr-${variant}`} value={variant} />
                    <Label htmlFor={`ruleset-dsr-${variant}`}>
                      {t(`shared.ruleset.dsr.${variant}`)}
                    </Label>
                  </div>
                ))}
              </RadioGroup>
            </div>

            <div className="flex flex-col gap-1">
              <Label>{t('tournaments.detail.rulesetOverride.setFormatDefault')}</Label>
              <RadioGroup
                value={setFormatDefault}
                onValueChange={(value) => setSetFormatDefault(value as SetFormat)}
                className="flex flex-row gap-4"
              >
                {SET_FORMATS.map((format) => (
                  <div key={format} className="flex items-center gap-2">
                    <RadioGroupItem id={`ruleset-set-format-default-${format}`} value={format} />
                    <Label htmlFor={`ruleset-set-format-default-${format}`}>
                      {t(`shared.ruleset.setFormat.${format}`)}
                    </Label>
                  </div>
                ))}
              </RadioGroup>
            </div>

            <div className="flex flex-col gap-1">
              <Label>{t('tournaments.detail.rulesetOverride.setFormatTopCut')}</Label>
              <RadioGroup
                value={setFormatTopCut}
                onValueChange={(value) => setSetFormatTopCut(value as SetFormat)}
                className="flex flex-row gap-4"
              >
                {SET_FORMATS.map((format) => (
                  <div key={format} className="flex items-center gap-2">
                    <RadioGroupItem id={`ruleset-set-format-topcut-${format}`} value={format} />
                    <Label htmlFor={`ruleset-set-format-topcut-${format}`}>
                      {t(`shared.ruleset.setFormat.${format}`)}
                    </Label>
                  </div>
                ))}
              </RadioGroup>
            </div>
          </div>

          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setDialogOpen(false)}>
              {t('common.cancel')}
            </Button>
            <Button type="button" onClick={handleSubmit} disabled={mutation.isPending}>
              {t('common.save')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Card>
  );
}
