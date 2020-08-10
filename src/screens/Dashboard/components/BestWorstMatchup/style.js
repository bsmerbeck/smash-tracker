import styled from "styled-components/macro";
import Card from "@material-ui/core/Card";
import CardContent from "@material-ui/core/CardContent";

export const BestWorstCardDiv = styled.div`
  display: flex;
  justify-content: space-between;
  @media (max-width: 500px) {
    flex-direction: column;
    margin: 0 auto;
  }
`;

export const StyledBWCard = styled(Card)`
  min-width: 200px;
  width: 100%;
  padding: 16px;
  display: flex;
  flex-direction: column;
  div.MuiCardContent-root:last-child {
    padding: 0;
  }
`;

export const StyledBWSelectDiv = styled.div`
  div {
    padding: 5px;
  }
  padding: 5px 25px;
  .bwMenuItem {
    cursor: pointer;
  }
`;

export const StyledBWCardContent = styled(CardContent)`
  padding-bottom: 10px;
  div.spriteContainer {
    display: flex;
    align-items: center;
    img {
      max-height: 5vh;
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

  div.MuiCardContent-root:last-child {
    padding: 5px;
  }
`;
