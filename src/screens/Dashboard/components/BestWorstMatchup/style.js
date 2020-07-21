import styled from "styled-components/macro";
import Card from "@material-ui/core/Card";
import CardContent from "@material-ui/core/CardContent";

export const BestWorstCardDiv = styled.div`
  display: flex;
  justify-content: space-between;
  @media (max-device-width: 600px) {
    flex-direction: column;
  }
`;

export const StyledBWCard = styled(Card)`
  min-width: 200px;
  width: 100%;
  padding: 16px;
  display: flex;
  flex-direction: column;
`;

export const StyledBWSelectDiv = styled.div`
  padding: 5px 25px;
  .bwMenuItem {
    cursor: pointer;
  }
`;

export const StyledBWCardContent = styled(CardContent)`
  padding-bottom: 10px;
  div.spriteContainer {
    display: flex;
    img {
      max-height: 10vh;
      flex: 0;
    }
    div {
      text-align: end;
      flex: 1;
      justify-content: space-between;
    }
  }
  div.bwResult {
    display: flex;
    div {
      display: flex;
      justify-content: space-between;
      width: 100%;
    }
  }
`;
