import React, { useState, useEffect } from "react";
import { useSelector } from "react-redux";
import {
  useFirebase,
  isLoaded,
  isEmpty,
  useFirebaseConnect,
} from "react-redux-firebase";
import SpriteButton from "../../components/SpriteButton";
import Button from "@material-ui/core/Button";
import Typography from "@material-ui/core/Typography";
import { StyledPrimaryCharacterDiv, StyledPrimarySpriteListDiv } from "./style";

function CharacterSelect() {
  useFirebaseConnect([{ path: "sprites" }]);

  const sprites = useSelector((state) => state.firebase.ordered.sprites);
  const auth = useSelector((state) => state.firebase.auth);

  const [spriteList, setSpriteList] = useState([]);
  const [input, setInput] = useState("");

  const handleSpriteClick = (e, sprite) => {
    setSpriteList([...spriteList, sprite]);
  };

  const handleSpriteRemoveClick = (e, sprite) => {
    const _spriteList = spriteList.filter((s) => s.key !== sprite.key);
    setSpriteList(_spriteList);
  };

  const handleInputChange = (e) => setInput(e.currentTarget.value);

  const [loading, setLoading] = useState(true);

  const saveButtonClick = () => {
    const _spriteIds = spriteList.map((s) => s.value.id);
  };

  const handleLoading = () => {
    setLoading(false);
  };

  return (
    <div>
      <Typography align="center" variant="h1">
        Choose Your Character
      </Typography>
      <div>
        <Typography
          style={{ fontSize: "1.5em" }}
          align="center"
          variant="body1"
        >
          Begin by selecting your primary characters. You can search using the
          input below. To remove a character, simply click/tap on it again. When
          you're finished, press Save.
        </Typography>
        <StyledPrimaryCharacterDiv>
          <div className="primary-sprite-list">
            {spriteList.map((sprite) => {
              return (
                <SpriteButton
                  style={{ width: "fit-content" }}
                  key={sprite.key}
                  sprite={sprite}
                  onClick={(e) => handleSpriteRemoveClick(e, sprite)}
                  handleLoading={handleLoading}
                />
              );
            })}
          </div>
          <div className="primary-sprite-input" style={{ display: "flex" }}>
            <input type="text" value={input} onChange={handleInputChange} />
            <Button
              variant="contained"
              color="primary"
              disabled={
                isLoaded(auth) && !isEmpty(auth) && spriteList.length <= 0
              }
            >
              Save
            </Button>
          </div>
        </StyledPrimaryCharacterDiv>
      </div>
      <StyledPrimarySpriteListDiv>
        {isLoaded(sprites) ? (
          sprites
            .filter(
              (d) =>
                input === "" ||
                d.value.name.toLowerCase().startsWith(input.toLowerCase())
            )
            .filter((d) => !spriteList.includes(d))
            .map((sprite) => {
              return (
                <SpriteButton
                  style={{ width: "fit-content" }}
                  key={sprite.key}
                  sprite={sprite}
                  onClick={(e) => handleSpriteClick(e, sprite)}
                />
              );
            })
        ) : (
          <p>Loading</p>
        )}
      </StyledPrimarySpriteListDiv>
    </div>
  );
}

export default CharacterSelect;
