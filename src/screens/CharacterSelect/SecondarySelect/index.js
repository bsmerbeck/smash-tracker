import React from "react";
import SecondarySelectContainer from "./SecondarySelectContainer";
import { withRouter } from "react-router";

const SecondarySelectScreen = ({ className }) => (
  <SecondarySelectContainer className={className} />
);

export default withRouter(SecondarySelectScreen);
