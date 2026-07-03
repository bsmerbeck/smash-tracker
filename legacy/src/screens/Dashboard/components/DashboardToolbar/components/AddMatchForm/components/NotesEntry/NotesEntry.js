import React from "react";
import TextField from "@material-ui/core/TextField";

const NotesEntry = (props) => {
  const { notes, updateNotes, error, updateError } = props;

  const localUpdate = (e) => {
    updateNotes(e.target.value.toString());
    updateError(e.target.value.toString().length > 100);
  };

  return (
    <div style={{ display: "flex", flex: 1, flexDirection: "column" }}>
      <h2 style={{ textAlign: "center" }}>Notes</h2>
      <TextField
        error={error}
        onChange={localUpdate}
        value={notes}
        variant="filled"
        helperText={error ? "Limit 100 character" : undefined}
        style={{ width: "90%", margin: "0 auto" }}
      />
    </div>
  );
};
export default NotesEntry;
