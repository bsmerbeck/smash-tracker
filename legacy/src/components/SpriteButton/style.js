import styled from "styled-components/macro";
import ToggleButton from "@material-ui/lab/ToggleButton";

export const StyledSpriteButton = styled(ToggleButton)`
  width: 100%;
  height: 100%;
  div {
    width: 100%;
    height: 100%;
    display: flex;
    flex-direction: column;
    text-align: center;
    img {
      width: 100%;
      height: 100%;
      object-fit: contain;
      align-self: center;
      pointer-events: none;
    }
    p {
      margin: 0 auto;
    }
  }
`;
