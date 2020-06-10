import styled from "styled-components";
import Dialog from "@material-ui/core/Dialog";

export const StyledSignInInputDiv = styled.div`
  display: flex;
  align-items: center;
  justify-content: space-between;

  p,
  TextField {
    margin: 5px;
  }
`;

export const StyledDialog = styled(Dialog)`
  padding: 0 20px;
  div.start {
    padding: 20px;
  }
`;
