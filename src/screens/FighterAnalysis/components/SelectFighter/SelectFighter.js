import React from "react";
import { FighterAnalysisContext } from "../../FighterAnalysis";
import MenuItem from "@material-ui/core/MenuItem";
import ListItemIcon from "@material-ui/core/ListItemIcon";
import ListItemText from "@material-ui/core/ListItemText";
import { StyledIconSelect } from "./style";

const SelectFighter = () => {
  const context = React.useContext(FighterAnalysisContext);

  const { fighter, fighterSprites, updateSprite } = context;

  const handleSelect = (e) => {
    updateSprite(e.target.value);
  };

  return (
    <StyledIconSelect value={fighter} onChange={(e) => handleSelect(e)}>
      {fighterSprites.map((s) => {
        return (
          <MenuItem value={s} key={s.id}>
            <ListItemIcon>
              <img
                style={{ maxWidth: "50px", maxHeight: "50px" }}
                src={s.url}
                alt=""
              />
            </ListItemIcon>
            <ListItemText>{s.name}</ListItemText>
          </MenuItem>
        );
      })}
    </StyledIconSelect>
  );
};

export default SelectFighter;
