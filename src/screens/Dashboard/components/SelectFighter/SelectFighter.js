import React from "react";
import { DashboardContext } from "../../Dashboard";
import MenuItem from "@material-ui/core/MenuItem";
import ListItemIcon from "@material-ui/core/ListItemIcon";
import ListItemText from "@material-ui/core/ListItemText";
import { StyledIconSelect } from "./style";

const SelectFighter = (props) => {
  const context = React.useContext(DashboardContext);

  const handleSelect = (e) => {
    context.updateSprite(e.target.value);
  };

  return (
    <StyledIconSelect value={context.fighter} onChange={(e) => handleSelect(e)}>
      {context.fighterSprites.map((s) => {
        return (
          <MenuItem value={s} key={s.id}>
            <ListItemIcon>
              <img
                style={{ maxWidth: "50px", maxHeight: "50px" }}
                src={s.url !== undefined ? s.url : ""}
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
