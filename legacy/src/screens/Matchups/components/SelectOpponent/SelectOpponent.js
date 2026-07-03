import React, { useContext } from "react";
import MenuItem from "@material-ui/core/MenuItem";
import FormControl from "@material-ui/core/FormControl";
import { MatchupsContext } from "../../Matchups";
import ListItemIcon from "@material-ui/core/ListItemIcon";
import ListItemText from "@material-ui/core/ListItemText";
import { StyledIconSelect } from "./style";
import { SpriteList } from "../../../../components/Sprites/SpriteList";

const operation = (list1, list2, isUnion = false) =>
  list1.filter(
    ((set) => (a) => isUnion === set.has(a.id))(new Set(list2.map((b) => b.id)))
  );

const inBoth = (list1, list2) => operation(list1, list2, true);

const SelectOpponent = () => {
  const { matches, auth, updateOpponent } = useContext(MatchupsContext);

  const entries = Object.keys(matches[auth.uid]);
  const real_matches = entries.map((e) => matches[auth.uid][e]);

  const opponents = real_matches.map((o) => {
    return {
      id: o.opponent_id,
    };
  });

  const spriteBoth = inBoth(SpriteList, opponents);

  const handleSelect = (e) => {
    updateOpponent(e.target.value);
  };
  return (
    <MatchupsContext.Consumer>
      {({ opponent }) => (
        <FormControl>
          <StyledIconSelect value={opponent} onChange={handleSelect}>
            {spriteBoth.map((s) => {
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
