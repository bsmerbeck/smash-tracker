import styled from "styled-components";
import Card from "@material-ui/core/Card";

export const StyledResultCard = styled(Card)`
  max-width: 50vw;
  margin: 0 auto;
  @media (max-device-width: 1100px) {
    max-width: 100%;
  }
`;

export const StyledStatRowDiv = styled.div`
  display: flex;
  width: 100%;
  flex-direction: row;
  justify-content: space-between;
  align-items: center;
  .fName {
    flex: 1;
  }
  .winLoss {
    display: flex;
    justify-content: space-around;
    flex: 1;
    @media (max-device-width: 900px) {
      flex: 1.5;
    }
  }
  h2,
  p {
    text-align: center;
  }
`;
