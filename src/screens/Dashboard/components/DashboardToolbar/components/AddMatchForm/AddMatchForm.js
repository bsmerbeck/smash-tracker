import React from "react";
import Button from "@material-ui/core/Button";
import { useSelector } from "react-redux";

import { useFirebase, isLoaded, isEmpty } from "react-redux-firebase";
import DialogActions from "@material-ui/core/DialogActions";
import DialogContent from "@material-ui/core/DialogContent";
import DialogContentText from "@material-ui/core/DialogContentText";
import DialogTitle from "@material-ui/core/DialogTitle";
import MenuItem from "@material-ui/core/MenuItem";
import ListItemIcon from "@material-ui/core/ListItemIcon";
import ListItemText from "@material-ui/core/ListItemText";
import { SpriteList } from "../../../../../../components/Sprites/SpriteList";
import { StyledIconSelect, StyledDialog, StyledMatchRow } from "./style";
import ToggleButton from "@material-ui/lab/ToggleButton";
import ToggleButtonGroup from "@material-ui/lab/ToggleButtonGroup";
import { DashboardContext } from "../../../../Dashboard";

const AddMatchForm = (props) => {
  const firebase = useFirebase();

  const context = React.useContext(DashboardContext);

  const { open, handleClose, auth } = props;

  const [result, setResult] = React.useState("");

  const [firstLoad, setFirstLoad] = React.useState(false);

  const primaryFighters = useSelector(
    (state) => state.firebase.data.primaryFighters
  );
  const secondaryFighters = useSelector(
    (state) => state.firebase.data.secondaryFighters
  );

  const [playerOne, setPlayerOne] = React.useState(context.fighter);
  const [playerTwo, setPlayerTwo] = React.useState(SpriteList[0]);

  if (!isLoaded(primaryFighters) || !isLoaded(secondaryFighters)) {
    return <div />;
  }

  let fighterIds = [...primaryFighters[props.auth.uid]];
  if (!isEmpty(secondaryFighters[props.auth.uid])) {
    fighterIds = [...fighterIds, ...secondaryFighters[props.auth.uid]];
  }

  if (
    firstLoad === false &&
    isLoaded(primaryFighters) &&
    isLoaded(secondaryFighters)
  ) {
    const firstSprite = SpriteList.filter((s) => s.id === fighterIds[0])[0];
    setPlayerOne(firstSprite);
    setFirstLoad(true);
  }

  const fighterSprites = fighterIds.map((fid) => {
    return SpriteList.filter((sl) => sl.id === fid)[0];
  });

  const handlePlayerOne = (event) => {
    setPlayerOne(event.target.value);
  };

  const handlePlayerTwo = (event) => {
    setPlayerTwo(event.target.value);
  };

  const handleResultClick = (event, newResult) => {
    setResult(newResult);
  };

  const onSaveMatchClick = () => {
    const matchRef = firebase.database().ref(`/matches/${auth.uid}`).push();
    matchRef.set({
      fighter_id: playerOne.id,
      opponent_id: playerTwo.id,
      time: firebase.database.ServerValue.TIMESTAMP,
      win: result === "win",
    });
    handleClose();
  };

  return (
    <StyledDialog
      open={open}
      onClose={handleClose}
      aria-labelledby="form-dialog-title"
      maxWidth="lg"
      fullWidth={true}
    >
      <DialogTitle id="form-dialog-title">Add Match</DialogTitle>
      <DialogContent>
        <StyledMatchRow>
          <div>
            <DialogContentText>Your Fighter</DialogContentText>
            <StyledIconSelect value={playerOne} onChange={handlePlayerOne}>
              {fighterSprites.map((s) => {
                return (
                  <MenuItem value={s} key={s.id}>
                    <ListItemIcon>
                      <img style={{ maxWidth: "50px" }} src={s.url} alt="" />
                    </ListItemIcon>
                    <ListItemText>{s.name}</ListItemText>
                  </MenuItem>
                );
              })}
            </StyledIconSelect>
          </div>
          <div>
            <DialogContentText>Player Two Fighter</DialogContentText>
            <StyledIconSelect value={playerTwo} onChange={handlePlayerTwo}>
              {SpriteList.map((s) => {
                return (
                  <MenuItem value={s} key={s.id}>
                    <ListItemIcon>
                      <img style={{ maxWidth: "50px" }} src={s.url} alt="" />
                    </ListItemIcon>
                    <ListItemText>{s.name}</ListItemText>
                  </MenuItem>
                );
              })}
            </StyledIconSelect>
          </div>
        </StyledMatchRow>
        <StyledMatchRow>
          <ToggleButtonGroup
            value={result}
            exclusive
            onChange={handleResultClick}
          >
            <ToggleButton value="win" size="large" variant="outlined">
              Win
            </ToggleButton>
            <ToggleButton value="loss" size="large" variant="outlined">
              Loss
            </ToggleButton>
          </ToggleButtonGroup>
        </StyledMatchRow>
      </DialogContent>
      <DialogActions>
        <Button onClick={handleClose} color="primary">
          Cancel
        </Button>
        <Button onClick={onSaveMatchClick} color="primary">
          Save
        </Button>
      </DialogActions>
    </StyledDialog>
  );
};

export default AddMatchForm;
