import React, { useState } from "react";
import { useSelector } from "react-redux";
import { isEmpty, isLoaded, useFirebase } from "react-redux-firebase";
import { SpriteList } from "../../components/Sprites/SpriteList";
import {
  SelectFighter,
  SelectOpponent,
  MatchWinLossCard,
  MatchupTable,
} from "./components";
import { makeStyles } from "@material-ui/styles";
import CardContent from "@material-ui/core/CardContent";
import Button from "@material-ui/core/Button";
import { StyledMatchupCard, StyledMatchupSelectDiv } from "./style";
import { DashboardContext } from "../Dashboard/Dashboard";
import { DashboardToolbar } from "../Dashboard/components";
import { AddMatchForm } from "../Dashboard/components/DashboardToolbar/components";

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
  const firebase = useFirebase();
  const list = SpriteList;

  const primaryFighters = useSelector(
    (state) => state.firebase.data.primaryFighters
  );
  const secondaryFighters = useSelector(
    (state) => state.firebase.data.secondaryFighters
  );
  const matches = useSelector((state) => state.firebase.data.matches);

  const [open, setOpen] = React.useState(false);
  const handleClickOpen = () => {
    setOpen(true);
  };

  const handleClose = () => {
    setOpen(false);
  };

  const [fighter, setFighter] = useState({});

  const [opponent, setOpponent] = useState(SpriteList[0]);

  const [matchups, setMatchups] = useState([]);

  if (
    !isLoaded(primaryFighters) ||
    !isLoaded(secondaryFighters) ||
    !isLoaded(matches)
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
    setOpponent(SpriteList[0]);
    setFirstLoad(true);
    updateMatchups(sprites[0], SpriteList[0]);
  }

  function updateFighter(sprite) {
    setFighter(sprite);
    updateMatchups(sprite, opponent);
  }

  function updateOpponent(sprite) {
    setOpponent(sprite);
    updateMatchups(fighter, sprite);
  }

  function updateMatchups(the_fighter, the_opponent) {
    let f = the_fighter;
    const entries = Object.keys(matches[props.auth.uid]);
    const real_matches = entries.map((e) => {
      return {
        key: e,
        ...matches[props.auth.uid][e],
      };
    });
    const the_matchups = real_matches
      .filter((rm2) => rm2.fighter_id === the_fighter.id)
      .filter((rm) => rm.opponent_id === the_opponent.id);
    setMatchups(the_matchups);
  }

  function removeMatchup(key) {
    firebase.remove(`/matches/${props.auth.uid}/${key}`).then(() => {
      updateMatchups(fighter, opponent);
    });
  }

  return (
    <DashboardContext.Provider
      value={{
        fighter: fighter,
        updateFighter: updateFighter,
        fighterSprites: sprites,
        auth: props.auth,
        matches: matches,
        opponent: opponent,
        updateOpponent: updateOpponent,
        matchups: matchups,
        removeMatchup: removeMatchup,
      }}
    >
      <MatchupsContext.Provider
        value={{
          fighter: fighter,
          updateFighter: updateFighter,
          fighterSprites: sprites,
          auth: props.auth,
          matches: matches,
          opponent: opponent,
          updateOpponent: updateOpponent,
          matchups: matchups,
          removeMatchup: removeMatchup,
        }}
      >
        <StyledMatchupCard>
          <CardContent>
            <AddMatchForm open={open} handleClose={handleClose} />
            <div className={classes.root}>
              <div className={classes.root} style={{ flex: 1 }}>
                <StyledMatchupSelectDiv>
                  <h3>You</h3>
                  <SelectFighter />
                </StyledMatchupSelectDiv>
                <h1>vs</h1>
                <StyledMatchupSelectDiv className="matchup-opponent-select">
                  <h3>Opponent</h3>
                  <SelectOpponent />
                </StyledMatchupSelectDiv>
              </div>
              <Button
                color="primary"
                variant="contained"
                onClick={() => handleClickOpen()}
              >
                Add Match
              </Button>
            </div>
          </CardContent>
        </StyledMatchupCard>
        <div className={classes.content}>
          <MatchWinLossCard />
          <MatchupTable />
        </div>
      </MatchupsContext.Provider>
    </DashboardContext.Provider>
  );
};

export default Matchups;
