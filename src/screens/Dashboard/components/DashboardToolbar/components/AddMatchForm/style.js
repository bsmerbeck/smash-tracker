import styled from "styled-components/macro";
import Select from "@material-ui/core/Select";
import Dialog from "@material-ui/core/Dialog";
import { MenuItem } from "@material-ui/core";

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

export const StyledSpriteSelectDiv = styled.div`
  @media (max-device-width: 500px) {
    display: flex;
    flex-direction: column;
    justify-content: space-between;
    .MuiInput-input {
      display: flex;
      flex-direction: column;
      justify-content: space-between;
    }
  }
`;

export const StyledAddMatchMenuItem = styled(MenuItem)`
  @media (max-device-width: 500px) {
    display: flex;
    flex-direction: column !important;
    align-items: center;
  }
`;
