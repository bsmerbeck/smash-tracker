import React from "react";
import { withRouter, useHistory } from "react-router-dom";
import { useSelector } from "react-redux";
import { useFirebase, isLoaded, isEmpty } from "react-redux-firebase";
import { StyledFirebaseAuth } from "react-firebaseui";
import { Button } from "@material-ui/core";
import { makeStyles } from "@material-ui/styles";

import SignUp from "../User/UserSignUp";

import {
  StyledClassicBanner,
  StyledMainTitle,
  StyledMainInfo,
  StyledMainLogin,
} from "./style";

const useStyles = makeStyles((theme) => ({
  root: {
    padding: theme.spacing(0),
  },
  content: {
    marginTop: theme.spacing(2),
  },
}));

function HomePage() {
  const firebase = useFirebase();
  const history = useHistory();

  const auth = useSelector((state) => state.firebase.auth);

  const primaryFighters = useSelector(
    (state) => state.firebase.data.primaryFighters
  );

  function logout() {
    return firebase.logout();
  }

  function goToCharacter() {
    if (
      isEmpty(primaryFighters) ||
      primaryFighters[firebase.auth.uid] === null
    ) {
      return history.push("/choose-primary");
    }
    return history.push("/dashboard");
  }

  const classes = useStyles();

  return (
    <div className={classes.root}>
      <StyledClassicBanner
        src={process.env.PUBLIC_URL + "/assets/banners/classic-mode-banner.jpg"}
        alt=""
      />
      <StyledMainTitle className={classes.content}>
        <h1>Smash Tracker</h1>
      </StyledMainTitle>
      <StyledMainInfo>
        <p>
          December Update!{" "}
          <span style={{ color: "darkred" }}>Sephiroth Added.</span> Development
          back in progress!
        </p>
        <p></p>
        <p style={{ marginLeft: "5px", marginRight: "5px" }}>
          Smash Tracker is a fan-made dashboard to track your Smash Ultimate
          matches. By reporting your matches, the tracker will display your
          progress. View your best and worst matchups, progress by character,
          and more. Smash Tracker is ALWAYS open to feature suggestions.
        </p>
      </StyledMainInfo>
      <StyledMainLogin>
        {!isLoaded(auth) ? (
          <span>Loading...</span>
        ) : isEmpty(auth) ? (
          // <GoogleButton/> button can be used instead
          <div style={{ width: "100% " }}>
            <StyledFirebaseAuth
              uiConfig={{
                signInFlow: "redirect",
                signInOptions: [
                  firebase.auth.GoogleAuthProvider.PROVIDER_ID,
                  firebase.auth.EmailAuthProvider.PROVIDER_ID,
                ],
                callbacks: {
                  signInSuccessWithAuthResult: (authResult, redirectUrl) => {
                    firebase.handleRedirectResult(authResult).then(() => {
                      history.push(redirectUrl);
                    });
                    return false;
                  },
                },
              }}
              firebaseAuth={firebase.auth()}
            />
            <SignUp />
          </div>
        ) : (
          <div>
            <Button
              className="homeButton"
              variant="contained"
              onClick={() => goToCharacter()}
            >
              Start
            </Button>
            <Button className="homeButton" variant="contained" onClick={logout}>
              Logout
            </Button>
          </div>
        )}
      </StyledMainLogin>
    </div>
  );
}

export default withRouter(HomePage);
