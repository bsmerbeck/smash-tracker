import React, { useState } from "react";
import SpriteBar from "../Layout/SpriteBar";

const Dashboard = () => {
  const [fighter, setFighter] = useState({});

  function onSpriteClick(e, sprite) {
    setFighter(sprite);
    console.log(JSON.stringify(sprite));
  }

  return (
    <div>
      <SpriteBar onSpriteClick={(e, sprite) => onSpriteClick(e, sprite)} />
      <h1>Dashboard</h1>
    </div>
  );
};

export default Dashboard;
