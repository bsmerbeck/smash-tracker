import Home from "./Home";
import { connect } from "react-redux";
import { push } from "connected-react-router";
import { withRouter } from "react-router-dom";
import {
  firebaseConnect,
  isLoaded,
  isEmpty,
  getFirebase,
} from "react-redux-firebase";

export default withRouter(Home);
