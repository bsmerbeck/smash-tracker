import PrimarySelect from "./PrimarySelect";
import { compose } from "redux";
import { connect } from "react-redux";
import { firebaseConnect } from "react-redux-firebase";

const mapStateToProps = ({ firebase: { auth } }) => ({
  auth,
});

export default compose(
  connect(mapStateToProps, null), // Before firestoreConnect
  firebaseConnect((props) => [{ path: `primaryFighters/${props.auth.uid}` }])
)(PrimarySelect);
