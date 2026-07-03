import React from "react";
import { Button } from "@material-ui/core";
import SignUp from "./SignUp";
import { StyledDialog } from "./style";

function SignUpDialog() {
  const [open, setOpen] = React.useState(false);

  const handleOpen = () => {
    setOpen(true);
  };

  const handleClose = () => {
    setOpen(false);
  };

  return (
    <div style={{ width: "100%", display: "flex" }}>
      <Button
        style={{
          width: "100%",
          maxWidth: "220px",
          padding: "8px 16px",
          margin: "0 auto",
        }}
        variant="contained"
        onClick={handleOpen}
      >
        Sign Up
      </Button>
      <StyledDialog open={open} onClose={handleClose}>
        {<SignUp handleClose={handleClose} />}
      </StyledDialog>
    </div>
  );
}
export default SignUpDialog;
