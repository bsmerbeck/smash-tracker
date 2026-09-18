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
    const starterStageIds: Record<string, true> = {};
    const counterpickStageIds: Record<string, true> = {};
    for (const [stageIdText, role] of Object.entries(stageRoles)) {
      const stageId = Number(stageIdText);
      if (role === 'starter') {
        starterStageIds[stageIdKey(stageId)] = true;
      } else if (role === 'counterpick') {
        counterpickStageIds[stageIdKey(stageId)] = true;
      }
    }
    return {
      contractVersion: RULESET_CONTRACT_VERSION,
      starterStageIds,
      counterpickStageIds,
      banCounts: {
        bo3: Number(banBo3) || 0,
        bo5: Number(banBo5) || 0,
      },
      dsr,
      setFormat: { default: setFormatDefault, topCut: setFormatTopCut },
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
