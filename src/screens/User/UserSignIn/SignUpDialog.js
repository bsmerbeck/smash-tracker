import React from "react";
import { Button } from "@material-ui/core";
import Dialog from "@material-ui/core/Dialog";
import SignUp from "./SignUp";
import { StyledDialog } from "./style";

function SignUpDialog() {
  // const classes = useStyles();
  const [open, setOpen] = React.useState(false);

  const handleOpen = () => {
    setOpen(true);
  };

  const handleClose = () => {
    setOpen(false);
  };

  return (
    <div>
      <Button variant="contained" onClick={handleOpen}>
        Sign Up
      </Button>
      <StyledDialog open={open} onClose={handleClose}>
        {<SignUp handleClose={handleClose} />}
      </StyledDialog>
    </div>
  );
}
export default SignUpDialog;
