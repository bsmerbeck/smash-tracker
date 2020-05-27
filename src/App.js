import React from "react";
import "./App.css";
import { Route, Switch } from "react-router-dom";
import HomeScreen from "./screens/Home";
import Character from "./screens/CharacterSelect";
import Navbar from "./screens/Layout/Navbar";

const App = () => {
  return (
    <div>
      <Navbar />
      <Switch>
        <Route exact path="/" component={HomeScreen} />
        <Route path="/signedIn" component={Character} />
      </Switch>
    </div>
  );
};

export default App;
