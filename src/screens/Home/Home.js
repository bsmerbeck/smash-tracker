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

  const [spriteList, setSpriteList] = useState([]);
  const [input, setInput] = useState("");

  const handleInputChange = (e) => setInput(e.currentTarget.value);

  const auth = useSelector((state) => state.firebase.auth);
  function loginWithGoogle() {
    return firebase.login({ provider: "google", type: "popup" });
  }

  function logout() {
    return firebase.logout();
  }
  useFirebaseConnect([{ path: "sprites" }]);

  const sprites = useSelector((state) => state.firebase.ordered.sprites);

  function goToCharacter() {
    return history.push("/signedIn");
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
          signInSuccessUrl: "/signedIn",
          signInOptions: [firebase.auth.GoogleAuthProvider.PROVIDER_ID],
          callbacks: {
            signInSuccessWithAuthResult: (authResult, redirectUrl) => {
              firebase.handleRedirectResult(authResult).then(() => {
                history.push(redirectUrl);
              });
              return true;
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
      <div>
        <input type="text" value={input} onChange={handleInputChange} />
        {isLoaded(sprites) ? (
          sprites
            .filter(
              (d) =>
                input === "" ||
                d.value.name.toLowerCase().startsWith(input.toLowerCase())
            )
            .map((sprite) => {
              return (
                <div>
                  <img src={sprite.value.url} alt="" key={sprite.key} />
                  <p>{sprite.value.name}</p>
                </div>
              );
            })
        ) : (
          <p>Loading</p>
        )}
      </div>
    </div>
  );
}

export default withRouter(HomePage);
