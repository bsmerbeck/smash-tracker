import styled from "styled-components/macro";

export const StyledDashFighterBarDiv = styled.div`
  width: 100%;
  height: 10vh;
  h3 {
    margin: 5px auto;
  }
  .SpriteBarDiv {
    width: fit-content;
    max-width: 100%;
    display: flex;
    flex-direction: row;
  }
  .SpriteBarDiv p {
    display: none;
  }
  .sprite-button {
    max-width: 100px;
  }
`;
