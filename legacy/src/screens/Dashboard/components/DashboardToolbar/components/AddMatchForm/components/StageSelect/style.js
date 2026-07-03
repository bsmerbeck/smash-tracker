import styled from "styled-components";
import ToggleButton from "@material-ui/lab/ToggleButton";
import Autocomplete from "@material-ui/lab/Autocomplete";
import TextField from "@material-ui/core/TextField";

export const StyledStageButton = styled(ToggleButton)`
  margin: 5px;
  min-width: 100px;
  max-width: 240px;
  @media (max-device-width: 700px) {
    max-width: 150px;
  }
  @media (max-device-width: 550px) {
    max-width: 35vw;
    padding: 2px;
    margin: 5px;
    p {
      font-size: 10px;
    }
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
  width: 100%;
  padding: 0;
`;
