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
import {
  StyledIconSelect,
  StyledDialog,
  StyledMatchRow,
  StyledAddMatchMenuItem,
  StyledSpriteSelectDiv,
} from "./style";
import ToggleButton from "@material-ui/lab/ToggleButton";
import ToggleButtonGroup from "@material-ui/lab/ToggleButtonGroup";
import {
  StageSelect,
  MatchTypeSelect,
  OpponentNameSelect,
  NotesEntry,
} from "./components";
import { toast } from "react-toastify";
import { StageList } from "../../../../../../components/Stages/StageList";

const EditMatchForm = (props) => {
  const firebase = useFirebase();

  const { open, handleClose, auth, match } = props;

  const [result, setResult] = React.useState(match.win);

  const [firstLoad, setFirstLoad] = React.useState(false);

  const [map, setMap] = React.useState(() => {
    if (match.map) {
      if (match.map.id) {
        return match.map;
      } else return { id: 0, name: "no selection" };
    } else return { id: 0, name: "no selection" };
  });

  const [selectedType, setSelectedType] = React.useState(match.matchType);

  const [notes, setNotes] = React.useState(match.notes);

  const [error, setError] = React.useState(false);

  const [opponent, setOpponent] = React.useState(match.opponent);

  const primaryFighters = useSelector(
    (state) => state.firebase.data.primaryFighters
  );

  const secondaryFighters = useSelector(
    (state) => state.firebase.data.secondaryFighters
  );

  const opponents = useSelector((state) => state.firebase.data.opponents);

  const [playerOne, setPlayerOne] = React.useState(
    SpriteList.filter((sl) => {
      return sl.name === match.fighter_id;
    })[0]
  );
  const [playerTwo, setPlayerTwo] = React.useState(
    SpriteList.filter((sl) => sl.name === match.opponent_id)[0]
  );

  if (!isLoaded(primaryFighters) || !isLoaded(secondaryFighters)) {
    return <div />;
  }

  let fighterIds = [...primaryFighters[props.auth.uid]];
  if (!isEmpty(secondaryFighters[props.auth.uid])) {
    fighterIds = [...fighterIds, ...secondaryFighters[props.auth.uid]];
  }

  if (!firstLoad) {
    setPlayerOne(
      SpriteList.filter((sl) => {
        return sl.name === match.fighter_id;
      })[0]
    );
    setPlayerTwo(SpriteList.filter((sl) => sl.name === match.opponent_id)[0]);
    setMap(
      match.map === undefined
        ? { id: 0, name: "no selection" }
        : match.map.id === 0
        ? { id: 0, name: "no selection" }
        : StageList.filter((sl) => sl.name === match.map.name)[0]
    );
    setResult(match.win.toLowerCase());
    setSelectedType(match.matchType);
    setOpponent(match.opponent);
    setNotes(match.notes);
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
    setMap(newStage);
  };

  const updateSelectedType = (event) => {
    setSelectedType(event.target.value);
  };

  const updateNotes = (newValue) => {
    setNotes(newValue);
  };

  const updateError = (newValue) => {
    setError(newValue);
  };

  const updateOpponent = (newValue) => {
    if (newValue !== null) {
      setOpponent(newValue.toString().toLowerCase());
    } else {
      setOpponent(newValue);
    }
  };

  const onSaveMatchClick = () => {
    const mapDetails =
      map.id === 0
        ? { id: 0, name: "unknown" }
        : { id: map.id, name: map.name };

    firebase
      .database()
      .ref(`/matches/${auth.uid}/${match.key}`)
      .set({
        fighter_id: playerOne.id,
        opponent_id: playerTwo.id,
        time: firebase.database.ServerValue.TIMESTAMP,
        map: mapDetails,
        opponent: opponent,
        notes: notes,
        matchType: selectedType,
        win: result === "win",
      });

    firebase
      .set(`/opponents/${auth.uid}/${opponent.toString()}`, true)
      .then(() => {
        toast.dark("✅️ Match edited!", {
          position: "top-right",
          autoClose: 1000,
          hideProgressBar: false,
          closeOnClick: true,
          pauseOnHover: true,
          draggable: true,
          progress: undefined,
        });

        handleClose();
        setFirstLoad(false);
      });
  };

  return (
    <StyledDialog
      open={open}
      onClose={() => {
        setFirstLoad(false);
        handleClose();
      }}
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
        <StageSelect stage={map} updateStage={updateStage} />
        <MatchTypeSelect
          selectedType={selectedType}
          updateSelectedType={updateSelectedType}
        />
        <div
          style={{
            width: "100%",
            display: "flex",
            justifyContent: "space-around",
          }}
        >
          <OpponentNameSelect
            opponents={opponents}
            opponent={opponent}
            updateOpponent={updateOpponent}
            auth={props.auth}
          />
          <NotesEntry
            notes={notes}
            updateNotes={updateNotes}
            error={error}
            updateError={updateError}
          />
        </div>
      </DialogContent>
      <DialogActions>
        <Button
          onClick={() => {
            setFirstLoad(false);
            handleClose();
          }}
          color="primary"
        >
          Cancel
        </Button>
        <Button
          onClick={onSaveMatchClick}
          color="primary"
          disabled={error || !(result === "win" || result === "loss")}
        >
          Save
        </Button>
      </DialogActions>
    </StyledDialog>
  );
};

export default EditMatchForm;
