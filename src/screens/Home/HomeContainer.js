import Home from "./Home";
import { connect } from "react-redux";
import {
  firebaseConnect,
  isLoaded,
  isEmpty,
  getFirebase,
} from "react-redux-firebase";

const mapStateToProps = (state) => ({
  auth: state.firebase.auth,
});

export default connect(mapStateToProps, null)(Home);
