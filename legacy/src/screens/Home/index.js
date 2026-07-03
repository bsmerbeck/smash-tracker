import React from "react";
import HomeContainer from "./HomeContainer";
import { withRouter } from "react-router";

const HomeScreen = ({ className }) => <HomeContainer className={className} />;

export default withRouter(HomeScreen);
