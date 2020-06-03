import React from "react";
import { Route } from "react-router-dom";
import PropTypes from "prop-types";

function RouteWithLayout({ layout, component, ...rest }) {
  return (
    <Route
      exact
      path={rest.path}
      {...rest}
      render={(props) =>
        React.createElement(
          layout,
          props,
          React.createElement(component, props)
        )
      }
    />
  );
}

RouteWithLayout.propTypes = {
  component: PropTypes.any.isRequired,
  layout: PropTypes.any.isRequired,
  path: PropTypes.string,
};

export default RouteWithLayout;
