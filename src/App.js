import React from "react";
import "./App.css";
import { Route, Switch } from "react-router";
import HomeScreen from "./screens/Home";
import { ConnectedRouter } from "connected-react-router";
import Navbar from "./screens/Layout/Navbar";

const App = ({ history }) => {
  return (
    <ConnectedRouter history={history}>
      <Navbar />
      <Switch>
        <Route exact path="/" render={() => <HomeScreen />} />
      </Switch>
    </ConnectedRouter>
  );
};

export default App;
