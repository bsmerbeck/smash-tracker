import React from "react";
import { StageSelect, BreakdownResults } from "./components";
import { useSelector } from "react-redux";
import { isLoaded } from "react-redux-firebase";
import { SpriteList } from "../../../../components/Sprites/SpriteList";

/*eslint no-extend-native: ["error", { "exceptions": ["Array"] }]*/
Array.prototype.byWin = function () {
  let itm,
    a = [],
    L = this.length,
    o = {};
  for (let i = 0; i < L; i++) {
    itm = this[i].opponent_id;
    if (!itm) continue;
    if (o[itm] === undefined) {
      if (this[i].win) {
        o[itm] = 1;
      }
    } else if (this[i].win) {
      ++o[itm];
    }
  }
  for (let p in o) a[a.length] = p;
  return a.sort(function (a, b) {
    return o[b] - o[a];
  });
};

Array.prototype.byLoss = function () {
  let itm,
    a = [],
    L = this.length,
    o = {};
  for (let i = 0; i < L; i++) {
    itm = this[i].opponent_id;
    if (!itm) continue;
    if (o[itm] === undefined) {
      if (!this[i].win) {
        o[itm] = 1;
      }
    } else if (!this[i].win) {
      ++o[itm];
    }
  }
  for (let p in o) a[a.length] = p;
  return a.sort(function (a, b) {
    return o[b] - o[a];
  });
};

const StageBreakdown = (props) => {
  const { auth } = props;

  const [stage, setStage] = React.useState({ id: 0, name: "no selection" });

  // check for matches, if none return cancel
  const matches = useSelector((state) => state.firebase.data.matches);

  if (!isLoaded(matches) || matches[auth.uid] === null) {
    return <div />;
  }

  // query based on stage total win/ loss/ win rate %
  const entries = Object.keys(matches[auth.uid]);
  const real_matches = entries.map((e) => {
    let matchData = matches[auth.uid][e];
    if (!matchData.map) {
      matchData.map = { id: 0, name: "no selection" };
    }
    return matchData;
  });
  const stage_matches = real_matches.filter((rm) => rm.map.id === stage.id);
  const matches_by_win = stage_matches.filter((m) => m.win === true);
  const matches_by_loss = stage_matches.filter((m) => m.win === false);

  const numWins = matches_by_win.length;
  const numLosses = matches_by_loss.length;
  const totalMatches = numWins + numLosses;

  const overallWinRate = numLosses
    ? ((numWins / totalMatches) * 100).toFixed(0)
    : 100;

  const stageFightersId = [...new Set(stage_matches.map((p) => p.fighter_id))];
  const stageFighters = stageFightersId.map(
    (fid) => SpriteList.filter((s) => s.id === fid)[0]
  );
  let fighterStats = [];
  stageFighters.forEach((fighter) => {
    const fighterMatches = stage_matches.filter(
      (m) => m.fighter_id === fighter.id
    );
    const wins = fighterMatches.filter((m) => m.win === true).length;
    const losses = fighterMatches.filter((m) => m.win === false).length;
    const winRate = losses ? ((wins / (wins + losses)) * 100).toFixed(0) : 100;
    fighterStats.push({
      fighter: fighter,
      wins: wins,
      losses: losses,
      winRate: winRate,
    });
  });

  // based on fighter, calculate win rate, loss rate, wins, losses

  const updateStage = (event, newStage) => {
    setStage(newStage);
  };

  return (
    <div>
      <h2>Stage Breakdown</h2>
      <StageSelect stage={stage} updateStage={updateStage} />
      <BreakdownResults
        stage={stage}
        wins={matches_by_win.length}
        losses={matches_by_loss.length}
        winRate={overallWinRate}
        fighterStats={fighterStats}
      />
    </div>
  );
};

export default StageBreakdown;
