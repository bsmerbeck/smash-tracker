import React from "react";
import "./App.css";
import { Route, Switch } from "react-router-dom";
import HomeScreen from "./screens/Home";
import CharacterScreen from "./screens/CharacterSelect";
import Navbar from "./screens/Layout/Navbar";

const App = () => {
  return (
    <div>
      <Navbar />
      <Switch>
        <Route exact path="/" component={HomeScreen} />
        <Route path="/choose-character" component={CharacterScreen} />
      </Switch>
    </div>
  );
};

export default App;
