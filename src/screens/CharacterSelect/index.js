import React from "react";
import CharacterSelectContainer from "./CharacterSelectContainer";
import { withRouter } from "react-router";

const CharacterSelectScreen = ({ className }) => (
  <CharacterSelectContainer className={className} />
);

export default withRouter(CharacterSelectScreen);
