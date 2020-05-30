import React, { useState, useEffect } from "react";
import { useHistory } from "react-router-dom";
import { useSelector } from "react-redux";
import { useFirebase, isLoaded, isEmpty } from "react-redux-firebase";
import SpriteButton from "../../../components/SpriteButton";
import Button from "@material-ui/core/Button";
import Typography from "@material-ui/core/Typography";
import {
  StyledPrimaryCharacterDiv,
  StyledPrimarySpriteListDiv,
} from "../style";
import { SpriteList } from "../../../components/Sprites/SpriteList";

function PrimarySelect() {
  const firebase = useFirebase();
  const history = useHistory();

  const sprites = SpriteList;
  const auth = useSelector((state) => state.firebase.auth);

  const [spriteList, setSpriteList] = useState([]);
  const [input, setInput] = useState("");

  const handleSpriteClick = (e, sprite) => {
    setSpriteList([...spriteList, sprite]);
  };

  const handleSpriteRemoveClick = (e, sprite) => {
    const _spriteList = spriteList.filter((s) => s.id !== sprite.id);
    setSpriteList(_spriteList);
  };

  const handleInputChange = (e) => setInput(e.currentTarget.value);

  const [loading, setLoading] = useState(true);

  const saveButtonClick = () => {
    const _spriteIds = spriteList.map((s) => s.id);
    firebase.database().ref(`/primaryFighters/${auth.uid}`).set(_spriteIds);
    setSpriteList([]);
    setInput("");
    history.push("/choose-secondary");
  };

  const handleLoading = () => {
    setLoading(false);
  };

  return (
    <div>
      <Typography align="center" variant="h2">
        Choose Your Primaries
      </Typography>
      <div>
        <Typography
          style={{ fontSize: "1.5em", margin: "10px" }}
          align="center"
          variant="body1"
        >
          Begin by selecting your{" "}
          <span style={{ textDecoration: "underline" }}>primary</span> fighters.
          You can search using the input below. To remove a character, simply
          click/tap on it again. When you're finished, press Save.
        </Typography>
        <StyledPrimaryCharacterDiv>
          <div className="primary-sprite-list">
            {spriteList.map((sprite) => {
              return (
                <SpriteButton
                  style={{ width: "fit-content" }}
                  key={sprite.id}
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
              onClick={saveButtonClick}
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
                d.name.toLowerCase().startsWith(input.toLowerCase())
            )
            .filter((d) => !spriteList.includes(d))
            .map((sprite) => {
              return (
                <SpriteButton
                  style={{ width: "fit-content" }}
                  key={sprite.id}
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

export default PrimarySelect;
