import React from "react";
import { DashboardContext } from "../../Dashboard";
import { useSelector } from "react-redux";
import { isLoaded } from "react-redux-firebase";
import { makeStyles } from "@material-ui/core";
import Card from "@material-ui/core/Card";
import CardContent from "@material-ui/core/CardContent";
import Typography from "@material-ui/core/Typography";

const useStyles = makeStyles({
  root: {
    minWidth: 275,
    maxWidth: 400,
    margin: "0 auto",
  },
  bullet: {
    display: "inline-block",
    margin: "0 2px",
    transform: "scale(0.8)",
  },
  title: {
    fontSize: 20,
  },
  body: {
    fontSize: 20,
  },
  pos: {
    marginBottom: 12,
  },
});

const WinLossTracker = () => {
  const classes = useStyles();
  const context = React.useContext(DashboardContext);
  const matches = useSelector((state) => state.firebase.data.matches);
  if (
    !isLoaded(matches) ||
    matches[context.auth.uid] === undefined ||
    matches[context.auth.uid] === null
  ) {
    return (
      <Card className={classes.root}>
        <div style={{ margin: "5px auto", textAlign: "center" }}>
          <Typography>No Match Data to Report.</Typography>
        </div>
        <CardContent
          style={{ display: "flex", justifyContent: "space-evenly" }}
        >
          <div
            style={{
              display: "flex",
              flexDirection: "column",
              alignItems: "center",
              textAlign: "center",
            }}
          >
            <Typography
              className={classes.body}
              color="textSecondary"
              gutterBottom
            >
              Wins
            </Typography>
            <Typography className={classes.body}>n/a</Typography>
          </div>
          <div
            style={{
              display: "flex",
              flexDirection: "column",
              alignItems: "center",
              textAlign: "center",
            }}
          >
            <Typography
              className={classes.body}
              color="textSecondary"
              gutterBottom
            >
              Losses
            </Typography>
            <Typography className={classes.body}>n/a</Typography>
          </div>
        </CardContent>
      </Card>
    );
  }

  const entries = Object.keys(matches[context.auth.uid]);
  const real_matches = entries.map((e) => matches[context.auth.uid][e]);
  const wins = real_matches.filter(
    (w) => w.win && w.fighter_id === context.fighter.id
  );
  const losses = real_matches.filter(
    (w) => !w.win && w.fighter_id === context.fighter.id
  );
  return (
    <Card className={classes.root}>
      <h2 style={{ margin: "10px", textAlign: "center" }}>Overall Record</h2>
      <CardContent style={{ display: "flex", justifyContent: "space-evenly" }}>
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            textAlign: "center",
          }}
        >
          <Typography
            className={classes.body}
            color="textSecondary"
            gutterBottom
          >
            Wins
          </Typography>
          <Typography className={classes.body}>{wins.length}</Typography>
        </div>
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            textAlign: "center",
          }}
        >
          <Typography
            className={classes.body}
            color="textSecondary"
            gutterBottom
          >
            Losses
          </Typography>
          <Typography className={classes.body}>{losses.length}</Typography>
        </div>
      </CardContent>
    </Card>
  );
};

export default WinLossTracker;
