import React, { useState } from "react";
import { useSelector } from "react-redux";
import {
  useFirebase,
  useFirebaseConnect,
  isLoaded,
  isEmpty,
} from "react-redux-firebase";
import SpriteButton from "../../../components/SpriteButton";
import { NavigateNext, NavigateBefore } from "@material-ui/icons";
import { SpriteList } from "../../../components/Sprites/SpriteList";
import { StyledSpriteBarMainDiv } from "./style";

const SpriteBar = (props) => {
  const auth = props.auth;
  const fighter = props.fighter;

  const primaryFighters = useSelector(
    (state) => state.firebase.data.primaryFighters
  );
  const secondaryFighters = useSelector(
    (state) => state.firebase.data.secondaryFighters
  );
  if (!isLoaded(primaryFighters) || !isLoaded(secondaryFighters)) {
    return <div>Loading</div>;
  }

  const spriteList = [
    ...primaryFighters[auth.uid],
    ...secondaryFighters[auth.uid],
  ];
  return (
    <StyledSpriteBarMainDiv>
      <h3>Fighter Select</h3>
      <div className="SpriteBarDiv">
        {spriteList.map((s) => {
          const sprite = SpriteList.filter((sp) => sp.id === s)[0];
          return (
            <SpriteButton
              value={props.fighter && props.fighter.id === sprite.id}
              selected={props.fighter && props.fighter.id === sprite.id}
              key={sprite.id}
              sprite={sprite}
              onClick={(e) => props.onSpriteClick(e, sprite)}
            />
          );
        })}
      </div>
    </StyledSpriteBarMainDiv>
  );
};

export default SpriteBar;
