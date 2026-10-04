import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router';
import { useTranslation } from 'react-i18next';
import {
  confidenceTierFor,
  resolveWindow,
  type HorizonKey,
  type Match,
} from '@smash-tracker/shared';
import { Card, CardContent } from '@/components/ui/card';
import { FormStrip } from '@/components/charts/FormStrip';
import { Record } from '@/components/analytics/Record';
import { TILE_CARD_CLASS, TILE_CONTENT_CLASS } from '@/components/analytics/cardDensity';
import {
  FORM_STRIP_EMPTY_WINDOW,
  buildFormStripEvents,
  formStripLabels,
} from '@/lib/formStripEvents';
import { buildDrillDownSearch } from '@/lib/drillDownParams';
import { localizedFighterName } from '@/lib/fighterNames';
import { useSubjectPath } from '@/hooks/useSubjectPath';
import { useDashboardContext } from '../DashboardContext';

/** UI-SPEC §9.1 / DD-41-04: the Dashboard strip draws at most the selected fighter's last 30 games. */
const DASHBOARD_STRIP_LIMIT = 30;

/**
 * Plan 41-10 (CHRT-03, parent §12 row 10, DD-41-03 / DD-41-04): the Dashboard's
 * form strip tile — the selected fighter's last 30 games grouped event -> set
 * -> game, replacing the chart.js Form Curve. It states no headline figure
 * (the hero owns those): the head is the strip's overline + swatch legend, the
 * foot is the strip's shown-of line plus one support line, the record of the
 * games the strip actually draws.
 *
 * The game set never changes with the page horizon — only its emphasis does
 * (UI-SPEC §7.4): `last30` dims nothing; `lastEvent` / `last90` emphasise the
 * games inside that window and draw the rest at 32%. `matches` already carries
 * the page's range / source filter. A set is the tab stop and click target: it
 * opens Fighter Analysis' `#games` list narrowed to exactly that set, under the
 * active subject's path prefix.
 */
export function FormStripTile({ matches, horizon }: { matches: Match[]; horizon: HorizonKey }) {
  const { t, i18n } = useTranslation();
  const { fighter } = useDashboardContext();
  const navigate = useNavigate();
  const subjectPath = useSubjectPath();
  // The window's "now" is fixed for the page's life (the codebase's lazy
  // initializer pattern) so a re-render never shifts the last-90-days edge.
  const [nowMs] = useState(() => Date.now());

  const fighterMatches = useMemo(
    () => (fighter ? matches.filter((m) => m.fighter_id === fighter.id) : []),
    [matches, fighter],
  );

  const emphasisWindow = useMemo(() => {
    if (horizon === 'last30') {
      return { fromMs: null, toMs: null };
    }
    const { window } = resolveWindow({ matches: fighterMatches, horizon, scoped: false, nowMs });
    if (window.games === 0 || window.fromMs == null || window.toMs == null) {
      return FORM_STRIP_EMPTY_WINDOW;
    }
    return { fromMs: window.fromMs, toMs: window.toMs };
  }, [fighterMatches, horizon, nowMs]);

  const events = useMemo(
    () => buildFormStripEvents(fighterMatches, emphasisWindow, t, i18n.language),
    [fighterMatches, emphasisWindow, t, i18n.language],
  );

  const title = t(`dashboard.formStrip.title.${horizon}`);
  const emptyText = t('dashboard.formStrip.empty', {
    fighter: fighter ? localizedFighterName(fighter.id, t) : '',
  });

  if (!fighter || fighterMatches.length === 0) {
    return (
      <Card className={TILE_CARD_CLASS}>
        <CardContent className={TILE_CONTENT_CLASS}>
          <div data-slot="form-strip-tile" className="flex min-w-0 flex-col gap-2">
            <p
              data-slot="form-strip-overline"
              className="text-[0.6875rem] leading-4 font-semibold tracking-wider text-muted-foreground uppercase"
            >
              {title}
            </p>
            <p className="text-sm text-muted-foreground">{emptyText}</p>
          </div>
        </CardContent>
      </Card>
    );
  }

  // Window-empty (UI-SPEC §7.4): the horizon's window holds none of the
  // fighter's games, so every tick is dimmed and the foot says why. The page's
  // `last30` window is never empty here (there is at least one game).
  const windowEmpty = emphasisWindow === FORM_STRIP_EMPTY_WINDOW;

  return (
    <Card className={TILE_CARD_CLASS}>
      <CardContent className={TILE_CONTENT_CLASS}>
        <div data-slot="form-strip-tile" className="min-w-0">
          <FormStrip
            events={events}
            limit={DASHBOARD_STRIP_LIMIT}
            labels={{
              ...formStripLabels(t),
              // WR-03: names the games actually DRAWN of the total (kit-computed).
              summary: ({ shown, total }) => t('analytics.strip.aria', { count: total, shown }),
              title,
              empty: <span>{emptyText}</span>,
              windowNote: windowEmpty ? t(`dashboard.formStrip.windowEmpty.${horizon}`) : undefined,
              drawn: ({ wins, losses, sets }) => {
                const tier = confidenceTierFor(wins + losses);
                return (
                  <span className="inline-flex flex-wrap items-baseline gap-x-1.5">
                    <Record
                      wins={wins}
                      losses={losses}
                      locale={i18n.language}
                      cueLabel={
                        tier
                          ? t(`shared.evidence.sampleCueGlyph.${tier}`, { count: wins + losses })
                          : undefined
                      }
                    />
                    <span aria-hidden="true">&middot;</span>
                    <span>{t('dashboard.formStrip.sets', { count: sets })}</span>
                  </span>
                );
              },
            }}
            onSelectSet={(setKey) =>
              navigate(
                subjectPath(
                  `/fighter-analysis?${buildDrillDownSearch({ fighterId: fighter.id, eventKey: setKey }).toString()}#games`,
                ),
              )
            }
          />
        </div>
      </CardContent>
    </Card>
  );
}
