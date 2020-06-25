import React from "react";
import Button from "@material-ui/core/Button";
import { useSelector } from "react-redux";

import { useFirebase, isLoaded, isEmpty } from "react-redux-firebase";
import DialogActions from "@material-ui/core/DialogActions";
import DialogContent from "@material-ui/core/DialogContent";
import DialogContentText from "@material-ui/core/DialogContentText";
import RadioGroup from "@material-ui/core/RadioGroup";
import Radio from "@material-ui/core/Radio";
import FormControlLabel from "@material-ui/core/FormControlLabel";
import DialogTitle from "@material-ui/core/DialogTitle";
import MenuItem from "@material-ui/core/MenuItem";
import ListItemIcon from "@material-ui/core/ListItemIcon";
import ListItemText from "@material-ui/core/ListItemText";
import { SpriteList } from "../../../../../../components/Sprites/SpriteList";
import {
  StyledIconSelect,
  StyledDialog,
  StyledMatchRow,
  StyledAddMatchMenuItem,
  StyledSpriteSelectDiv,
} from "./style";
import ToggleButton from "@material-ui/lab/ToggleButton";
import ToggleButtonGroup from "@material-ui/lab/ToggleButtonGroup";
import { DashboardContext } from "../../../../Dashboard";
import { StageSelect } from "./components";
import { toast } from "react-toastify";

const AddMatchForm = (props) => {
  const firebase = useFirebase();

  const context = React.useContext(DashboardContext);

  const { open, handleClose, auth } = props;

  const [result, setResult] = React.useState("");

  const [firstLoad, setFirstLoad] = React.useState(false);

  const [stage, setStage] = React.useState({ id: 0, name: "no selection" });

  const [selectedType, setSelectedType] = React.useState("quickplay");

  const primaryFighters = useSelector(
    (state) => state.firebase.data.primaryFighters
  );
  const secondaryFighters = useSelector(
    (state) => state.firebase.data.secondaryFighters
  );

  const alphaSpriteList = SpriteList.sort((a, b) => {
    const textA = a.name.toUpperCase();
    const textB = b.name.toUpperCase();
    return textA < textB ? -1 : textA > textB ? 1 : 0;
  });

  const [playerOne, setPlayerOne] = React.useState(context.fighter);
  const [playerTwo, setPlayerTwo] = React.useState(alphaSpriteList[0]);

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

  const updateStage = (event, newStage) => {
    setStage(newStage);
  };

  const updateSelectedType = (event) => {
    setSelectedType(event.target.value);
  };

  const onSaveMatchClick = () => {
    const mapDetails =
      stage.id === 0 ? null : { id: stage.id, name: stage.name };

    const matchRef = firebase.database().ref(`/matches/${auth.uid}`).push();
    matchRef.set({
      fighter_id: playerOne.id,
      opponent_id: playerTwo.id,
      time: firebase.database.ServerValue.TIMESTAMP,
      win: result === "win",
      map: mapDetails,
    });
    toast.dark("✅️ Match added!", {
      position: "top-right",
      autoClose: 1000,
      hideProgressBar: false,
      closeOnClick: true,
      pauseOnHover: true,
      draggable: true,
      progress: undefined,
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
      <DialogContent style={{ padding: "8px 2px" }}>
        <StyledMatchRow>
          <StyledSpriteSelectDiv>
            <DialogContentText>Your Fighter</DialogContentText>
            <StyledIconSelect value={playerOne} onChange={handlePlayerOne}>
              {fighterSprites.map((s) => {
                return (
                  <MenuItem value={s} key={s.id}>
                    <StyledAddMatchMenuItem>
                      <img
                        style={{ maxWidth: "50px", maxHeight: "50px" }}
                        src={s.url}
                        alt=""
                      />
                    </StyledAddMatchMenuItem>
                    <ListItemText>{s.name}</ListItemText>
                  </MenuItem>
                );
              })}
            </StyledIconSelect>
          </StyledSpriteSelectDiv>
          <StyledSpriteSelectDiv>
            <DialogContentText>Player Two Fighter</DialogContentText>
            <StyledIconSelect value={playerTwo} onChange={handlePlayerTwo}>
              {SpriteList.map((s) => {
                return (
                  <MenuItem value={s} key={s.id}>
                    <ListItemIcon>
                      <img
                        style={{ maxWidth: "50px", maxHeight: "50px" }}
                        src={s.url}
                        alt=""
                      />
                    </ListItemIcon>
                    <ListItemText>{s.name}</ListItemText>
                  </MenuItem>
                );
              })}
            </StyledIconSelect>
          </StyledSpriteSelectDiv>
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
        <StageSelect stage={stage} updateStage={updateStage} />
        <div>
          <h2 style={{ textAlign: "center" }}>Match Type</h2>
          <RadioGroup
            style={{ margin: "20px", justifyContent: "space-around" }}
            row
            aria-label="position"
            name="position"
            defaultValue="end"
          >
            <FormControlLabel
              value="quickplay"
              checked={selectedType === "quickplay"}
              onChange={updateSelectedType}
              control={<Radio color="primary" />}
              label="QuickPlay"
              labelPlacement="end"
            />
            <FormControlLabel
              value="online-friendly"
              checked={selectedType === "online-friendly"}
              onChange={updateSelectedType}
              control={<Radio color="primary" />}
              label="Online Friendly"
              labelPlacement="end"
            />
            <FormControlLabel
              checked={selectedType === "online-tourney"}
              onChange={updateSelectedType}
              value="online-tourney"
              control={<Radio color="primary" />}
              label="Online Tourney"
              labelPlacement="end"
            />
            <FormControlLabel
              checked={selectedType === "offline-friendly"}
              onChange={updateSelectedType}
              value="offline-friendly"
              control={<Radio color="primary" />}
              label="Offline Friendly"
              labelPlacement="end"
            />
            <FormControlLabel
              checked={selectedType === "offline-tourney"}
              onChange={updateSelectedType}
              value="offline-tourney"
              control={<Radio color="primary" />}
              label="Offline Tourney"
              labelPlacement="end"
            />
          </RadioGroup>
        </div>
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
