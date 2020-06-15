import React, { useContext } from "react";
import { DashboardContext } from "../../Dashboard";
import { isLoaded } from "react-redux-firebase";
import Typography from "@material-ui/core/Typography";
import Card from "@material-ui/core/Card";
import CardContent from "@material-ui/core/CardContent";
import CardActionArea from "@material-ui/core/CardActionArea";
import CardMedia from "@material-ui/core/CardMedia";
import { SpriteList } from "../../../../components/Sprites/SpriteList";

Array.prototype.byWin = function () {
  let itm,
    a = [],
    L = this.length,
    o = {};
  for (let i = 0; i < L; i++) {
    itm = this[i].opponent_id;
    if (!itm) continue;
    if (o[itm] == undefined) {
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
    if (o[itm] == undefined) {
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
  const { matches, auth } = useContext(DashboardContext);

  if (
    !isLoaded(matches) ||
    matches[auth.uid] === undefined ||
    matches[auth.uid] === null
  ) {
    return (
      <Card>
        <CardContent>
          <h2>No matches reported</h2>
        </CardContent>
      </Card>
    );
  }

  const entries = Object.keys(matches[auth.uid]);
  const real_matches = entries.map((e) => matches[auth.uid][e]);
  const matches_by_win = real_matches.byWin();
  const matches_by_loss = real_matches.byLoss();

  let wins = [];
  matches_by_win.forEach((id) => {
    let winCount = 0;
    winCount = real_matches.filter(
      (m) => m.opponent_id.toString() === id && m.win
    ).length;
    wins.push({
      id: Number.parseInt(id),
      wins: winCount,
    });
  });
  matches_by_loss.forEach((id) => {
    let lossCount = 0;
    lossCount = real_matches.filter(
      (m) => m.opponent_id.toString() === id && !m.win
    ).length;
    if (wins[id]) {
      wins[id] = {
        ...wins[id],
        losses: lossCount,
      };
    }
  });

  const win_ratio_list = wins
    .map((m) => {
      return {
        id: m.id,
        wins: m.wins,
        losses: m.losses,
        ratio: m.losses ? (m.wins / (m.wins + m.losses)) * 100 : 100,
      };
    })
    .sort((a, b) => b.ratio - a.ratio);

  const tb = win_ratio_list[0];
  const tw = win_ratio_list[win_ratio_list.length - 1];
  const best = SpriteList.filter((s) => s.id === win_ratio_list[0].id)[0];
  const worst = SpriteList.filter(
    (s) => s.id === win_ratio_list[win_ratio_list.length - 1].id
  )[0];

  console.log(`${JSON.stringify(wins)}`);
  console.log(`${JSON.stringify(win_ratio_list)}`);

  return (
    <div
      style={{ display: "flex", justifyContent: "center", margin: "0 auto" }}
    >
      <Card style={{ margin: "10px", minWidth: "250px" }}>
        <CardContent style={{ paddingBottom: "5px" }}>
          <Typography color="textSecondary" gutterBottom>
            Best Matchup
          </Typography>
          <div style={{ display: "flex" }}>
            <img style={{ maxHeight: "10vh", flex: 0 }} src={best.url} alt="" />
            <div style={{ flex: 1, justifyContent: "space-between" }}>
              <h1>{best.name}</h1>
              <h2>{tw.ratio} %</h2>
            </div>
          </div>
          <div style={{ display: "flex" }}>
            <div
              style={{
                display: "flex",
                justifyContent: "space-between",
                width: "100%",
              }}
            >
              <h4>Wins: {tb.wins}</h4>
              <h4>Losses: {tb.losses ? tb.losses : 0}</h4>
            </div>
          </div>
        </CardContent>
      </Card>
      <Card style={{ margin: "10px", minWidth: "250px" }}>
        <CardContent style={{ paddingBottom: "5px" }}>
          <Typography color="textSecondary" gutterBottom>
            Worst Matchup
          </Typography>
          <div style={{ display: "flex", justifyContent: "space-between" }}>
            <img style={{ maxHeight: "10vh" }} src={worst.url} alt="" />
            <div style={{ textAlign: "end" }}>
              <h1>{worst.name}</h1>
              <h2>{tw.ratio} %</h2>
            </div>
          </div>
          <div style={{ display: "flex" }}>
            <div
              style={{
                display: "flex",
                justifyContent: "space-between",
                width: "100%",
              }}
            >
              <h4>Wins: {tw.wins}</h4>
              <h4>Losses: {tw.losses ? tw.losses : 0}</h4>
            </div>
          </div>
        </CardContent>
      </Card>
    </div>
  );
};

export default BestWorstMatchup;
