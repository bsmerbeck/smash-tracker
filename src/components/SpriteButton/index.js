import React from "react";
import { StyledSpriteButton } from "./style";

const SpriteButton = (props) => {
  return (
    <StyledSpriteButton
      variant="outlined"
      color="default"
      className="sprite-button"
      onClick={props.onClick}
    >
      <div>
        <img
          onLoad={props.handleLoad}
          src={props.sprite.value.url}
          alt={`${props.sprite.value.name.toLowerCase()}-sprite`}
        />
        <p>{props.sprite.value.name}</p>
      </div>
    </StyledSpriteButton>
  );
};

export default SpriteButton;
