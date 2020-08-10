import React, { useState } from "react";
import { makeStyles } from "@material-ui/styles";
import { isEmpty, useFirebase } from "react-redux-firebase";
import { useSelector } from "react-redux";

import { SpriteList } from "../../components/Sprites/SpriteList";

import { SelectFighter } from "./components";

const useStyles = makeStyles((theme) => ({
  root: {
    padding: theme.spacing(3),
  },
  content: {
    marginTop: theme.spacing(2),
  },
}));

export const FighterAnalysisContext = React.createContext({});

const FighterAnalysis = (props) => {
  const classes = useStyles();

  const [fighter, setFighter] = useState({});
  const [firstLoad, setFirstLoad] = useState(false);

  const primaryFighters = useSelector(
    (state) => state.firebase.data.primaryFighters
  );
  const secondaryFighters = useSelector(
    (state) => state.firebase.data.secondaryFighters
  );
  const matches = useSelector((state) => state.firebase.data.matches);

  if (
    primaryFighters === undefined ||
    secondaryFighters === undefined ||
    matches === undefined
  ) {
    return <div />;
  }

  let fighterIds = [...primaryFighters[props.auth.uid]];
  if (!isEmpty(secondaryFighters[props.auth.uid])) {
    fighterIds = [...fighterIds, ...secondaryFighters[props.auth.uid]];
  }

  const sprites = fighterIds.map(
    (fid) => SpriteList.filter((s) => s.id === fid)[0]
  );

  if (
    firstLoad === false &&
    sprites.length > 0 &&
    sprites[0].id !== undefined
  ) {
    setFighter(sprites[0]);
    setFirstLoad(true);
  }

  function updateFighter(sprite) {
    setFighter(sprite);
  }

  if (sprites.length === 0) {
    return <h2>no fighter</h2>;
  } else if (matches[props.auth.uid] === null) {
    return (
      <div style={{ textAlign: "center" }}>
        <h2>You haven't reported any matches!</h2>
        <h3>Report a Match on Dashboard and report back here!</h3>
      </div>
    );
  }

  return (
    <FighterAnalysisContext.Provider
      value={{
        fighter: fighter,
        fighterSprites: sprites,
        updateFighter: updateFighter,
      }}
    >
      <div className={classes.root}>
        <h1>Fighter Analysis</h1>
        <div className={classes.content}>
          <SelectFighter />
          <h2>content</h2>
        </div>
      </div>
    </FighterAnalysisContext.Provider>
  );
};

export default FighterAnalysis;
