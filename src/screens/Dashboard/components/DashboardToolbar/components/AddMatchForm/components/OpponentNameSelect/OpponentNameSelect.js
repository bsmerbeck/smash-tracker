import React from "react";
import TextField from "@material-ui/core/TextField";
import { StyledAutocomplete, StyledAutoTextField } from "../StageSelect/style";
import { createFilterOptions } from "@material-ui/lab/Autocomplete";

const filter = createFilterOptions();

const OpponentNameSelect = (props) => {
  const { opponents, opponent, updateOpponent, auth } = props;

  if (opponents === null || opponents === undefined) {
    return <div />;
  }

  const _opponents =
    opponents[auth.uid] !== null ? Object.keys(opponents[auth.uid]) : [];

  const localUpdate = (e, newValue) => {
    updateOpponent(newValue);
  };

  return (
    <div style={{ display: "flex", flex: 1, flexDirection: "column" }}>
      <h2 style={{ textAlign: "center" }}>Opponent</h2>
      <StyledAutocomplete
        id="opponent-list"
        options={_opponents}
        filterOptions={(options, params) => {
          const filtered = filter(options, params);

          // Suggest the creation of a new value
          if (params.inputValue !== "") {
            filtered.push(params.inputValue);
          }
          return filtered;
        }}
        selectOnFocus
        handleHomeEndKeys
        clearOnBlur
        getOptionSelected={(opt, value) => {
          if (value === undefined) {
            return true;
          }
          return value === opt;
        }}
        getOptionLabel={(option) => {
          // Value selected with enter, right from the input
          if (typeof option === "string") {
            return option;
          }
          // Add "xxx" option created dynamically
          if (option.inputValue) {
            return option.inputValue;
          }
        }}
        value={opponent}
        freeSolo
        onChange={localUpdate}
        renderInput={(params) => (
          <StyledAutoTextField
            {...params}
            label="Type to filter"
            variant="outlined"
          />
        )}
      />
    </div>
  );
};
export default OpponentNameSelect;
