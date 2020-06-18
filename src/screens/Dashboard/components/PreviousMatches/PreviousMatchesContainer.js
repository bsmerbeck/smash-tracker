import PreviousMatches from "./PreviousMatches";
import { firebaseConnect } from "react-redux-firebase";
import { compose } from "redux";
import { connect } from "react-redux";

const mapStateToProps = ({ firebase: { auth } }) => ({
  auth,
});

export default compose(
  connect(mapStateToProps, null), // Before firestoreConnect
  firebaseConnect((props) => [
    { path: `matches/${props.auth.uid}`, queryParams: ["orderByChild=time"] },
  ])
)(PreviousMatches);
