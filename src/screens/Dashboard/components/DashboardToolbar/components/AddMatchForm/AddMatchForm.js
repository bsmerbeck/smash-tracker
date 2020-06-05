import React from "react";
import ButtonGroup from "@material-ui/core/ButtonGroup";
import Button from "@material-ui/core/Button";
import { useSelector } from "react-redux";
import TextField from "@material-ui/core/TextField";
import Dialog from "@material-ui/core/Dialog";
import {
  useFirebase,
  useFirebaseConnect,
  isLoaded,
} from "react-redux-firebase";
import DialogActions from "@material-ui/core/DialogActions";
import DialogContent from "@material-ui/core/DialogContent";
import DialogContentText from "@material-ui/core/DialogContentText";
import DialogTitle from "@material-ui/core/DialogTitle";
import Select from "@material-ui/core/Select";
import MenuItem from "@material-ui/core/MenuItem";
import ListItemIcon from "@material-ui/core/ListItemIcon";
import ListItemText from "@material-ui/core/ListItemText";
import { SpriteList } from "../../../../../../components/Sprites/SpriteList";
import { StyledIconSelect, StyledDialog, StyledMatchRow } from "./style";
import ToggleButton from "@material-ui/lab/ToggleButton";
import ToggleButtonGroup from "@material-ui/lab/ToggleButtonGroup";

const updateFighterList = (primary, secondary, setFighter) => {
  setFighter([...primary, ...secondary]);
};

const AddMatchForm = (props) => {
  let fighterLoad = false;

  const { open, handleClose, auth } = props;

  const [result, setResult] = React.useState("");

  const [firstLoad, setFirstLoad] = React.useState(false);

  const primaryFighters = useSelector(
    (state) => state.firebase.data.primaryFighters
  );
  const secondaryFighters = useSelector(
    (state) => state.firebase.data.secondaryFighters
  );

  const [playerOne, setPlayerOne] = React.useState(SpriteList[0]);
  const [playerTwo, setPlayerTwo] = React.useState(SpriteList[0]);

  if (!isLoaded(primaryFighters) || !isLoaded(secondaryFighters)) {
    return <div />;
  }

  const fighterIds = [
    ...primaryFighters[auth.uid],
    ...secondaryFighters[auth.uid],
  ];

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
        <Button onClick={handleClose} color="primary">
          Save
        </Button>
      </DialogActions>
    </StyledDialog>
  );
};

export default AddMatchForm;
