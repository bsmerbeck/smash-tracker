import React from "react";
import Button from "@material-ui/core/Button";
import TextField from "@material-ui/core/TextField";
import Dialog from "@material-ui/core/Dialog";
import DialogActions from "@material-ui/core/DialogActions";
import DialogContent from "@material-ui/core/DialogContent";
import DialogContentText from "@material-ui/core/DialogContentText";
import DialogTitle from "@material-ui/core/DialogTitle";
import Select from "@material-ui/core/Select";
import MenuItem from "@material-ui/core/MenuItem";
import ListItemIcon from "@material-ui/core/ListItemIcon";
import ListItemText from "@material-ui/core/ListItemText";
import { SpriteList } from "../../../../../../components/Sprites/SpriteList";
import { StyledIconSelect, StyledDialog } from "./style";

const AddMatchForm = (props) => {
  const { open, handleClose } = props;

  const [playerOne, setPlayerOne] = React.useState(SpriteList[0]);
  const handleChange = (event) => {
    setPlayerOne(event.target.value);
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
        <DialogContentText>
          Enter the match details, and then click Save to submit.
        </DialogContentText>
        <DialogActions>
          <Button onClick={handleClose} color="primary">
            Cancel
          </Button>
          <Button onClick={handleClose} color="primary">
            Save
          </Button>
        </DialogActions>
        <DialogContent>
          <StyledIconSelect value={playerOne} onChange={handleChange}>
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
        </DialogContent>
      </DialogContent>
    </StyledDialog>
  );
};

export default AddMatchForm;
