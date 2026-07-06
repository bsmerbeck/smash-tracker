import { Info } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  Popover,
  PopoverContent,
  PopoverHeader,
  PopoverTitle,
  PopoverTrigger,
} from '@/components/ui/popover';

/**
 * Shared plain-English explainer for the Glicko-2 rating system, rendered
 * identically from both the Dashboard Rating card and the Trends Rating
 * Curve header (V9-C) so the two call sites never drift out of sync. An
 * `Info` icon trigger opens a Popover (chosen over Tooltip per house
 * precedent — this much copy reads poorly in a hover-only tooltip).
 */
export function GlickoExplainer() {
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          aria-label="What is Glicko-2?"
          className="shrink-0 text-muted-foreground hover:text-foreground"
        >
          <Info className="size-4" />
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-80 text-sm">
        <PopoverHeader>
          <PopoverTitle>What is Glicko-2?</PopoverTitle>
          <p>
            <strong>Glicko-2</strong> is the rating system used in chess and by many competitive
            ladders. Unlike a raw win rate, it weighs <em>who</em> you beat and how surprising the
            result was.
          </p>
          <p>
            The <strong>±number (RD)</strong> is uncertainty: it shrinks as you play more and grows
            when you&apos;re inactive — so a 1500 ±50 player is proven, a 1500 ±300 player is
            unknown.
          </p>
          <p>
            We use it because bracket play is bursty: Glicko-2 handles long gaps between tournaments
            and small samples far better than Elo or win-rate alone. Ratings here are unofficial and
            computed only from your synced/logged games.
          </p>
        </PopoverHeader>
      </PopoverContent>
    </Popover>
  );
}
