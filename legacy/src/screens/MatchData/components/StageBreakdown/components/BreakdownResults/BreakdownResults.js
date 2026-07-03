import React from "react";
import List from "@material-ui/core/List";
import ListItem from "@material-ui/core/ListItem";
import ListItemIcon from "@material-ui/core/ListItemIcon";

import { StyledResultCard, StyledStatRowDiv } from "./style";

const BreakdownResults = (props) => {
  const { wins, losses, winRate, stage, fighterStats } = props;

  return (
    <StyledResultCard>
      <div style={{ margin: "10px" }}>
        <div>
          <h2 style={{ textAlign: "center" }}>{stage.name}</h2>
        </div>
        <div style={{ display: "flex", justifyContent: "space-around" }}>
          <div>
            <p>Rate</p>
            <h2>{winRate}%</h2>
          </div>
          <div>
            <p>Wins</p>
            <h2>{wins}</h2>
          </div>
          <div>
            <p>Losses</p>
            <h2>{losses}</h2>
          </div>
        </div>
        <div>
          <List>{fighterStats.map((fs) => FighterStatRow(fs))}</List>
        </div>
      </div>
    </StyledResultCard>
  );
};

const FighterStatRow = (fighterStat) => (
  <ListItem key={fighterStat.fighter.id}>
    <ListItemIcon>
      <img style={{ maxHeight: "5vh" }} src={fighterStat.fighter.url} alt="" />
    </ListItemIcon>
    <StyledStatRowDiv>
      <div className="fName">
        <h2>{fighterStat.fighter.name}</h2>
      </div>
      <div className="winLoss">
        <div>
          <p style={{ textAlign: "center" }}>Rate</p>
          <h2 style={{ textAlign: "center" }}>{fighterStat.winRate}%</h2>
        </div>
        <div>
          <p style={{ textAlign: "center" }}>Wins</p>
          <h2 style={{ textAlign: "center" }}>{fighterStat.wins}</h2>
        </div>
        <div>
          <p style={{ textAlign: "center" }}>Losses</p>
          <h2 style={{ textAlign: "center" }}>{fighterStat.losses}</h2>
        </div>
      </div>
    </StyledStatRowDiv>
  </ListItem>
);

export default BreakdownResults;
