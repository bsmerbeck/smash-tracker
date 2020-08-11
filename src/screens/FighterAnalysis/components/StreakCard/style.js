import styled from "styled-components";

export const StyledStreakCardContentDiv = styled.div`
  display: flex;
  div {
    flex: 1;
    text-align: center;
  }

  h2.winCount {
    color: limegreen;
  }

  h2.lossCount {
    color: orangered;
  }

  h2.currentStreak {
    color: ${(props) => (props.lastValue ? "limegreen" : "orangered")};
  }
`;
