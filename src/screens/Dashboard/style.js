import styled from "styled-components";
import BestWorstMatchup from "./components/BestWorstMatchup";
import PreviousMatches from "./components/PreviousMatches";

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

export const StyledBestWorst = styled(BestWorstMatchup)`
  flex: 1;
  margin: 20px;
  @media (max-device-width: 1024px) {
    margin: 20px auto;
  }
`;

export const StyledTwoCardDiv = styled.div`
  display: flex;
  justify-content: space-evenly;
  @media (max-device-width: 1024px) {
    flex-direction: column;
  }
`;

export const StyledPreviousMatches = styled(PreviousMatches)`
  flex: 1;
  margin: 20px;
`;
