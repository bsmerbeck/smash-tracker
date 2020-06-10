import React from "react";
import clsx from "clsx";
import { makeStyles } from "@material-ui/styles";
import { Button } from "@material-ui/core";
import { DashboardContext } from "../../Dashboard";
import { AddMatchForm } from "./components";
import { SelectFighter } from "../../components";

const useStyles = makeStyles((theme) => ({
  root: {},
  row: {
    height: "42px",
    display: "flex",
    alignItems: "center",
    marginTop: theme.spacing(1),
  },
  spacer: {
    flexGrow: 1,
  },
  importButton: {
    marginLeft: theme.spacing(1),
  },
  exportButton: {
    marginRight: theme.spacing(1),
  },
  searchInput: {
    marginRight: theme.spacing(1),
  },
}));

const DashboardToolbar = (props) => {
  const { className, onSpriteClick, ...rest } = props;

  const [open, setOpen] = React.useState(false);
  const handleClickOpen = () => {
    setOpen(true);
  };

  const handleClose = () => {
    setOpen(false);
  };
  const classes = useStyles();

  return (
    <div {...rest} className={clsx(classes.root, className)}>
      <AddMatchForm open={open} handleClose={handleClose} />
      <div className={classes.row}>
        <SelectFighter />
        <span className={classes.spacer} />
        <Button
          color="primary"
          variant="contained"
          onClick={() => handleClickOpen()}
        >
          Add Match
        </Button>
      </div>
    </div>
  );
};

export default DashboardToolbar;
