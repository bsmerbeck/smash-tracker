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

  function logout() {
    return firebase.logout();
  }

  function goToCharacter() {
    return history.push("/choose-primary");
  }

  const classes = useStyles();

  return (
    <div className={classes.root}>
      <StyledClassicBanner
        src={process.env.PUBLIC_URL + "/assets/banners/classic-mode-banner.png"}
        alt=""
      />
      <StyledMainTitle className={classes.content}>
        <h1>Smash Tracker</h1>
      </StyledMainTitle>
      <StyledMainInfo>
        <p>
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
          <div>
            <StyledFirebaseAuth
              uiConfig={{
                signInFlow: "redirect",
                signInSuccessUrl: "/choose-character",
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
            <Button variant="contained" onClick={() => goToCharacter()}>
              Start
            </Button>
            <Button variant="contained" onClick={logout}>
              Logout
            </Button>
          </div>
        )}
      </StyledMainLogin>
    </div>
  );
}

export default withRouter(HomePage);
