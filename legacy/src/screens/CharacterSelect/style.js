import styled from "styled-components/macro";

export const StyledPrimaryCharacterDiv = styled.div`
  display: flex;
  flex-direction: column;
  align-items: center;
  div.primary-sprite-input {
    flex-direction: column;
    align-content: center;
    width: 50%;
    @media (max-device-width: 1100px) {
      width: 80%;
    }
    @media (max-device-width: 600px) {
      width: 100%%;
    }
    input {
      margin: 5px auto;
      font-size: 2em;
    }
    button {
      margin: 5px auto;
      @media (max-device-width: 1100px) {
        width: 80%;
      }
      @media (max-device-width: 600px) {
        width: 100%;
      }
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
    @media (max-device-width: 400px) {
      max-width: 40%;
    }
  }
`;
