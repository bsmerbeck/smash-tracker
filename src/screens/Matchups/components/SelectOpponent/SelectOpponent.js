import React, { useContext } from "react";
import MenuItem from "@material-ui/core/MenuItem";
import FormControl from "@material-ui/core/FormControl";
import { MatchupsContext } from "../../Matchups";
import ListItemIcon from "@material-ui/core/ListItemIcon";
import ListItemText from "@material-ui/core/ListItemText";
import { StyledIconSelect } from "./style";
import { SpriteList } from "../../../../components/Sprites/SpriteList";

const SelectOpponent = () => {
  const context = useContext(MatchupsContext);

  const handleSelect = (e) => {
    context.updateOpponent(e.target.value);
  };
  return (
    <MatchupsContext.Consumer>
      {({ opponent }) => (
        <FormControl>
          <StyledIconSelect value={opponent} onChange={handleSelect}>
            {SpriteList.map((s) => {
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
        </FormControl>
      )}
    </MatchupsContext.Consumer>
  );
};

export default SelectOpponent;
