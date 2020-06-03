import React from "react";
import "./App.css";
import { Route, Switch } from "react-router-dom";
import HomeScreen from "./screens/Home";
import PrimarySelectScreen from "./screens/CharacterSelect/PrimarySelect";
import SecondarySelectScreen from "./screens/CharacterSelect/SecondarySelect";
import DashboardScreen from "./screens/Dashboard";

import Navbar from "./screens/Layout/Navbar";
import Routes from "./Routes";

const App = (props) => {
  return <Routes />;

  {
    /*<Navbar />*/
  }
  {
    /*<Switch>*/
  }
  {
    /*  <Route exact path="/" component={HomeScreen} />*/
  }
  {
    /*  <Route path="/choose-primary" component={PrimarySelectScreen} />*/
  }
  {
    /*  <Route path="/choose-secondary" component={SecondarySelectScreen} />*/
  }
  {
    /*  <Route path="/dashboard" component={DashboardScreen} />*/
  }
  {
    /*</Switch>*/
  }
};

export default App;
