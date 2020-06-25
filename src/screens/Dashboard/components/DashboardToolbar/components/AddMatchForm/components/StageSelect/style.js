import styled from "styled-components";
import ToggleButton from "@material-ui/lab/ToggleButton";
import Autocomplete from "@material-ui/lab/Autocomplete";
import TextField from "@material-ui/core/TextField";

export const StyledStageButton = styled(ToggleButton)`
  margin: 5px;
  min-width: 200px;
  max-width: 250px;
  @media (max-device-width: 700px) {
    max-width: 200px;
  }
  @media (max-device-width: 550px) {
    max-width: 350px;
  }
  .MuiToggleButton-label {
    img {
      width: 100%;
    }
    display: flex;
    flex-direction: column;
  }
`;

export const StyledAutocomplete = styled(Autocomplete)`
  font-size: 16px;
  width: 300px;
  margin: 0 auto;
  @media (max-device-width: 700px) {
    width: 90%;
  }
`;

export const StyledAutoTextField = styled(TextField)`
  font-size: 16px;
`;

export const StageButtonDiv = styled.div`
  display: flex;
  flex-wrap: wrap;
  justify-content: center;
`;
