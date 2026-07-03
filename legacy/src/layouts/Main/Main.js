import React, { useState } from "react";
import PropTypes from "prop-types";
import clsx from "clsx";
import { isLoaded, isEmpty } from "react-redux-firebase";
import { makeStyles, useTheme } from "@material-ui/styles";
import { useMediaQuery } from "@material-ui/core";

import { Sidebar, Topbar, Footer } from "./components";
import { useSelector } from "react-redux";

const useStyles = makeStyles((theme) => ({
  root: {
    paddingTop: 56,
    height: "100%",
    [theme.breakpoints.up("sm")]: {
      paddingTop: 64,
    },
  },
  shiftContent: {
    paddingLeft: 240,
  },
  content: {
    height: "100%",
  },
}));

const Main = (props) => {
  const { children } = props;
  const auth = useSelector((state) => state.firebase.auth);

  const classes = useStyles();
  const theme = useTheme();
  const isDesktop = useMediaQuery(theme.breakpoints.up("lg"), {
    defaultMatches: true,
  });

  const [openSidebar, setOpenSidebar] = useState(false);

  const handleSidebarOpen = () => {
    setOpenSidebar(true);
  };

  const handleSidebarClose = () => {
    setOpenSidebar(false);
  };

  const shouldOpenSidebar = isDesktop ? true : openSidebar;

  return (
    <div
      className={clsx({
        [classes.root]: true,
        [classes.shiftContent]: isDesktop && isLoaded(auth) && !isEmpty(auth),
      })}
    >
      <Topbar onSidebarOpen={handleSidebarOpen} />
      {isLoaded(auth) && !isEmpty(auth) && (
        <Sidebar
          onClose={handleSidebarClose}
          open={shouldOpenSidebar}
          variant={isDesktop ? "persistent" : "temporary"}
        />
      )}
      <main className={classes.content}>
        {children}
        <Footer />
      </main>
    </div>
  );
};

Main.propTypes = {
  children: PropTypes.node,
};

export default Main;
