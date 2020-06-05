import AddMatchForm from "./AddMatchForm";
import { compose } from "redux";
import { connect } from "react-redux";
import { firebaseConnect } from "react-redux-firebase";

//const populates = [{ child: "id", root: "sprites" }];
// export default compose(
//     // connect auth from redux state to the auth prop
//     connect(({ firebase: { auth } }) => ({ auth })),
//     // Show spinner while auth is loading
//     // Create a listener for registrations where user.uid == current user uid
//     firebaseConnect((props) => [
//         { type: "once", path: `primaryFighters/${props.auth.uid}`, populates },
//         { type: "once", path: `secondaryFighters/${props.auth.uid}`, populates },
//     ])
// )(AddMatchForm);

const mapStateToProps = ({ firebase: { auth } }) => ({
  auth,
});

export default compose(
  connect(mapStateToProps, null), // Before firestoreConnect
  firebaseConnect((props) => [
    { path: `primaryFighters/${props.auth.uid}` },
    { path: `secondaryFighters/${props.auth.uid}` },
  ])
)(AddMatchForm);
