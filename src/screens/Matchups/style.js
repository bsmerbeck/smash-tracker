import styled from "styled-components/macro";
import { Card } from "@material-ui/core";
import theme from "../../theme";
import { SelectFighter } from "./components";

export const StyledMatchupCard = styled(Card)`
  width: 100%;
  max-height: 90px;
`;

export const StyledMatchupSelectDiv = styled.div`
  padding: 3px;
  display: flex;
  flex-direction: row;
  align-items: center;
  h3 {
    margin: 2px auto;
    color: ${theme.palette.primary.main};
  }
  .SelectFighter {
    padding: 3px;
  }
`;
