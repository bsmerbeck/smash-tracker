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

const BestWorstMatchup = ({ className }) => {
  const { matches, auth, fighter } = useContext(DashboardContext);

  const [threshold, setThreshold] = useState(5);

  if (
    !isLoaded(matches) ||
    matches[auth.uid] === undefined ||
    matches[auth.uid] === null
  ) {
    return (
      <StyledBWCard className={className}>
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
      <StyledBWCard className={className}>
        <h2>Matchup Statistics</h2>
        <StyledBWSelectDiv>
          <p>Minimum Match Threshold</p>
          <Select
            value={threshold}
            onChange={(e) => setThreshold(e.target.value)}
          >
            <MenuItem className="bwMenuItem" value={3}>
              3
            </MenuItem>
            <MenuItem className="bwMenuItem" value={5}>
              5
            </MenuItem>
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

  let bwCount = win_ratio_list.length / 2;
  bwCount = bwCount >= 1 ? (bwCount >= 3 ? 3 : Math.floor(bwCount)) : 1.0;

  let tbList = [];
  let twList = [];

  for (let x = 0; x < bwCount; x++) {
    const best = win_ratio_list[x];
    const worst = win_ratio_list[win_ratio_list.length - 1 - x];
    const bestSprite = SpriteList.find((s) => s.id === best.id);
    const worstSprite = SpriteList.find((s) => s.id === worst.id);
    console.log(`${JSON.stringify(best)}`);
    console.log(`${JSON.stringify(worst)}`);
    tbList.push({ stats: best, sprite: bestSprite });
    twList.push({ stats: worst, sprite: worstSprite });
  }

  //twList = twList.reverse();
  //tbList = tbList.reverse();

  // const tb = win_ratio_list[0];
  // const tw = win_ratio_list[win_ratio_list.length - 1];
  // const best = SpriteList.filter((s) => s.id === win_ratio_list[0].id)[0];
  // const worst = SpriteList.filter(
  //   (s) => s.id === win_ratio_list[win_ratio_list.length - 1].id
  // )[0];

  return (
    <StyledBWCard className={className}>
      <h2>Matchup Statistics</h2>
      <div>
        <p>Minimum Match Threshold</p>
        <Select
          value={threshold}
          onChange={(e) => setThreshold(e.target.value)}
        >
          <MenuItem className="bwMenuItem" value={3}>
            3
          </MenuItem>
          <MenuItem className="bwMenuItem" value={5}>
            5
          </MenuItem>
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
            {tbList.map((tb) => {
              return (
                <div key={tb.stats.id}>
                  <div className="spriteContainer">
                    <img src={tb.sprite.url} alt="" />
                    <div style={{ display: "flex", flexDirection: "column" }}>
                      <div style={{ display: "flex", flexDirection: "row" }}>
                        <h3 style={{ margin: "0 3px" }}>{tb.sprite.name}</h3>
                      </div>
                      <div style={{ display: "flex", flexDirection: "row" }}>
                        <h3 style={{ margin: "0 3px" }}>
                          {tb.stats.ratio}% ( {tb.stats.wins}:
                          {tb.stats.losses ?? 0} )
                        </h3>
                      </div>
                    </div>
                  </div>
                </div>
              );
            })}
          </StyledBWCardContent>
        </StyledBWCard>
        <StyledBWCard>
          <StyledBWCardContent>
            <Typography color="textSecondary" gutterBottom>
              Worst Matchup
            </Typography>
            {twList.map((tw) => {
              return (
                <div key={tw.stats.id}>
                  <div className="spriteContainer">
                    <img src={tw.sprite.url} alt="" />
                    <div style={{ display: "flex", flexDirection: "column" }}>
                      <div style={{ display: "flex", flexDirection: "row" }}>
                        <h3 style={{ margin: "0 3px" }}>{tw.sprite.name}</h3>
                      </div>
                      <div style={{ display: "flex", flexDirection: "row" }}>
                        <h3 style={{ margin: "0 3px" }}>
                          {tw.stats.ratio}% ( {tw.stats.wins}:
                          {tw.stats.losses ?? 0} )
                        </h3>
                      </div>
                    </div>
                  </div>
                </div>
              );
            })}
          </StyledBWCardContent>
        </StyledBWCard>
      </BestWorstCardDiv>
    </StyledBWCard>
  );
};

export default BestWorstMatchup;
