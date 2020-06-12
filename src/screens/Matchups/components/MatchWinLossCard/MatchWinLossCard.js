import React, { useContext } from "react";
import { isLoaded } from "react-redux-firebase";
import { MatchupsContext } from "../../Matchups";
import Card from "@material-ui/core/Card";
import CardContent from "@material-ui/core/CardContent";
import Typography from "@material-ui/core/Typography";

const MatchWinLossCard = () => {
  const context = useContext(MatchupsContext);

  if (isLoaded(context.matches)) {
    if (context.matchups.length <= 0) {
      return (
        <Card>
          <CardContent>
            <Typography color="textSecondary" gutterBottom>
              No reported matches against this fighter
            </Typography>
          </CardContent>
        </Card>
      );
    }
  }

  const matchupWins = context.matchups.filter((m) => m.win);
  const matchupLosses = context.matchups.filter((m) => !m.win);

  return (
    <Card>
      <CardContent style={{ display: "flex", justifyContent: "space-evenly" }}>
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            textAlign: "center",
          }}
        >
          <Typography color="textSecondary" gutterBottom>
            Wins
          </Typography>
          <Typography>{matchupWins.length}</Typography>
        </div>
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            textAlign: "center",
          }}
        >
          <Typography color="textSecondary" gutterBottom>
            Losses
          </Typography>
          <Typography>{matchupLosses.length}</Typography>
        </div>
      </CardContent>
    </Card>
  );
};

export default MatchWinLossCard;
