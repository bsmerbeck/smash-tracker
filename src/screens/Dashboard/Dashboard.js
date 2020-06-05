import React, { useState } from "react";
import { makeStyles } from "@material-ui/styles";
import { StyledDashFighterBarDiv } from "./style";
import SpriteBar from "../Layout/SpriteBar";
import { DashboardToolbar } from "./components";

const useStyles = makeStyles((theme) => ({
  root: {
    padding: theme.spacing(3),
  },
  content: {
    marginTop: theme.spacing(2),
  },
}));

export const DashboardContext = React.createContext({});

function Dashboard() {
  const classes = useStyles();

  const [fighter, setFighter] = useState({});

  function onSpriteClick(e, sprite) {
    setFighter(sprite);
  }

  return (
    <DashboardContext.Provider
      value={{ fighter: fighter, setFighter: setFighter }}
    >
      <div className={classes.root}>
        <DashboardToolbar />
        {/*<StyledDashFighterBarDiv>*/}
        {/*    <SpriteBar*/}
        {/*        className="DashSpriteBar"*/}
        {/*        onSpriteClick={onSpriteClick}*/}
        {/*        fighter={fighter}*/}
        {/*    />*/}
        {/*</StyledDashFighterBarDiv>*/}
        <div className={classes.content}>
          <h1>Dashboard</h1>
          <p>{`You've selected ${fighter.name}`}</p>
        </div>
      </div>
    </DashboardContext.Provider>
  );
}

export default Dashboard;
