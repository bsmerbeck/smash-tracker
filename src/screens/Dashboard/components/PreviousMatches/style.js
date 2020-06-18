import styled from "styled-components";

export const StyledPreviousContainerDiv = styled.div`
  display: flex;
  justify-content: space-between;
  align-items: center;
  .fighterDiv {
    display: flex;
    width: 100%;
  }
`;

export const StyledPreviousFighterIconDiv = styled.div`
  display: flex;
  min-width: 140px;
  img {
    flex: 1;
    max-width: 5vh;
    @media (max-device-width: 500px) {
      max-width: 10vw;
    }
  }
  p {
    flex: 1;
  }
  @media (max-device-width: 500px) {
    min-width: unset;
    align-items: center;
    text-align: center;
  }
`;
