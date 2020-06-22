import styled from "styled-components";
import ToggleButton from "@material-ui/lab/ToggleButton";

export const StyledStageButton = styled(ToggleButton)`
  margin: 5px;
  .MuiToggleButton-label {
    img {
      max-height: 10vh;
      max-width: 10vw;
    }
    display: flex;
    flex-direction: column;
  }
`;

export const StageButtonDiv = styled.div`
  display: flex;
  flex-wrap: wrap;
  justify-content: center;
`;
