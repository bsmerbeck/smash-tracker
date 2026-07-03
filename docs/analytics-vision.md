# Smash Tracker V3 — Analytics Vision

Goal: the best personal analytics dashboard for Super Smash Bros. Ultimate — casual + competitive
in one place, evidence-aware, visually Smash. This doc is the source of truth for the V3 phases.

## What we have (data foundations)

Every match record: your character, opponent character, human opponent tag, stage, matchType
(quickplay/friendlies/tourney × online/offline), win/loss, timestamp, source (manual | startgg).
Live dataset: 391 real records (284 manual 2020-21, 107 imported tournament games 2020-21).

## Design pillars

1. **Global analytics context, not per-page toggles.** One persistent control surface (topbar):
   - Source: All | Casual (manual) | Competitive (start.gg imports)
   - Time range: All time | 3m | 6m | 12m
     Persisted in localStorage, honored by EVERY page (Dashboard, Fighter Analysis, Matchups,
     Match Data). Replaces the per-page SourceFilterTabs.
2. **Answer real competitive questions.** Who beats me and how? What should I counterpick vs
   Sonic? Am I improving? Online vs offline delta? What do I actually get taken to game 5 on?
3. **Evidence-aware statistics.** Every rate displays its sample size. Rankings (best/worst
   matchup, best stage) sort by the **Wilson score lower bound** (95%) rather than raw win rate,
   so a 1-0 record never outranks 12-3. Raw rate stays visible; the ranking just stops lying.
4. **Smash visual identity.** Fighter sprites and stage art are first-class: stage pictures in
   the stage selects (the legacy behavior, restored) and stage tiles in analytics. Stages
   without art get a styled fallback tile.

## Feature map by phase

### Phase A — foundations + quick wins (first PR)

- **Stage pictures in selects**: StageSelect options (match form + stage breakdown pickers)
  render the stage thumbnail beside the name, like legacy; most-used stages surface first
  (usage-ordered options with art). Fallback tile for stages lacking assets.
- **Global AnalyticsContext**: source + time-range filters in the topbar, persisted, wired into
  all four data pages; SourceFilterTabs removed from Match Data in favor of the global control.
- Housekeeping: sync summary counts unique keys (fixes 112-vs-107), Integrations "Connected"
  badge uses the success variant, this doc lands as docs/analytics-vision.md.

### Phase B — stats engine v2 (pure, tested library work)

- `wilsonLowerBound(wins, total)` + evidence-ranked variants of matchup/stage rankings.
- `getRollingWinRate(matches, window)` — form curve, replaces cumulative-only series.
- `getMonthlyRecords`, `getOnlineOfflineSplit`, `getSessionStats` (gap-based session grouping,
  tilt = intra-session loss streaks), `getStageUsage` (for most-used ordering everywhere).
- `getOpponentProfile(tag)` — H2H timeline, their character usage vs you, stages, recent form.
- Matchup matrix builder: your-fighters × opponent-fighters grid with records + Wilson rank.
- Import enrichment: sync also stores optional `eventName`/`tournamentName` on imported
  matches (schema additions, optional) → unlocks per-tournament views. Requires one resync.

### Phase C — Dashboard home redesign

Hero row (record, last-10 form pips, current streak, competitive-vs-casual delta) → rolling
win-rate chart with window selector → most-played stages as art tiles with win rates →
Wilson-ranked best/worst matchup snapshot cards linking into the Matchup Lab.

### Phase D — Matchup Lab (Matchups page evolution)

- **Matchup matrix heatmap**: all your fighters × faced opponents, cell color = evidence-adjusted
  win rate, cell click opens the pairing detail.
- Pairing detail: existing insights + **stage counterpick advisor** (ranked stage suggestions vs
  that character, with art and sample sizes) + per-human-opponent splits + rolling trend.

### Phase E — Opponent scouting

Per human opponent: H2H record + timeline, what they play against you (your record per their
character), stages they take you to, recent encounters. Searchable list ranked by games played.

### Phase F — Trends & tournaments

Monthly performance chart, matchType splits over time, per-tournament results (from Phase B's
event fields), online/offline comparison view.

### Phase G — deploy + polish

Production deploy, resync for event fields, live verification, README/screenshot refresh.

## Non-goals (this epic)

Paywalled agentic opponent analysis (separate backlog), Sora roster addition (separate task),
multi-game support, public/shared profiles.
