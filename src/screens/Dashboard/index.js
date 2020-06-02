import React, { useState, createContext } from "react";
import SpriteBar from "../Layout/SpriteBar";

const Dashboard = () => {
  const [fighter, setFighter] = useState({});

  function onSpriteClick(e, sprite) {
    setFighter(sprite);
  }

  return (
    <div>
      <SpriteBar onSpriteClick={onSpriteClick} />
      <h1>Dashboard</h1>
    </div>
  );
};

export default Dashboard;
