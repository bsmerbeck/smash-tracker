import styled from "styled-components/macro";
import Button from "@material-ui/core/Button";

export const StyledSpriteButton = styled(Button)`
  width: fit-content;
  div {
    display: flex;
    flex-direction: column;
    text-align: center;
    img {
      width: 50%;
      align-self: center;
    }
  }
`;
