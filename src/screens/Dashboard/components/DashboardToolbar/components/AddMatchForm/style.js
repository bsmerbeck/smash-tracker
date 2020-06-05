import styled from "styled-components/macro";
import Select from "@material-ui/core/Select";
import Dialog from "@material-ui/core/Dialog";

export const StyledIconSelect = styled(Select)`
  .MuiInputBase-input {
    display: flex;
    align-items: center;
  }
`;

export const StyledDialog = styled(Dialog)`
  max-width: 100%;
`;

export const StyledMatchRow = styled.div`
  display: flex;
  justify-content: space-evenly;
  padding: 10px;
`;
