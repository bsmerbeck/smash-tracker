import React from "react";
import RadioGroup from "@material-ui/core/RadioGroup";
import FormControlLabel from "@material-ui/core/FormControlLabel";
import Radio from "@material-ui/core/Radio";

const MatchTypeSelect = (props) => {
  const { selectedType, updateSelectedType } = props;
  function localUpdate(e, newValue) {
    updateSelectedType(e, newValue);
  }

  return (
    <div>
      <h2 style={{ textAlign: "center" }}>Match Type</h2>
      <RadioGroup
        style={{ margin: "20px", justifyContent: "space-around" }}
        row
        aria-label="position"
        name="position"
        defaultValue="end"
      >
        <FormControlLabel
          value="none"
          checked={selectedType === "none"}
          onChange={localUpdate}
          control={<Radio color="primary" />}
          label="none"
          labelPlacement="end"
        />
        <FormControlLabel
          value="quickplay"
          checked={selectedType === "quickplay"}
          onChange={localUpdate}
          control={<Radio color="primary" />}
          label="QuickPlay"
          labelPlacement="end"
        />
        <FormControlLabel
          value="online-friendly"
          checked={selectedType === "online-friendly"}
          onChange={localUpdate}
          control={<Radio color="primary" />}
          label="Online Friendly"
          labelPlacement="end"
        />
        <FormControlLabel
          checked={selectedType === "online-tourney"}
          onChange={localUpdate}
          value="online-tourney"
          control={<Radio color="primary" />}
          label="Online Tourney"
          labelPlacement="end"
        />
        <FormControlLabel
          checked={selectedType === "offline-friendly"}
          onChange={localUpdate}
          value="offline-friendly"
          control={<Radio color="primary" />}
          label="Offline Friendly"
          labelPlacement="end"
        />
        <FormControlLabel
          checked={selectedType === "offline-tourney"}
          onChange={localUpdate}
          value="offline-tourney"
          control={<Radio color="primary" />}
          label="Offline Tourney"
          labelPlacement="end"
        />
      </RadioGroup>
    </div>
  );
};

export default MatchTypeSelect;
