import React, { useState } from "react";
import { useSelector } from "react-redux";
import { useHistory } from "react-router-dom";
import { useFirebase, isLoaded, isEmpty } from "react-redux-firebase";
import SpriteButton from "../../../components/SpriteButton";
import Button from "@material-ui/core/Button";
import Typography from "@material-ui/core/Typography";
import {
  StyledPrimaryCharacterDiv,
  StyledPrimarySpriteListDiv,
} from "../style";
import { SpriteList } from "../../../components/Sprites/SpriteList";

function SecondarySelect() {
  const firebase = useFirebase();
  const history = useHistory();

  const secondaryFighters = useSelector(
    (state) => state.firebase.data.secondaryFighters
  );

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

  const [loading, setLoading] = useState(false);

  if (!isLoaded(secondaryFighters)) {
    return <div />;
  }
  if (
    !loading &&
    isLoaded(secondaryFighters) &&
    !isEmpty(secondaryFighters[auth.uid])
  ) {
    const _sprites = secondaryFighters[auth.uid].map(
      (p) => SpriteList.filter((s) => s.id === p)[0]
    );
    setSpriteList(_sprites);
    setLoading(true);
  }

  const saveButtonClick = () => {
    const _spriteIds = spriteList.map((s) => s.id);
    firebase.database().ref(`/secondaryFighters/${auth.uid}`).set(_spriteIds);
    setSpriteList([]);
    setInput("");
    history.push("/dashboard");
  };

  return (
    <div>
      <Typography align="center" variant="h2">
        Choose Your Secondaries
      </Typography>
      <div>
        <Typography
          style={{ fontSize: "1.5em", margin: "10px" }}
          align="center"
          variant="body1"
        >
          Begin by selecting your{" "}
          <span style={{ textDecoration: "underline" }}>secondary</span>{" "}
          fighters. You can search using the input below. To remove a character,
          simply click/tap on it again. When you're finished, press Save to
          begin using Smash Tracker!
        </Typography>
        <StyledPrimaryCharacterDiv>
          <StyledPrimarySpriteListDiv>
            {spriteList.map((sprite) => {
              return (
                <SpriteButton
                  value={sprite.id}
                  style={{ width: "fit-content" }}
                  key={sprite.id}
                  sprite={sprite}
                  onClick={(e) => handleSpriteRemoveClick(e, sprite)}
                />
              );
            })}
          </StyledPrimarySpriteListDiv>
          <div className="primary-sprite-input" style={{ display: "flex" }}>
            <input type="text" value={input} onChange={handleInputChange} />
            <Button
              style={{ width: "fit-content" }}
              variant="contained"
              color="primary"
              disabled={isLoaded(auth) && isEmpty(auth)}
              onClick={saveButtonClick}
            >
              Save and go to Dashboard
            </Button>
            <Button
              style={{ width: "fit-content" }}
              variant="contained"
              color="primary"
              disabled={isLoaded(auth) && isEmpty(auth)}
              onClick={() => history.push("/choose-primary")}
            >
              Return to Primary Fighters
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
                  value={sprite.id}
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

export default SecondarySelect;
