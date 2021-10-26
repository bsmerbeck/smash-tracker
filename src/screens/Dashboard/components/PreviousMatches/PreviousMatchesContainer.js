import PreviousMatches from "./PreviousMatches";
import { firebaseConnect } from "react-redux-firebase";
import { compose } from "redux";
import { connect } from "react-redux";

const mapStateToProps = ({ firebase: { auth, analytics } }) => ({
  auth,
});

export default compose(
  connect(mapStateToProps, null), // Before firestoreConnect
  firebaseConnect((props) => [
    { path: `primaryFighters/${props.auth.uid}` },
    { path: `secondaryFighters/${props.auth.uid}` },
    { path: `matches/${props.auth.uid}`, queryParams: ["orderByChild=time"] },
    { path: `opponents/${props.auth.uid}` },
  ])
)(PreviousMatches);
