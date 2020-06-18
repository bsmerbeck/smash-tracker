import React from "react";
import { MatchChart } from "./components";
import CardContent from "@material-ui/core/CardContent";
import { StyledMatchCard } from "./style";

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
