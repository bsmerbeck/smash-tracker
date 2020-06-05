import React from "react";
import { Switch, Redirect } from "react-router-dom";

import { RouteWithLayout } from "./components";
import { Main as MainLayout } from "./layouts";

import {
  Dashboard as DashboardView,
  Home as HomeView,
  PrimaryCharacterSelect as PrimarySelect,
  SecondaryCharacterSelect as SecondarySelect,
  NotFound as NotFoundView,
} from "./screens";

const Routes = () => {
  return (
    <Switch>
      <RouteWithLayout
        component={HomeView}
        exact
        layout={MainLayout}
        path="/"
      />
      <RouteWithLayout
        component={DashboardView}
        layout={MainLayout}
        path="/dashboard"
      />
      <RouteWithLayout
        component={PrimarySelect}
        exact
        layout={MainLayout}
        path="/choose-primary"
      />
      <RouteWithLayout
        component={SecondarySelect}
        exact
        layout={MainLayout}
        path="/choose-secondary"
      />
      <RouteWithLayout
        component={NotFoundView}
        exact
        layout={MainLayout}
        path="/not-found"
      />
      <Redirect to="/not-found" />
    </Switch>
  );
};

export default Routes;