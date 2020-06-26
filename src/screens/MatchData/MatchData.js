import React from "react";
import { makeStyles } from "@material-ui/styles";
import { MatchTable } from "./components";

const useStyles = makeStyles((theme) => ({
  root: {
    padding: theme.spacing(3),
  },
  content: {
    marginTop: theme.spacing(2),
  },
}));

const MatchData = () => {
  const classes = useStyles();

  return (
    <div className={classes.root}>
      <h1>MatchData</h1>
      <div className={classes.content}>
        <MatchTable />
      </div>
    </div>
  );
};

export default MatchData;
