import React from "react";

export const DashboardContext = React.createContext({
  fighter: {},
  updateFighter: () => {},
});

export class FighterProvider extends React.Component {
  updateFighter = (newFighter) => {
    this.setState({ fighter: newFighter });
  };

  state = {
    fighter: {},
    updateFighter: this.updateFighter,
  };

  render() {
    return (
      <DashboardContext.Provider value={this.state}>
        {this.props.children}
      </DashboardContext.Provider>
    );
  }
}
