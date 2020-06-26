import MatchData from "./MatchData";
import { connect } from "react-redux";
import { compose } from "redux";
import { firebaseConnect } from "react-redux-firebase";

const mapStateToProps = ({ firebase: { auth } }) => ({
  auth,
});

export default compose(
  connect(mapStateToProps, null), // Before firestoreConnect
  firebaseConnect((props) => [
    { path: `primaryFighters/${props.auth.uid}` },
    { path: `secondaryFighters/${props.auth.uid}` },
    { path: `matches/${props.auth.uid}`, queryParams: ["orderByKey"] },
    { path: `opponents/${props.auth.uid}` },
  ])
)(MatchData);
