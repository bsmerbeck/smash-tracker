import React from "react";
import { StyledSpriteButton } from "./style";

const SpriteButton = (props) => {
  return (
    <StyledSpriteButton
      variant="outlined"
      value={props.value}
      selected={props.selected}
      color="default"
      className="sprite-button"
      onClick={props.onClick}
    >
      <div>
        <img
          onLoad={props.handleLoad}
          src={props.sprite.url}
          alt={`${props.sprite.name.toLowerCase()}-sprite`}
        />
        <p className="SpriteButtonLabel">{props.sprite.name}</p>
      </div>
    </StyledSpriteButton>
  );
};

export default SpriteButton;
