import React, { useContext, useState } from "react";
import { DashboardContext } from "../../Dashboard";
import { isLoaded } from "react-redux-firebase";
import Typography from "@material-ui/core/Typography";
import Select from "@material-ui/core/Select";
import MenuItem from "@material-ui/core/MenuItem";
import { SpriteList } from "../../../../components/Sprites/SpriteList";
import {
  BestWorstCardDiv,
  StyledBWCard,
  StyledBWCardContent,
  StyledBWSelectDiv,
} from "./style";

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

const BestWorstMatchup = () => {
  const { matches, auth, fighter } = useContext(DashboardContext);

  const [threshold, setThreshold] = useState(10);

  if (
    !isLoaded(matches) ||
    matches[auth.uid] === undefined ||
    matches[auth.uid] === null
  ) {
    return (
      <StyledBWCard>
        <StyledBWCardContent>
          <h2>No matches reported</h2>
        </StyledBWCardContent>
      </StyledBWCard>
    );
  }

  const entries = Object.keys(matches[auth.uid]);
  const real_matches = entries.map((e) => matches[auth.uid][e]);
  const matchup_matches = real_matches.filter(
    (rm) => rm.fighter_id === fighter.id
  );
  const matches_by_win = matchup_matches.byWin();
  const matches_by_loss = matchup_matches.byLoss();

  let wins = [];
  matches_by_win.forEach((id) => {
    let winCount = 0;
    winCount = matchup_matches.filter(
      (m) => m.opponent_id.toString() === id && m.win
    ).length;
    wins.push({
      id: Number.parseInt(id),
      wins: winCount,
      losses: 0,
    });
  });
  matches_by_loss.forEach((id) => {
    let lossCount;
    lossCount = matchup_matches.filter(
      (m) => m.opponent_id.toString() === id && !m.win
    ).length;
    if (lossCount === null || lossCount === undefined) {
      lossCount = 0;
    }
    let matchIndex = wins.findIndex((w) => w.id.toString() === id);
    if (matchIndex >= 0) {
      wins[matchIndex] = {
        ...wins[matchIndex],
        losses: lossCount,
      };
    } else {
      wins.push({
        id: Number.parseInt(id),
        wins: 0,
        losses: lossCount,
      });
    }
  });

  const win_ratio_list = wins
    .map((m) => {
      return {
        id: m.id,
        wins: m.wins,
        losses: m.losses,
        totalMatches: m.wins + m.losses,
        ratio: m.losses
          ? ((m.wins / (m.wins + m.losses)) * 100).toFixed(0)
          : 100,
      };
    })
    .filter((m2) => m2.totalMatches >= threshold)
    .sort((a, b) => {
      if (b.ratio === a.ratio) {
        return b.wins + b.losses - (a.wins - a.losses);
      } else {
        return b.ratio - a.ratio;
      }
    });

  if (win_ratio_list.length === 0) {
    return (
      <StyledBWCard>
        <h2 style={{ margin: "10px auto", textAlign: "center" }}>
          Matchup Statistics
        </h2>
        <StyledBWSelectDiv>
          <p>Minimum Match Threshold</p>
          <Select
            value={threshold}
            onChange={(e) => setThreshold(e.target.value)}
          >
            <MenuItem className="bwMenuItem" value={10}>
              10
            </MenuItem>
            <MenuItem className="bwMenuItem" value={25}>
              25
            </MenuItem>
            <MenuItem className="bwMenuItem" value={50}>
              50
            </MenuItem>
            <MenuItem className="bwMenuItem" value={100}>
              100
            </MenuItem>
          </Select>
        </StyledBWSelectDiv>
        <BestWorstCardDiv>
          <StyledBWCard>
            <StyledBWCardContent>
              <Typography color="textSecondary" gutterBottom>
                Best Matchup
              </Typography>
              <p>Not enough reported matches to calculate</p>
            </StyledBWCardContent>
          </StyledBWCard>
          <StyledBWCard>
            <StyledBWCardContent>
              <Typography color="textSecondary" gutterBottom>
                Worst Matchup
              </Typography>
              <p>Not enough reported matches to calculate</p>
            </StyledBWCardContent>
          </StyledBWCard>
        </BestWorstCardDiv>
      </StyledBWCard>
    );
  }

  const tb = win_ratio_list[0];
  const tw = win_ratio_list[win_ratio_list.length - 1];
  const best = SpriteList.filter((s) => s.id === win_ratio_list[0].id)[0];
  const worst = SpriteList.filter(
    (s) => s.id === win_ratio_list[win_ratio_list.length - 1].id
  )[0];

  return (
    <StyledBWCard>
      <h2>Matchup Statistics</h2>
      <div>
        <p>Minimum Match Threshold</p>
        <Select
          value={threshold}
          onChange={(e) => setThreshold(e.target.value)}
        >
          <MenuItem className="bwMenuItem" value={10}>
            10
          </MenuItem>
          <MenuItem className="bwMenuItem" value={25}>
            25
          </MenuItem>
          <MenuItem className="bwMenuItem" value={50}>
            50
          </MenuItem>
          <MenuItem className="bwMenuItem" value={100}>
            100
          </MenuItem>
        </Select>
      </div>
      <BestWorstCardDiv>
        <StyledBWCard>
          <StyledBWCardContent>
            <Typography color="textSecondary" gutterBottom>
              Best Matchup
            </Typography>
            <div className="spriteContainer">
              <img src={best.url} alt="" />
              <div>
                <h1>{best.name}</h1>
                <h2>{tw.ratio} %</h2>
              </div>
            </div>
            <div className="bwResult">
              <div>
                <h4>Wins: {tb.wins}</h4>
                <h4>Losses: {tb.losses ? tb.losses : 0}</h4>
              </div>
            </div>
          </StyledBWCardContent>
        </StyledBWCard>
        <StyledBWCard>
          <StyledBWCardContent>
            <Typography color="textSecondary" gutterBottom>
              Worst Matchup
            </Typography>
            <div className="spriteContainer">
              <img src={worst.url} alt="" />
              <div>
                <h1>{worst.name}</h1>
                <h2>{tw.ratio} %</h2>
              </div>
            </div>
            <div className="bwResult">
              <div>
                <h4>Wins: {tw.wins}</h4>
                <h4>Losses: {tw.losses ? tw.losses : 0}</h4>
              </div>
            </div>
          </StyledBWCardContent>
        </StyledBWCard>
      </BestWorstCardDiv>
    </StyledBWCard>
  );
};

export default BestWorstMatchup;
