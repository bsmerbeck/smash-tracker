import React, { useState } from "react";
import { makeStyles } from "@material-ui/styles";
import {
  DashboardToolbar,
  LastMatchesChart,
  WinLossTracker,
} from "./components";
import { useSelector } from "react-redux";
import { useHistory } from "react-router-dom";

import { isLoaded, isEmpty } from "react-redux-firebase";
import Button from "@material-ui/core/Button";
import { SpriteList } from "../../components/Sprites/SpriteList";
import {
  StyledBestWorst,
  StyledPreviousMatches,
  StyledTwoCardDiv,
} from "./style";

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
  const history = useHistory();
  const classes = useStyles();
  const [firstLoad, setFirstLoad] = React.useState(false);

  const primaryFighters = useSelector(
    (state) => state.firebase.data.primaryFighters
  );
  const secondaryFighters = useSelector(
    (state) => state.firebase.data.secondaryFighters
  );
  const opponents = useSelector((state) => state.firebase.data.opponents);

  const matches = useSelector((state) => state.firebase.data.matches);

  const [fighter, setFighter] = useState({});

  if (!isLoaded(primaryFighters) || !isLoaded(secondaryFighters)) {
    return <div />;
  }

  if (isEmpty(primaryFighters) || primaryFighters[props.auth.uid] === null) {
    return (
      <div
        style={{
          display: "flex",
          flexDirection: "column",
          width: "100%",
          padding: "40px",
        }}
      >
        <h1 style={{ textAlign: "center" }}>
          You haven't picked any fighters yet!
        </h1>
        <Button
          style={{ margin: "10px" }}
          color="primary"
          variant="contained"
          onClick={() => history.push("/choose-primary")}
        >
          Choose Primary Fighters
        </Button>
        <Button
          style={{ margin: "10px" }}
          color="primary"
          variant="contained"
          onClick={() => history.push("/choose-secondary")}
        >
          Choose Secondary Fighters
        </Button>
      </div>
    );
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
        matches: matches,
        opponents: opponents,
      }}
    >
      <div className={classes.root}>
        <DashboardToolbar />
        <div className={classes.content} style={{ width: "100%" }}>
          <WinLossTracker style={{ margin: "0 auto" }} />
          <StyledTwoCardDiv>
            <StyledBestWorst />
            <StyledPreviousMatches />
          </StyledTwoCardDiv>

          <LastMatchesChart />
        </div>
      </div>
    </DashboardContext.Provider>
  );
}

export default Dashboard;
