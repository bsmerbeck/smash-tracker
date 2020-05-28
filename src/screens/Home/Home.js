import React, { useState } from "react";
import { useDispatch } from "react-redux";
import { withRouter, useHistory } from "react-router-dom";
import { useSelector } from "react-redux";
import {
  useFirebase,
  isLoaded,
  isEmpty,
  useFirebaseConnect,
} from "react-redux-firebase";
import { StyledFirebaseAuth } from "react-firebaseui";
import { Button } from "@material-ui/core";
import {
  StyledClassicBanner,
  StyledMainTitle,
  StyledMainInfo,
  StyledMainLogin,
} from "./style";

function HomePage() {
  const firebase = useFirebase();
  const history = useHistory();

  const auth = useSelector((state) => state.firebase.auth);
  function loginWithGoogle() {
    return firebase.login({ provider: "google", type: "popup" });
  }

  function logout() {
    return firebase.logout();
  }

  function goToCharacter() {
    return history.push("/choose-character");
  }

  return (
    <div>
      <div>
        <StyledClassicBanner
          src="https://github.com/bsmerbeck/smash-tracker-images/blob/master/assets/banners/classic-mode-banner.png?raw=true"
          alt=""
        />
      </div>
      <StyledMainTitle>
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
      <StyledFirebaseAuth
        uiConfig={{
          signInFlow: "popup",
          signInSuccessUrl: "/choose-character",
          signInOptions: [firebase.auth.GoogleAuthProvider.PROVIDER_ID],
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
      <StyledMainLogin>
        {!isLoaded(auth) ? (
          <span>Loading...</span>
        ) : isEmpty(auth) ? (
          // <GoogleButton/> button can be used instead
          <div>
            <Button variant="contained" onClick={loginWithGoogle}>
              Login
            </Button>
            <Button variant="contained">Sign Up</Button>
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
