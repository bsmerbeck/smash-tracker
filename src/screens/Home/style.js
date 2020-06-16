import styled from "styled-components/macro";

export const StyledClassicBanner = styled.img`
  width: 100%;
  height: auto;
`;

export const StyledMainTitle = styled.div`
  width: 100%;
  h1 {
    line-height: 40px;
    align-self: center;
    text-align: center;
    font-size: 4em;
  }
`;

export const StyledMainInfo = styled.div`
  width: 100%;
  p {
    text-align: center;
    font-size: 1.5em;
  }
`;

export const StyledMainLogin = styled.div`
  margin: 0 auto;
  align-items: center;
  width: 30%;
  @media (max-device-width: 1000px) {
    width: 70%;
  }
  @media (max-device-width: 1000px) {
    width: 80%;
  }
  display: flex;
  flex-direction: column;
  div {
    width: 100%;
    Button {
      width: 100%;
      margin: 5px 0;
    }
  }
`;
