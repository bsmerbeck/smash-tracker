import React from "react";
import { MatchChart } from "./components";
import Card from "@material-ui/core/Card";
import CardContent from "@material-ui/core/CardContent";
import { StyledMatchCard } from "./style";
import Typography from "@material-ui/core/Typography";

const LastMatches = () => {
  return (
    <StyledMatchCard>
      <CardContent>
        <h2>Match History</h2>
        <MatchChart />
      </CardContent>
    </StyledMatchCard>
  );
};

export default LastMatches;
