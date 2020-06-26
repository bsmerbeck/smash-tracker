import React from "react";
import StageList from "../../../../../../../../components/Stages/StageList";
import Autocomplete from "@material-ui/lab/Autocomplete";
import TextField from "@material-ui/core/TextField";
import {
  StyledStageButton,
  StageButtonDiv,
  StyledAutocomplete,
  StyledAutoTextField,
} from "./style";

const StageCard = (props) => {
  const { stage, updateStage, selectedStage } = props;

  return (
    <StyledStageButton
      selected={stage.id === selectedStage}
      value={false ? { id: 0, name: "no selection" } : stage}
      onClick={(e) => updateStage(e, stage)}
    >
      <img src={stage.url} alt="" />
      <p>{stage.name}</p>
    </StyledStageButton>
  );
};

const StageSelect = (props) => {
  const { stage, updateStage } = props;

  const stageImages = StageList.filter((s) => s.url.length > 0).sort(
    (a, b) => a.id - b.id
  );

  const alphaStageList = StageList.sort((a, b) => {
    const textA = a.name.toUpperCase();
    const textB = b.name.toUpperCase();
    return textA < textB ? -1 : textA > textB ? 1 : 0;
  });

  const autocompleteOptions = [
    { id: 0, name: "no selection" },
    ...alphaStageList,
  ];

  function localUpdate(e, newValue) {
    if (newValue !== null) {
      updateStage(e, newValue);
    } else {
      updateStage(e, {
        id: 0,
        name: "no selection",
      });
    }
  }

  return (
    <div>
      <h2 style={{ textAlign: "left" }}>Map</h2>
      <StyledAutocomplete
        id="full-stage-list"
        options={autocompleteOptions}
        getOptionSelected={(opt, value) => {
          if (value === undefined) {
            return true;
          }
          return value.id === opt.id;
        }}
        getOptionLabel={(option) => option.name}
        value={stage}
        onChange={localUpdate}
        renderInput={(params) => (
          <StyledAutoTextField
            {...params}
            label="Type to filter"
            variant="outlined"
          />
        )}
      />
      <StageButtonDiv>
        {stageImages.map((s) => (
          <StageCard
            key={s.id}
            stage={s}
            updateStage={updateStage}
            selectedStage={stage.id}
          />
        ))}
      </StageButtonDiv>
    </div>
  );
};

export default StageSelect;
