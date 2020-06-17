import React, { useContext, useState } from "react";
import Card from "@material-ui/core/Card";
import CardContent from "@material-ui/core/CardContent";
import Select from "@material-ui/core/Select";
import MenuItem from "@material-ui/core/MenuItem";
import { DashboardContext } from "../../Dashboard";
import { useSelector } from "react-redux";
import { isLoaded } from "react-redux-firebase";
import { SpriteList } from "../../../../components/Sprites/SpriteList";

const PreviousMatches = ({ className }) => {
  const { auth } = useContext(DashboardContext);
  const matches = useSelector((state) => state.firebase.data.matches);
  const [limit, setLimit] = useState(5);

  const handleLimitClick = (e) => {
    setLimit(e.target.value);
  };

  if (!isLoaded(matches)) {
    return (
      <Card className={className}>
        <CardContent>Loading...</CardContent>
      </Card>
    );
  }

  if (!matches[auth.uid] || matches[auth.uid].length === 0) {
    return (
      <Card className={className}>
        <CardContent
          style={{ display: "flex", alignItems: "center", height: "100%" }}
        >
          <h2>No matches recorded</h2>
        </CardContent>
      </Card>
    );
  }

  const entries = Object.keys(matches[auth.uid]);
  const real_matches = entries
    .map((e) => matches[auth.uid][e])
    .slice(-1 * limit)
    .reverse();

  const matchData = real_matches.map((r) => {
    return {
      ...r,
      fighter: SpriteList.filter((s) => s.id === r.fighter_id)[0],
      opponent: SpriteList.filter((s) => s.id === r.opponent_id)[0],
    };
  });

  return (
    <Card className={className}>
      <CardContent>
        <div style={{ display: "flex", justifyContent: "space-between" }}>
          <h2>Previous Matches</h2>
          <div style={{ display: "flex", alignItems: "center" }}>
            <h3 style={{ margin: "5px" }}>Limit</h3>
            <Select value={limit} onChange={handleLimitClick}>
              <MenuItem value={5}>5</MenuItem>
              <MenuItem value={10}>10</MenuItem>
              <MenuItem value={20}>20</MenuItem>
              <MenuItem value={30}>30</MenuItem>
            </Select>
          </div>
        </div>
        <div>
          {matchData.map((l) => {
            return (
              <div
                key={l.time}
                style={{ display: "flex", justifyContent: "space-between" }}
              >
                <div style={{ display: "flex" }}>
                  <div style={{ display: "flex", minWidth: "130px" }}>
                    <img
                      style={{ maxHeight: "5vh" }}
                      src={l.fighter.url}
                      alt=""
                    />
                    <p>{l.fighter.name}</p>
                  </div>
                  <div style={{ display: "flex", minWidth: "130px" }}>
                    <img
                      style={{ maxHeight: "5vh" }}
                      src={l.opponent.url}
                      alt=""
                    />
                    <p>{l.opponent.name}</p>
                  </div>
                </div>
                <h3>{l.win ? "Win" : "Loss"}</h3>
              </div>
            );
          })}
        </div>
      </CardContent>
    </Card>
  );
};

export default PreviousMatches;
