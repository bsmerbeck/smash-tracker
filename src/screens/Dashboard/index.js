import React, { useState, createContext } from "react";
import SpriteBar from "../Layout/SpriteBar";
import { StyledDashFighterBarDiv } from "./style";

const Dashboard = () => {
  const [fighter, setFighter] = useState({});

  function onSpriteClick(e, sprite) {
    setFighter(sprite);
  }

  return (
    <div>
      <StyledDashFighterBarDiv>
        <SpriteBar
          className="DashSpriteBar"
          onSpriteClick={onSpriteClick}
          fighter={fighter}
        />
      </StyledDashFighterBarDiv>

      <h1>Dashboard</h1>
      <p>{`You've selected ${fighter.name}`}</p>
    </div>
  );
};

export default Dashboard;
