import React from "react";
import PrimarySelectContainer from "./PrimarySelectContainer";
import { withRouter } from "react-router";

const PrimarySelectScreen = ({ className }) => (
  <PrimarySelectContainer className={className} />
);

export default withRouter(PrimarySelectScreen);
