import styled from "styled-components";
import Card from "@material-ui/core/Card";

export const StyledStreakCard = styled(Card)`
  div.MuiCardContent-root {
    width: 100%;
    height: 100%;
  }
`;
export const StyledStreakCardContentDiv = styled.div`
  display: flex;
  width: 100%;
  height: 100%;
  align-items: center;
  div {
    flex: 1;
    text-align: center;
  }

  h2 {
    margin-bottom: 2px;
    margin-top: 5px;
  }

  h2.winCount {
    color: limegreen;
  }

  h2.lossCount {
    color: orangered;
  }

  p {
    margin-top: 1px;
    margin-bottom: 10px;
  }
  h2.currentStreak {
    color: ${(props) => (props.lastValue ? "limegreen" : "orangered")};
  }
`;
