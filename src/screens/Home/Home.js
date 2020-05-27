import React from "react";
import { useSelector } from "react-redux";
import {
  useFirebase,
  isLoaded,
  isEmpty,
  useFirebaseConnect,
} from "react-redux-firebase";
import { Button } from "@material-ui/core";
import {
  StyledClassicBanner,
  StyledMainTitle,
  StyledMainInfo,
  StyledMainLogin,
} from "./style";

function HomePage() {
  const firebase = useFirebase();

  const auth = useSelector((state) => state.firebase.auth);

  function loginWithGoogle() {
    return firebase.login({ provider: "google", type: "popup" });
  }

  function logout() {
    return firebase.logout();
  }
  useFirebaseConnect([{ path: "sprites" }]);

  const sprites = useSelector((state) => state.firebase.ordered.sprites);

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
            <Button variant="contained">Start</Button>
            <Button variant="contained" onClick={logout}>
              Logout
            </Button>
          </div>
        )}
      </StyledMainLogin>
      <div>
        {isLoaded(sprites) ? (
          sprites.map((sprite) => {
            return <img src={sprite.value.url} alt="" />;
          })
        ) : (
          <p>Loading</p>
        )}
      </div>
    </div>
  );
}

export default HomePage;
