import React, { useState } from "react";
import { useSelector } from "react-redux";
import { isEmpty, isLoaded } from "react-redux-firebase";
import { SpriteList } from "../../components/Sprites/SpriteList";
import { SelectFighter, SelectOpponent } from "./components";
import { makeStyles } from "@material-ui/styles";
import Card from "@material-ui/core/Card";
import CardContent from "@material-ui/core/CardContent";
import theme from "../../theme";
import { StyledMatchupCard, StyledMatchupSelectDiv } from "./style";

export const MatchupsContext = React.createContext({});

const useStyles = makeStyles((theme) => ({
  root: {
    padding: theme.spacing(0),
    display: "flex",
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
  },
  content: {
    marginTop: theme.spacing(2),
  },
}));

const Matchups = (props) => {
  const classes = useStyles();
  const [firstLoad, setFirstLoad] = React.useState(false);

  const primaryFighters = useSelector(
    (state) => state.firebase.data.primaryFighters
  );
  const secondaryFighters = useSelector(
    (state) => state.firebase.data.secondaryFighters
  );
  const matches = useSelector((state) => state.firebase.data.matches);

  const [fighter, setFighter] = useState({});

  const [opponent, setOpponent] = useState(SpriteList[0]);

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

  function updateFighter(sprite) {
    setFighter(sprite);
  }

  function updateOpponent(sprite) {
    setOpponent(sprite);
  }

  return (
    <MatchupsContext.Provider
      value={{
        fighter: fighter,
        updateFighter: updateFighter,
        fighterSprites: sprites,
        auth: props.auth,
        matches: matches,
        opponent: opponent,
        updateOpponent: updateOpponent,
      }}
    >
      <StyledMatchupCard>
        <CardContent>
          <div className={classes.root}>
            <StyledMatchupSelectDiv>
              <h3>You:</h3>
              <SelectFighter />
            </StyledMatchupSelectDiv>
            <h1>vs</h1>
            <StyledMatchupSelectDiv>
              <SelectOpponent />
              <h3>Opponent</h3>
            </StyledMatchupSelectDiv>
          </div>
        </CardContent>
      </StyledMatchupCard>
    </MatchupsContext.Provider>
  );
};

export default Matchups;
