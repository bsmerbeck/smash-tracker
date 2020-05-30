import styled from "styled-components/macro";

export const StyledPrimaryCharacterDiv = styled.div`
  display: flex;
  flex-direction: column;
  align-items: center;
  div.primary-sprite-list {
    margin: 1em auto;
    display: flex;
    flex-wrap: wrap;
    justify-content: center;
  }
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
  display: flex;
  flex-wrap: wrap;
  justify-content: center;
`;
