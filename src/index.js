import React from "react";
import ReactDOM from "react-dom";
import "./index.css";

import * as serviceWorker from "./serviceWorker";

import { Provider } from "react-redux";
import { ReactReduxFirebaseProvider } from "react-redux-firebase";

import { ThemeProvider } from "@material-ui/styles";
import { CssBaseline } from "@material-ui/core";
import theme from "./theme";

import firebase from "firebase/app";
import { firebaseConfig } from "./firebase";

import { Router } from "react-router-dom"; // react-router v4/v5
import configureStore, { history } from "./state/configureStore";
import App from "./App";
const store = configureStore();

const rrfProps = {
  firebase,
  config: firebaseConfig,
  dispatch: store.dispatch,
};

ReactDOM.render(
  <Provider store={store}>
    <Router history={history}>
      <ReactReduxFirebaseProvider {...rrfProps}>
        <ThemeProvider theme={theme}>
          <CssBaseline />
          <App history={history} />
        </ThemeProvider>
      </ReactReduxFirebaseProvider>
    </Router>
  </Provider>,
  document.getElementById("root")
);

// If you want your app to work offline and load faster, you can change
// unregister() to register() below. Note this comes with some pitfalls.
// Learn more about service workers: https://bit.ly/CRA-PWA
serviceWorker.unregister();
