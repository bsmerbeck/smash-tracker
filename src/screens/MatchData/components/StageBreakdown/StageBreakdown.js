import React from "react";
import { StageSelect } from "./components";
import { useSelector } from "react-redux";
import { isLoaded } from "react-redux-firebase";
import { SpriteList } from "../../../../components/Sprites/SpriteList";

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
  const [stageMatches, setStageMatches] = React.useState([]);

  // check for matches, if none return cancel
  const matches = useSelector((state) => state.firebase.data.matches);
  const primaryFighters = useSelector(
    (state) => state.firebase.data.primaryFighters
  );
  const secondaryFighters = useSelector(
    (state) => state.firebase.data.secondaryFighters
  );

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
  const matches_by_win = stage_matches.byWin();
  const matches_by_loss = stage_matches.byLoss();

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
    const wins = stage_matches
      .filter((m) => m.fighter_id === fighter.id)
      .byWin().length;
    const losses = stage_matches
      .filter((m) => m.fighter_id === fighter.id)
      .byLoss().length;
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
      <p>Stage Win Count: {matches_by_win.length}</p>
      <p>Stage Loss Count: {matches_by_loss.length}</p>
      <p>Overall Win Rate: {overallWinRate}%</p>
      {fighterStats.map((fs) => {
        return (
          <div style={{ display: "flex" }}>
            <img src={fs.fighter.url} alt="" />
            <p>{fs.fighter.name}</p>
            <div>
              <p>Wins</p>
              <p>{fs.wins}</p>
            </div>
            <div>
              <p>Losses</p>
              <p>{fs.losses}</p>
            </div>
            <div>
              <p>{fs.winRate}%</p>
            </div>
          </div>
        );
      })}
      <p>{JSON.stringify(fighterStats)}</p>
    </div>
  );
};

export default StageBreakdown;
