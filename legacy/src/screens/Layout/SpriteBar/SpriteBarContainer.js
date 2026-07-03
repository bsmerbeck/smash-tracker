import { compose } from "redux";
import { connect } from "react-redux";
import { firebaseConnect } from "react-redux-firebase";
import SpriteBar from "./SpriteBar";

const populates = [{ child: "id", root: "sprites" }];
export default compose(
  // connect auth from redux state to the auth prop
  connect(({ firebase: { auth } }) => ({ auth })),
  // Show spinner while auth is loading
  // Create a listener for registrations where user.uid == current user uid
  firebaseConnect((props) => [
    { path: `primaryFighters/${props.auth.uid}`, populates },
    { path: `secondaryFighters/${props.auth.uid}`, populates },
  ])
)(SpriteBar);

//export default SpriteBar;
