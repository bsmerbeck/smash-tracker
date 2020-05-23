import { combineReducers } from "redux";
import { connectRouter } from "connected-react-router";
import { firebaseReducer, firestoreReducer } from "react-redux-firebase";

const rootReducer = (history) =>
  combineReducers({
    router: connectRouter(history),
    firebase: firebaseReducer,
    firestore: firestoreReducer,
  });

export default rootReducer;
