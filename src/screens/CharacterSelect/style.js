import styled from "styled-components/macro";

export const StyledPrimaryCharacterDiv = styled.div`
  display: flex;
  flex-direction: column;
  align-items: center;
  div.primary-sprite-input {
    flex-direction: column;
    align-content: center;
    width: 50%;
    input {
      margin: 5px auto;
      font-size: 2em;
    }
    button {
      margin: 5px auto;
    }
  }
`;

export const StyledPrimarySpriteListDiv = styled.div`
  margin: 1em auto;
  width: 100%;
  display: flex;
  flex-direction: row;
  flex-wrap: wrap;
  justify-content: center;
  .sprite-button {
    max-width: 200px;
  }
`;
