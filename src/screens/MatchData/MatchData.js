import React from "react";
import { makeStyles } from "@material-ui/styles";
import { MatchTable, FighterPieChart, StageBreakdown } from "./components";
import { useSelector } from "react-redux";
import { useFirebase, isLoaded, isEmpty } from "react-redux-firebase";
import { StyledFighterPieChartDiv } from "./style";

const useStyles = makeStyles((theme) => ({
  root: {
    padding: theme.spacing(3),
  },
  content: {
    marginTop: theme.spacing(2),
  },
}));

export const MatchDataContext = React.createContext({});

const MatchData = (props) => {
  const firebase = useFirebase();
  const classes = useStyles();

  const matches = useSelector((state) => state.firebase.data.matches);

  if (
    matches === undefined ||
    !isLoaded(matches) ||
    isEmpty(matches) ||
    matches === null
  ) {
    return <div />;
  }

  function removeMatchup(key) {
    firebase.remove(`/matches/${props.auth.uid}/${key}`).then(() => {});
  }

  return (
    <MatchDataContext.Provider
      value={{
        auth: props.auth,
        matches: matches,
        removeMatchup: removeMatchup,
      }}
    >
      <div className={classes.root}>
        <h1>MatchData</h1>
        <div className={classes.content}>
          <MatchTable />
          <StyledFighterPieChartDiv>
            <div>
              <FighterPieChart />
            </div>
          </StyledFighterPieChartDiv>
          <StageBreakdown auth={props.auth} />
        </div>
      </div>
    </MatchDataContext.Provider>
  );
};

export default MatchData;
