import { useState } from 'react';
import { Link } from 'react-router';
import {
  ASSUMED_MMR_POINTS_PER_MATCH,
  GSP_MODEL,
  MAX_PROJECTED_MATCHES,
  eliteThresholdGsp,
  estimateT,
  gspToMmr,
  projectMatchesToEliteMmr,
} from '@smash-tracker/shared';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { PublicLayout } from '@/layouts/PublicLayout';
import { useSeo } from '@/hooks/useSeo';
import { useNowMs } from '@/pages/Gsp/lib/useNowMs';
import { parseGspInput } from './lib/parseGspInput';

const DEFAULT_WIN_RATE_PERCENT = 50;

/**
 * Public, interactive Elite Smash GSP calculator (V12 SEO) — the
 * `/gsp-calculator` landing surface for searches like "how much GSP for
 * Elite Smash" and "GSP to MMR". Computes everything client-side from
 * `@smash-tracker/shared`'s reverse-engineered GSP<->MMR model
 * (packages/shared/src/gspMmr.ts) at the CURRENT time — unlike the authed
 * GSP page, there's no logged-in user or saved Elite-threshold calibration
 * here, so every estimate uses the model's built-in anchor
 * (`estimateT(now)` with no `TCalibration`).
 */
export function GspCalculatorPage() {
  // V12 SEO: base title is 55 chars; appending " | Smash Tracker" (16 more)
  // would push it to 71 — over the ~65-char threshold search results
  // typically render before truncating — so the brand suffix is dropped here.
  const title = 'Elite Smash GSP Calculator — GSP to MMR & Road to Elite';
  useSeo({
    title,
    description:
      'Free calculator for the current Elite Smash GSP threshold, GSP to MMR conversion, and matches-to-Elite for Super Smash Bros. Ultimate quickplay.',
    canonicalPath: '/gsp-calculator',
  });

  const nowMs = useNowMs();
  const t = estimateT(nowMs);
  const eliteThreshold = Math.round(eliteThresholdGsp(t));

  const [gspInput, setGspInput] = useState('');
  const [winRatePercent, setWinRatePercent] = useState(DEFAULT_WIN_RATE_PERCENT);

  const parsedGsp = gspInput.trim() === '' ? null : parseGspInput(gspInput);
  const isInvalid = gspInput.trim() !== '' && parsedGsp === null;

  const mmrResult = parsedGsp !== null ? gspToMmr(parsedGsp, t) : null;
  const roundedMmr = mmrResult !== null ? Math.round(mmrResult.mmr) : null;
  const isElite = roundedMmr !== null && roundedMmr >= GSP_MODEL.ELITE_MMR;

  const projection =
    roundedMmr !== null ? projectMatchesToEliteMmr(roundedMmr, winRatePercent / 100) : null;

  return (
    <PublicLayout>
      <div className="mx-auto flex w-full max-w-3xl flex-col gap-10 px-4 py-12">
        <div className="flex flex-col items-center gap-3 text-center">
          <h1 className="text-3xl font-bold tracking-tight">Elite Smash GSP Calculator</h1>
          <p className="max-w-xl text-muted-foreground">
            Enter your current GSP to estimate your hidden MMR, see today&apos;s Elite Smash entry
            threshold, and project how many matches until you reach it.
          </p>
        </div>

        <Card>
          <CardHeader>
            <CardTitle className="text-base">Current Elite Smash GSP threshold</CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-1">
            <span className="text-4xl font-bold">{eliteThreshold.toLocaleString()}</span>
            <p className="text-sm text-muted-foreground">
              GSP needed to enter Elite Smash right now, estimated live from a community-calibrated
              model (see &ldquo;How the Elite Smash threshold works&rdquo; below) — it rises over
              time, so this number is higher than it was last month.
            </p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-base">Check your GSP</CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-5">
            <div className="flex flex-col gap-1.5">
              <label htmlFor="gsp-input" className="text-sm font-medium">
                Your current GSP
              </label>
              {/* type="text": tolerates comma pastes from elitegsp.com / the
                  game's own results screen, and "6.3m" shorthand — see
                  parseGspInput. */}
              <Input
                id="gsp-input"
                type="text"
                inputMode="numeric"
                placeholder="e.g. 10,300,000 or 10.3m"
                value={gspInput}
                onChange={(e) => setGspInput(e.target.value)}
                aria-invalid={isInvalid}
                className="max-w-xs"
              />
              {isInvalid && (
                <p className="text-xs text-destructive">
                  Enter a whole number — commas and shorthand like &ldquo;6.3m&rdquo; are fine.
                </p>
              )}
            </div>

            <div className="flex flex-col gap-1.5">
              <label htmlFor="win-rate-input" className="text-sm font-medium">
                Recent win rate: {winRatePercent}%
              </label>
              <input
                id="win-rate-input"
                type="range"
                min={0}
                max={100}
                step={1}
                value={winRatePercent}
                onChange={(e) => setWinRatePercent(Number(e.target.value))}
                className="w-full max-w-xs accent-primary"
              />
            </div>
          </CardContent>
        </Card>

        {roundedMmr !== null && mmrResult !== null && (
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <Card>
              <CardHeader>
                <CardTitle className="text-sm font-medium text-muted-foreground">
                  Estimated hidden MMR
                </CardTitle>
              </CardHeader>
              <CardContent className="flex flex-col gap-1">
                <span className="text-3xl font-bold">{roundedMmr.toLocaleString()}</span>
                {mmrResult.zone !== 'main' && (
                  <p className="text-xs font-medium text-amber-500">
                    {mmrResult.zone}-tail estimate &mdash; approximate
                  </p>
                )}
                <p className="text-xs text-muted-foreground">
                  &plusmn;1 GSP in the main curve (MMR 600&ndash;1400); tails approximate
                </p>
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle className="text-sm font-medium text-muted-foreground">
                  Distance to Elite
                </CardTitle>
              </CardHeader>
              <CardContent className="flex flex-col gap-1">
                {isElite ? (
                  <span className="w-fit rounded-full bg-emerald-500/15 px-2 py-0.5 text-sm font-semibold text-emerald-500">
                    ELITE
                  </span>
                ) : (
                  <>
                    <span className="text-3xl font-bold">
                      {(GSP_MODEL.ELITE_MMR - roundedMmr).toLocaleString()} MMR
                    </span>
                    <p className="text-xs text-muted-foreground">
                      &asymp;{Math.max(0, Math.round(eliteThreshold - parsedGsp!)).toLocaleString()}{' '}
                      GSP below today&apos;s threshold ({eliteThreshold.toLocaleString()})
                    </p>
                  </>
                )}
              </CardContent>
            </Card>
          </div>
        )}

        {projection !== null && (
          <Card>
            <CardHeader>
              <CardTitle>Road to Elite</CardTitle>
            </CardHeader>
            <CardContent className="flex flex-col gap-3">
              {projection.status === 'already-elite' ? (
                <p className="text-lg font-semibold text-emerald-500">
                  You&apos;re already in Elite Smash!
                </p>
              ) : projection.status === 'equilibrium' ? (
                <>
                  <p className="text-lg font-semibold">Holding steady at your level</p>
                  <p className="text-sm text-muted-foreground">
                    At a {winRatePercent}% win rate, matchmaking thinks this is your level right now
                    &mdash; every match trades ~{ASSUMED_MMR_POINTS_PER_MATCH} MMR both ways, so a
                    &gt;50% win rate is what moves you up, not more matches.
                  </p>
                </>
              ) : projection.status === 'capped' ? (
                <>
                  <p className="text-2xl font-bold">more than {MAX_PROJECTED_MATCHES} net wins</p>
                  <p className="text-sm text-muted-foreground">
                    Your win rate is barely above 50%, so expected progress per match is tiny.
                  </p>
                </>
              ) : (
                <>
                  <p className="text-2xl font-bold">
                    ~{projection.matchesNeeded} more match
                    {projection.matchesNeeded === 1 ? '' : 'es'}
                  </p>
                  <p className="text-sm text-muted-foreground">
                    to Elite (MMR {GSP_MODEL.ELITE_MMR}) at your ~{ASSUMED_MMR_POINTS_PER_MATCH}{' '}
                    MMR/match and {winRatePercent}% win rate (community model estimate)
                  </p>
                </>
              )}
            </CardContent>
          </Card>
        )}

        <div className="flex flex-col gap-8 text-sm text-muted-foreground">
          <section aria-labelledby="what-is-gsp-heading" className="flex flex-col gap-2">
            <h2 id="what-is-gsp-heading" className="text-lg font-semibold text-foreground">
              What is GSP?
            </h2>
            <p>
              GSP (Global Smash Power) is Super Smash Bros. Ultimate&apos;s online quickplay ranking
              number, tracked separately for every character. It rises when you win and falls when
              you lose, and climbing high enough on a character puts that character&apos;s quickplay
              matchmaking into Elite Smash &mdash; the game&apos;s top online bracket.
            </p>
          </section>

          <section aria-labelledby="threshold-heading" className="flex flex-col gap-2">
            <h2 id="threshold-heading" className="text-lg font-semibold text-foreground">
              How the Elite Smash threshold works
            </h2>
            <p>
              Nintendo never publishes an exact GSP number for Elite Smash entry, and the real
              threshold rises over time as more of the population climbs &mdash; a number that was
              accurate last month is too low today. This calculator estimates the LIVE threshold
              from a community-calibrated model of the hidden matchmaking rating (MMR) behind GSP,
              rather than showing a fixed, stale number.
            </p>
          </section>

          <section aria-labelledby="how-it-works-heading" className="flex flex-col gap-2">
            <h2 id="how-it-works-heading" className="text-lg font-semibold text-foreground">
              How this calculator works
            </h2>
            <p>
              Nintendo maintains a hidden, roughly Elo-like MMR per character, and the GSP shown on
              the results screen is a rank-transform of that MMR: a slowly-rising curve in the
              middle of the population, flattening into approximate linear tails at the extremes.
              This calculator inverts that transform to estimate your MMR from a GSP reading, and
              projects matches to Elite from your estimated MMR and recent win rate.
            </p>
            <p>
              This is a community reverse-engineered model, not Nintendo&apos;s published algorithm
              &mdash; treat every number here as an estimate (typically within a few GSP in the main
              curve, less precise in the tails), not a guarantee. Smash Tracker is not affiliated
              with or endorsed by Nintendo.
            </p>
          </section>
        </div>

        <Card className="border-primary/30 bg-primary/5">
          <CardContent className="flex flex-col items-center gap-3 py-4 text-center">
            <h2 className="text-lg font-semibold">Track your GSP automatically</h2>
            <p className="max-w-md text-sm text-muted-foreground">
              Log matches on Smash Tracker and this same model charts your climb per character,
              tracks your win rate, and updates your Road to Elite projection as you play &mdash;
              free.
            </p>
            <Button asChild>
              <Link to="/">Sign up free</Link>
            </Button>
          </CardContent>
        </Card>

        <script type="application/ld+json">{JSON.stringify(webApplicationJsonLd())}</script>
      </div>
    </PublicLayout>
  );
}

/** WebApplication JSON-LD — this page is a free interactive tool, distinct from the SoftwareApplication JSON-LD on `/`. */
function webApplicationJsonLd() {
  return {
    '@context': 'https://schema.org',
    '@type': 'WebApplication',
    name: 'Elite Smash GSP Calculator',
    url: 'https://grandfinals.gg/gsp-calculator',
    applicationCategory: 'GameApplication',
    offers: {
      '@type': 'Offer',
      price: '0',
      priceCurrency: 'USD',
    },
  };
}
