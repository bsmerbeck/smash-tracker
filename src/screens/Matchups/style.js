import styled from "styled-components/macro";
import { Card } from "@material-ui/core";
import theme from "../../theme";

export const StyledMatchupCard = styled(Card)`
  width: 100%;
  max-height: 120px;
`;

export const StyledMatchupSelectDiv = styled.div`
  padding: 3px;
  display: flex;
  flex-direction: column;
  align-items: center;
    }
  h3 {
    margin: 2px auto;
    color: ${theme.palette.primary.main};
  }
  .SelectFighter {
    padding: 3px;
  }
`;

export const StyledMatchupDiv = styled.div`
  @media only screen and (max-width: 760px),
    (min-device-width: 768px) and (max-device-width: 1024px) {
    flex-direction: column-reverse;
  }
`;

export const StyledMatchupChartDiv = styled.div`
  margin: 20px auto;
  width: 40vw;
  height: 30vh;
  @media only screen and (max-width: 760px),
    (min-device-width: 768px) and (max-device-width: 1024px) {
    width: 100vw;
    height: 50vh;
  }

  @media (max-device-width: 500px) {
    height: 30vh;
    width: 100vw;
  }
`;
