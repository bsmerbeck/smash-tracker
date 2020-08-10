/* eslint-disable react/no-multi-comp */
/* eslint-disable react/display-name */
import React, { forwardRef } from "react";
import { NavLink as RouterLink, useHistory } from "react-router-dom";
import clsx from "clsx";
import PropTypes from "prop-types";
import { makeStyles } from "@material-ui/styles";
import { List, ListItem, Button, useMediaQuery } from "@material-ui/core";
import ExitToAppIcon from "@material-ui/icons/ExitToApp";
import theme from "../../../../../../theme";
import FavoriteBorderOutlinedIcon from "@material-ui/icons/FavoriteBorderOutlined";
import { useFirebase } from "react-redux-firebase";
import SSBUDiscordIcon from "./SSBU_TG-03.png";

const useStyles = makeStyles((theme) => ({
  root: {
    height: "100%",
  },
  item: {
    display: "flex",
    paddingTop: 0,
    paddingBottom: 0,
  },
  button: {
    color: theme.palette.white,
    padding: "10px 8px",
    justifyContent: "flex-start",
    textTransform: "none",
    letterSpacing: 0,
    width: "100%",
    fontWeight: theme.typography.fontWeightMedium,
  },
  icon: {
    color: theme.palette.icon,
    width: 24,
    height: 24,
    display: "flex",
    alignItems: "center",
    marginRight: theme.spacing(1),
  },
  active: {
    color: theme.palette.primary.main,
    fontWeight: theme.typography.fontWeightMedium,
    "& $icon": {
      color: theme.palette.primary.main,
    },
  },
}));

const CustomRouterLink = forwardRef((props, ref) => (
  <div ref={ref} style={{ flexGrow: 1 }}>
    <RouterLink {...props} />
  </div>
));

const SidebarNav = (props) => {
  const firebase = useFirebase();
  const history = useHistory();
  const { pages, className, ...rest } = props;

  const classes = useStyles();

  const isDesktop = useMediaQuery(theme.breakpoints.up("lg"), {
    defaultMatches: true,
  });

  return (
    <List {...rest} className={clsx(classes.root, className)}>
      {pages.map((page) => (
        <ListItem className={classes.item} disableGutters key={page.title}>
          <Button
            activeClassName={classes.active}
            className={classes.button}
            component={CustomRouterLink}
            to={page.href}
          >
            <div className={classes.icon}>{page.icon}</div>
            {page.title}
          </Button>
        </ListItem>
      ))}
      {!isDesktop && (
        <ListItem style={{ padding: 0 }}>
          <Button
            className={classes.button}
            onClick={() => {
              firebase.logout().then(() => {
                history.push("/");
              });
            }}
          >
            <div className={classes.icon}>
              <ExitToAppIcon />
            </div>
            Logout
          </Button>
        </ListItem>
      )}
      <ListItem
        style={{
          position: "absolute",
          bottom: 0,
          display: "flex",
          flexDirection: "column",
        }}
      >
        <Button
          variant="contained"
          color="primary"
          style={{
            display: "flex",
            justifyContent: "space-evenly",
            alignItems: "center",
            textTransform: "unset",
            width: "100%",
            marginBottom: "10px",
            padding: "0",
          }}
          onClick={() => {
            window.open("https://discord.gg/9TN8RFZ");
          }}
        >
          <img
            style={{ width: "40px", height: "40px", borderRadius: "20px" }}
            src={SSBUDiscordIcon}
            alt="SSBU Training Grounds"
          />
          <p>Training Grounds</p>
        </Button>
        <a
          className="dbox-popup"
          style={{
            background: "#41a2d8",
            color: "#fff",
            textDecoration: "none",
            display: "inline-block",
            padding: "1px",
            width: "100%",
            WebkitBorderRadius: "2px",
            MozBorderRadius: "2px",
            borderRadius: "2px",
            boxShadow: "0 1px 0 0 #1f5a89",
            textShadow: "0 1px rgba(0, 0, 0, 0.3)",
          }}
          href="https://donorbox.org/support-smash-tracker"
        >
          <div
            style={{
              display: "flex",
              justifyContent: "space-evenly",
              alignItems: "center",
              margin: "3px",
            }}
          >
            <FavoriteBorderOutlinedIcon />
            <p style={{ fontSize: "14px" }}>Donate</p>
          </div>
        </a>
      </ListItem>
    </List>
  );
};

SidebarNav.propTypes = {
  className: PropTypes.string,
  pages: PropTypes.array.isRequired,
};

export default SidebarNav;
