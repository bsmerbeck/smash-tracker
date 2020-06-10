import React, { useState } from "react";
import { makeStyles } from "@material-ui/styles";
import { DashboardToolbar, LastMatches, WinLossTracker } from "./components";
import { useSelector } from "react-redux";
import { isLoaded, isEmpty } from "react-redux-firebase";
import { SpriteList } from "../../components/Sprites/SpriteList";

const useStyles = makeStyles((theme) => ({
  root: {
    padding: theme.spacing(3),
  },
  content: {
    marginTop: theme.spacing(2),
  },
}));

export const DashboardContext = React.createContext({});

function Dashboard(props) {
  const classes = useStyles();
  const [firstLoad, setFirstLoad] = React.useState(false);

  const primaryFighters = useSelector(
    (state) => state.firebase.data.primaryFighters
  );
  const secondaryFighters = useSelector(
    (state) => state.firebase.data.secondaryFighters
  );

  const [fighter, setFighter] = useState({});

  if (!isLoaded(primaryFighters) || !isLoaded(secondaryFighters)) {
    return <div />;
  }

  let fighterIds = [...primaryFighters[props.auth.uid]];
  if (!isEmpty(secondaryFighters[props.auth.uid])) {
    fighterIds = [...fighterIds, ...secondaryFighters[props.auth.uid]];
  }

  const sprites = fighterIds.map(
    (fid) => SpriteList.filter((s) => s.id === fid)[0]
  );

  if (firstLoad === false) {
    setFighter(sprites[0]);
    setFirstLoad(true);
  }

  function updateSprite(sprite) {
    setFighter(sprite);
  }

  return (
    <DashboardContext.Provider
      value={{
        fighter: fighter,
        updateSprite: updateSprite,
        fighterSprites: sprites,
        auth: props.auth,
      }}
    >
      <div className={classes.root}>
        <DashboardToolbar />
        <div className={classes.content} style={{ width: "100%" }}>
          <WinLossTracker style={{ margin: "0 auto" }} />
          <LastMatches />
        </div>
      </div>
    </DashboardContext.Provider>
  );
}

export default Dashboard;
