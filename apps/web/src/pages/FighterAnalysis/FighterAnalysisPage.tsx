import { useMemo, useState } from 'react';
import { Link } from 'react-router';
import type { Fighter } from '@smash-tracker/shared';
import { Button } from '@/components/ui/button';
import { useFighters } from '@/hooks/useFighters';
import { useMatches } from '@/hooks/useMatches';
import { getFighterById } from '@/data/sprites';
import { SelectFighter } from './components/SelectFighter';
import { StreakCard } from './components/StreakCard';
import { BestWorstMap } from './components/BestWorstMap';
import { BestWorstMatchupCards } from './components/BestWorstMatchupCards';
import { MatchupStageGuide } from './components/MatchupStageGuide';
import { PerformanceSnapshot } from './components/PerformanceSnapshot';
import { OpponentTable } from './components/OpponentTable';

/** Ports legacy/src/screens/FighterAnalysis. */
export function FighterAnalysisPage() {
  const { data: fighterSelection, isLoading: fightersLoading } = useFighters();
  const { data: matches = [], isLoading: matchesLoading } = useMatches();

  const fighterSprites = useMemo<Fighter[]>(() => {
    const ids = [...(fighterSelection?.primary ?? []), ...(fighterSelection?.secondary ?? [])];
    return ids
      .map((id) => getFighterById(id))
      .filter((sprite): sprite is Fighter => sprite != null);
  }, [fighterSelection]);

  const [selectedFighterId, setSelectedFighterId] = useState<number | undefined>(undefined);
  const fighter =
    fighterSprites.find((s) => s.id === selectedFighterId) ?? fighterSprites[0] ?? undefined;

  if (fightersLoading || matchesLoading) {
    return <div className="text-muted-foreground">Loading fighter analysis...</div>;
  }

  if (fighterSprites.length === 0) {
    return (
      <div className="flex flex-col items-center gap-4 py-16 text-center">
        <h1 className="text-2xl font-semibold tracking-tight">
          You haven&apos;t picked any fighters yet!
        </h1>
        <p className="max-w-md text-muted-foreground">
          Choose your primary and secondary fighters to start tracking analysis.
        </p>
        <div className="flex flex-wrap justify-center gap-2">
          <Button asChild>
            <Link to="/choose-primary">Choose Primary Fighters</Link>
          </Button>
          <Button asChild variant="outline">
            <Link to="/choose-secondary">Choose Secondary Fighters</Link>
          </Button>
        </div>
      </div>
    );
  }

  if (matches.length === 0) {
    return (
      <div className="flex flex-col items-center gap-2 py-16 text-center">
        <h2 className="text-xl font-semibold tracking-tight">
          You haven&apos;t reported any matches!
        </h2>
        <p className="text-muted-foreground">
          Report a match on the Dashboard and check back here.
        </p>
        <Button asChild className="mt-2">
          <Link to="/dashboard">Go to Dashboard</Link>
        </Button>
      </div>
    );
  }

  const fighterMatches = fighter ? matches.filter((m) => m.fighter_id === fighter.id) : [];

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col items-center gap-2 text-center">
        <h1 className="text-2xl font-semibold tracking-tight">Fighter Analysis</h1>
        <SelectFighter
          fighter={fighter}
          fighterSprites={fighterSprites}
          onChange={(next) => setSelectedFighterId(next.id)}
        />
      </div>

      <BestWorstMatchupCards fighterMatches={fighterMatches} />

      <div className="flex flex-col gap-4 lg:flex-row">
        <BestWorstMap fighterMatches={fighterMatches} />
        <StreakCard fighterMatches={fighterMatches} />
        <PerformanceSnapshot fighterMatches={fighterMatches} />
      </div>

      <MatchupStageGuide fighterMatches={fighterMatches} />

      <OpponentTable fighterMatches={fighterMatches} />
    </div>
  );
}
