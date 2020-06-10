import React, { useState } from "react";
import { useHistory } from "react-router-dom";
import clsx from "clsx";
import PropTypes from "prop-types";
import { makeStyles } from "@material-ui/styles";
import {
  AppBar,
  Toolbar,
  Badge,
  Hidden,
  IconButton,
  Typography,
} from "@material-ui/core";
import MenuIcon from "@material-ui/icons/Menu";
import NotificationsIcon from "@material-ui/icons/NotificationsOutlined";
import InputIcon from "@material-ui/icons/Input";
import Link from "@material-ui/core/Link";
import { useFirebase } from "react-redux-firebase";

const useStyles = makeStyles((theme) => ({
  root: {
    boxShadow: "none",
  },
  Link: {
    cursor: "pointer",
  },
  flexGrow: {
    flexGrow: 1,
  },
  signOutButton: {
    marginLeft: theme.spacing(1),
  },
}));

const Topbar = (props) => {
  const firebase = useFirebase();
  const { className, onSidebarOpen, ...rest } = props;

  const history = useHistory();
  const classes = useStyles();

  const [notifications] = useState([]);

  const handleTitleClick = () => {
    history.push("/");
  };

  return (
    <AppBar {...rest} className={clsx(classes.root, className)}>
      <Toolbar>
        <Link
          className={classes.Link}
          noWrap
          onClick={handleTitleClick}
          color="inherit"
        >
          <Typography variant="h3">Smash Tracker</Typography>
        </Link>
        <div className={classes.flexGrow} />
        <Hidden mdDown>
          <IconButton
            className={classes.signOutButton}
            color="inherit"
            onClick={() => {
              firebase.logout().then(() => {
                history.push("/");
              });
            }}
          >
            <InputIcon />
          </IconButton>
        </Hidden>
        <Hidden lgUp>
          <IconButton color="inherit" onClick={onSidebarOpen}>
            <MenuIcon />
          </IconButton>
        </Hidden>
      </Toolbar>
    </AppBar>
  );
};

Topbar.propTypes = {
  className: PropTypes.string,
  onSidebarOpen: PropTypes.func,
};

export default Topbar;
