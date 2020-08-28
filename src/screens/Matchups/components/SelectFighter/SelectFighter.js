import React from "react";
import MenuItem from "@material-ui/core/MenuItem";
import FormControl from "@material-ui/core/FormControl";
import { MatchupsContext } from "../../Matchups";
import ListItemIcon from "@material-ui/core/ListItemIcon";
import ListItemText from "@material-ui/core/ListItemText";
import { StyledIconSelect } from "./style";

const SelectFighter = () => {
  const context = React.useContext(MatchupsContext);

  const handleSelect = (e) => {
    context.updateFighter(e.target.value);
  };
  return (
    <MatchupsContext.Consumer>
      {({ fighter, updateFighter, fighterSprites }) => (
        <FormControl>
          <StyledIconSelect value={fighter} onChange={updateFighter}>
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
        </FormControl>
      )}
    </MatchupsContext.Consumer>
  );
};

export default SelectFighter;
