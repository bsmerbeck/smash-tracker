import React from "react";
import TextField from "@material-ui/core/TextField";

const OpponentNameSelect = (props) => {
  return (
    <div style={{ display: "flex", flex: 1, flexDirection: "column" }}>
      <h2 style={{ textAlign: "center" }}>Opponent</h2>
      <TextField style={{ width: "90%", margin: "0 auto" }} />
    </div>
  );
};
export default OpponentNameSelect;
