import { useTranslation } from 'react-i18next';
import { Download, Printer, Sparkles } from 'lucide-react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import type { ScoutReportRecord } from '@smash-tracker/shared';
import { useIsDemoAccount } from '@/hooks/useIsDemoAccount';
import { formatRelativeDate } from '@/lib/relativeDate';
import { ClaimAtomLine } from '@/components/claims/ClaimAtomLine';
import { LegacyReportBadge } from '@/components/claims/LegacyReportBadge';
import {
  isClaimsEraReport,
  resolveClaimSection,
  type ResolvedClaimSection,
} from '@/components/claims/claimSection';
import { reportMarkdownFilename, reportToMarkdown } from '../reportMarkdown';

function downloadMarkdown(record: ScoutReportRecord) {
  const markdown = reportToMarkdown(record);
  const blob = new Blob([markdown], { type: 'text/markdown;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = reportMarkdownFilename(record);
  document.body.appendChild(anchor);
  anchor.click();
  document.body.removeChild(anchor);
  URL.revokeObjectURL(url);
}

/** The overview section's connective IS the card's description line, so its claim list renders without restating it. */
function withoutConnective(section: ResolvedClaimSection): ResolvedClaimSection {
  if (section.kind === 'claims' || section.kind === 'abstained') {
    return { ...section, connective: '' };
  }
  return { kind: 'empty' };
}

/**
 * Plan 39-09 (RPT-06): one claim-anchored section on screen — the connective
 * once as the section lead, then one `ClaimAtomLine` per surviving claim in
 * stored order, or the shipped abstention sentence in place of the list when
 * every claim abstained (UI-SPEC E1). Renders nothing — heading included —
 * for an `empty` section.
 */
function ScreenClaimSection({
  heading,
  section,
}: {
  heading: string | null;
  section: ResolvedClaimSection;
}) {
  const { t } = useTranslation();
  if (section.kind === 'empty') {
    return null;
  }
  return (
    <div className="flex flex-col gap-2">
      {heading && <h3 className="text-sm font-semibold">{heading}</h3>}
      {section.connective && <p className="text-sm">{section.connective}</p>}
      {section.kind === 'claims' && (
        <ul className="flex flex-col gap-3">
          {section.claims.map((claim) => (
            <li key={claim.id}>
              <ClaimAtomLine claim={claim} />
            </li>
          ))}
        </ul>
      )}
      {section.kind === 'abstained' && (
        <p className="text-sm text-muted-foreground">
          {t('shared.evidence.abstained', { count: section.gamesNeeded })}
        </p>
      )}
    </div>
  );
}

/** The same section in the `print:block` rendering — kept in lockstep with `ScreenClaimSection` so print/PDF output carries the same app-rendered figures (T-39-09-02). */
function PrintClaimSection({
  heading,
  section,
}: {
  heading: string | null;
  section: ResolvedClaimSection;
}) {
  const { t } = useTranslation();
  if (section.kind === 'empty') {
    return null;
  }
  return (
    <div data-print-claim-section="">
      {heading && <h2 className="mt-4 text-lg font-semibold">{heading}</h2>}
      {section.connective && <p>{section.connective}</p>}
      {section.kind === 'claims' && (
        <ul>
          {section.claims.map((claim) => (
            <li key={claim.id} className="mt-2">
              <ClaimAtomLine claim={claim} />
            </li>
          ))}
        </ul>
      )}
      {section.kind === 'abstained' && (
        <p>{t('shared.evidence.abstained', { count: section.gamesNeeded })}</p>
      )}
    </div>
  );
}

/**
 * Renders one AI-generated scouting report (V7-B). Used both for a freshly
 * generated report and for a persisted/past report — same component either
 * way, since both are just a `ScoutReportRecord`.
 *
 * V7-B.1 additions:
 * - A "Generated <relative date>" line (the record's `createdAt`).
 * - Download (.md) and Print/Save-as-PDF affordances. Print reuses the
 *   `.print-packet-root` print-media rule (see `apps/web/src/index.css`,
 *   originally built for the Opponents page's H2H evidence packet) — a
 *   second, on-screen-hidden rendering of the report is included below so
 *   `window.print()` shows only this content, not app chrome or the other
 *   scout cards.
 * - A `characterStrategy` section, co-equal with stage strategy. Optional on
 *   the stored-record schema (pre-V7-B.1 reports lack it) — omitted here
 *   when absent rather than rendering an empty section.
 *
 * Phase 30.3 (Gate 6): Download/Print disabled-with-explanation for a demo/
 * research account (owner/Codex hard gate) — the same download/print class
 * of affordance gated on `/opponents`' H2H export and `/match-data`'s CSV
 * export.
 *
 * Phase 39 (plan 39-09, RPT-06): a claims-era record (the stored `sections`
 * map present) renders its overview / game plan / watch-for sections as
 * claim-anchored bullets — every figure from the stored claim object, never
 * from the model's prose — on screen AND in the print block. A legacy record
 * (no `sections`) keeps the free-prose rendering unchanged. The paid prep card
 * (`PrepPaidReportsCard`) reuses this component verbatim and inherits both.
 * `confidenceNotes` is `''` on every claims-era record (D-03 moved confidence
 * onto each claim's tier phrase), so its line — screen and print — renders
 * only when non-empty; the stage reasoning, which plan 39-06's projection
 * fills with the game-plan connective, is not restated on a claims-era record.
 *
 * Phase 39 (plan 39-10, RPT-10): a record that is not validated (no
 * `claimSchemaVersion` / passed `validation` — see `isValidatedRecord`)
 * carries the legacy provenance line under the "Generated" caption.
 */
export function ScoutAiReportCard({ record }: { record: ScoutReportRecord }) {
  const { t } = useTranslation();
  const { report } = record;
  const isDemoAccount = useIsDemoAccount();
  const claimsEra = isClaimsEraReport(report);
  const overviewClaims = claimsEra
    ? withoutConnective(resolveClaimSection(report.sections?.overview, report.claims))
    : null;
  const gameplanClaims = claimsEra
    ? resolveClaimSection(report.sections?.gameplan, report.claims)
    : null;
  const watchForClaims = claimsEra
    ? resolveClaimSection(report.sections?.watchFor, report.claims)
    : null;
  const stageReasoning = claimsEra ? '' : report.stageStrategy.reasoning;
  const hasStageStrategy =
    report.stageStrategy.bans.length > 0 ||
    report.stageStrategy.picks.length > 0 ||
    stageReasoning.trim().length > 0;
  const hasConfidenceNotes = report.confidenceNotes.trim().length > 0;

  return (
    <>
      <Card className="border-primary/30 bg-primary/5 print:hidden">
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Sparkles className="size-4 text-primary" />
            {t('scout.aiReport.title')}
          </CardTitle>
          {report.overview && <CardDescription>{report.overview}</CardDescription>}
          <p className="text-xs text-muted-foreground">
            {t('scout.aiReport.generated', { rel: formatRelativeDate(record.createdAt, t) })}
          </p>
          <LegacyReportBadge
            variant="card"
            claimSchemaVersion={report.claimSchemaVersion}
            validation={report.validation}
          />
        </CardHeader>
        <CardContent className="flex flex-col gap-5">
          <div className="flex flex-wrap items-center gap-2">
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => downloadMarkdown(record)}
              disabled={isDemoAccount}
              title={isDemoAccount ? t('demo.disabledReason') : undefined}
            >
              <Download />
              {t('scout.aiReport.download')}
            </Button>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => window.print()}
              disabled={isDemoAccount}
              title={isDemoAccount ? t('demo.disabledReason') : undefined}
            >
              <Printer />
              {t('scout.aiReport.print')}
            </Button>
          </div>

          {overviewClaims && <ScreenClaimSection heading={null} section={overviewClaims} />}

          {gameplanClaims ? (
            <ScreenClaimSection heading={t('scout.aiReport.gameplan')} section={gameplanClaims} />
          ) : (
            <div className="flex flex-col gap-2">
              <h3 className="text-sm font-semibold">{t('scout.aiReport.gameplan')}</h3>
              <ul className="list-disc space-y-1 pl-5 text-sm">
                {report.gameplan.map((item, index) => (
                  <li key={index}>{item}</li>
                ))}
              </ul>
            </div>
          )}

          {report.characterStrategy && (
            <div className="flex flex-col gap-2">
              <h3 className="text-sm font-semibold">{t('scout.aiReport.characterStrategy')}</h3>
              <div className="flex flex-col gap-2 text-sm">
                {report.characterStrategy.picks.length > 0 && (
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-muted-foreground">{t('scout.aiReport.picks')}</span>
                    {report.characterStrategy.picks.map((character) => (
                      <Badge key={character} variant="success">
                        {character}
                      </Badge>
                    ))}
                  </div>
                )}
                <p className="text-muted-foreground">{report.characterStrategy.reasoning}</p>
              </div>
            </div>
          )}

          {hasStageStrategy && (
            <div className="flex flex-col gap-2">
              <h3 className="text-sm font-semibold">{t('scout.aiReport.stageStrategy')}</h3>
              <div className="flex flex-col gap-2 text-sm">
                {report.stageStrategy.bans.length > 0 && (
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-muted-foreground">{t('scout.aiReport.bans')}</span>
                    {report.stageStrategy.bans.map((stage) => (
                      <Badge key={stage} variant="destructive">
                        {stage}
                      </Badge>
                    ))}
                  </div>
                )}
                {report.stageStrategy.picks.length > 0 && (
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-muted-foreground">{t('scout.aiReport.picks')}</span>
                    {report.stageStrategy.picks.map((stage) => (
                      <Badge key={stage} variant="success">
                        {stage}
                      </Badge>
                    ))}
                  </div>
                )}
                {stageReasoning && <p className="text-muted-foreground">{stageReasoning}</p>}
              </div>
            </div>
          )}

          {report.headToHead && (
            <div className="flex flex-col gap-2">
              <h3 className="text-sm font-semibold">{t('scout.aiReport.headToHead')}</h3>
              <p className="text-sm text-muted-foreground">{report.headToHead}</p>
            </div>
          )}

          {watchForClaims ? (
            <ScreenClaimSection heading={t('scout.aiReport.watchFor')} section={watchForClaims} />
          ) : (
            <div className="flex flex-col gap-2">
              <h3 className="text-sm font-semibold">{t('scout.aiReport.watchFor')}</h3>
              <ul className="list-disc space-y-1 pl-5 text-sm">
                {report.watchFor.map((item, index) => (
                  <li key={index}>{item}</li>
                ))}
              </ul>
            </div>
          )}

          {hasConfidenceNotes && (
            <p className="text-xs text-muted-foreground">{report.confidenceNotes}</p>
          )}
        </CardContent>
      </Card>

      <div className="print-packet-root hidden print:block">
        <h1 className="text-2xl font-bold">
          Scout Report: {record.player.gamerTag} — {new Date(record.createdAt).toLocaleDateString()}
        </h1>

        {(report.overview || (overviewClaims && overviewClaims.kind !== 'empty')) && (
          <h2 className="mt-4 text-lg font-semibold">Overview</h2>
        )}
        {report.overview && <p>{report.overview}</p>}
        {overviewClaims && <PrintClaimSection heading={null} section={overviewClaims} />}

        {gameplanClaims ? (
          <PrintClaimSection heading="Game plan" section={gameplanClaims} />
        ) : (
          <>
            <h2 className="mt-4 text-lg font-semibold">Game plan</h2>
            <ul>
              {report.gameplan.map((item, index) => (
                <li key={index}>{item}</li>
              ))}
            </ul>
          </>
        )}

        {report.characterStrategy && (
          <>
            <h2 className="mt-4 text-lg font-semibold">Character strategy</h2>
            {report.characterStrategy.picks.length > 0 && (
              <p>Picks: {report.characterStrategy.picks.join(', ')}</p>
            )}
            <p>{report.characterStrategy.reasoning}</p>
          </>
        )}

        {hasStageStrategy && (
          <>
            <h2 className="mt-4 text-lg font-semibold">Stage strategy</h2>
            {report.stageStrategy.bans.length > 0 && (
              <p>Bans: {report.stageStrategy.bans.join(', ')}</p>
            )}
            {report.stageStrategy.picks.length > 0 && (
              <p>Picks: {report.stageStrategy.picks.join(', ')}</p>
            )}
            {stageReasoning && <p>{stageReasoning}</p>}
          </>
        )}

        {report.headToHead && (
          <>
            <h2 className="mt-4 text-lg font-semibold">Head-to-head</h2>
            <p>{report.headToHead}</p>
          </>
        )}

        {watchForClaims ? (
          <PrintClaimSection heading="Watch for" section={watchForClaims} />
        ) : (
          <>
            <h2 className="mt-4 text-lg font-semibold">Watch for</h2>
            <ul>
              {report.watchFor.map((item, index) => (
                <li key={index}>{item}</li>
              ))}
            </ul>
          </>
        )}

        {hasConfidenceNotes && (
          <>
            <h2 className="mt-4 text-lg font-semibold">Confidence notes</h2>
            <p>{report.confidenceNotes}</p>
          </>
        )}
      </div>
    </>
  );
}
