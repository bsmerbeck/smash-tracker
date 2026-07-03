import React from "react";
import InputLabel from "@material-ui/core/InputLabel";
import MenuItem from "@material-ui/core/MenuItem";
import FormControl from "@material-ui/core/FormControl";
import Select from "@material-ui/core/Select";
import { DashboardContext } from "../../../../Dashboard";
import ListItemIcon from "@material-ui/core/ListItemIcon";
import ListItemText from "@material-ui/core/ListItemText";

const SelectFighter = () => {
  return (
    <DashboardContext.Consumer>
      {({ fighter, setFighter }) => (
        <FormControl>
          <InputLabel>Fighter</InputLabel>
          <Select value={fighter} onChange={setFighter}>
            {fighterSprites.map((s) => {
              return (
                <MenuItem value={s} key={s.id}>
                  <ListItemIcon>
                    <img style={{ maxWidth: "50px" }} src={s.url} alt="" />
                  </ListItemIcon>
                  <ListItemText>{s.name}</ListItemText>
                </MenuItem>
              );
            })}
          </Select>
        </FormControl>
      )}
    </DashboardContext.Consumer>
  );
};

export default SelectFighter;
