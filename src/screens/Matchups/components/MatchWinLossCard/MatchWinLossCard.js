import React, { useContext } from "react";
import { isLoaded } from "react-redux-firebase";
import { MatchupsContext } from "../../Matchups";
import Card from "@material-ui/core/Card";
import CardContent from "@material-ui/core/CardContent";
import Typography from "@material-ui/core/Typography";

const MatchWinLossCard = () => {
  const { matches, matchups, fighter, opponent, auth } = useContext(
    MatchupsContext
  );

  if (isLoaded(matches)) {
    if (matchups.length <= 0) {
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

  const matchData = Object.keys(matches[auth.uid])
    .map((entry) => {
      return {
        ...matches[auth.uid][entry],
        key: entry,
      };
    })
    .filter((match) => match.fighter_id === fighter.id)
    .filter((match2) => match2.opponent_id === opponent.id);

  const matchupWins = matchData.filter((m) => m.win);
  const matchupLosses = matchData.filter((m) => !m.win);

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
