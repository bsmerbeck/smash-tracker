import React from "react";
import { FighterAnalysisContext } from "../../FighterAnalysis";
import Card from "@material-ui/core/Card";
import CardHeader from "@material-ui/core/CardHeader";
import CardContent from "@material-ui/core/CardContent";
import { StageList } from "../../../../components/Stages/StageList";
import { StyledBestWorstStageCardContent } from "./style";
import Select from "@material-ui/core/Select";
import MenuItem from "@material-ui/core/MenuItem";

const BestWorstMap = () => {
  const context = React.useContext(FighterAnalysisContext);
  const [threshold, setThreshold] = React.useState(3);
  const { matches, fighter } = context;

  const entries = Object.keys(matches[context.auth.uid]);
  const real_matches = entries.map((e) => matches[context.auth.uid][e]);
  const fighter_matches = real_matches.filter(
    (m) => m.fighter_id === fighter.id
  );

  const best = bestMap(fighter_matches, fighter.id, threshold);
  const worst = worstMap(fighter_matches, fighter.id, threshold);

  console.log("hi");

  const handleThresholdChange = (event) => {
    setThreshold(event.target.value);
  };

  return (
    <Card style={{ flex: 1, margin: "5px" }}>
      <CardHeader title="Best/Worst Stage" />
      <StyledBestWorstStageCardContent>
        <div
          style={{
            display: "flex",
            justifyContent: "flex-end",
            alignItems: "bottom",
          }}
        >
          <div style={{ flex: 1 }} />
          <div style={{ display: "flex", alignItems: "center" }}>
            <Select value={threshold} onChange={handleThresholdChange}>
              <MenuItem value={3}>3</MenuItem>
              <MenuItem value={5}>5</MenuItem>
              <MenuItem value={10}>10</MenuItem>
              <MenuItem value={20}>20</MenuItem>
            </Select>
          </div>
        </div>

        <div
          style={{
            display: "flex",
            justifyContent: "space-evenly",
            alignItems: "center",
          }}
        >
          <div
            style={{
              flex: 1,
              display: "flex",
              flexDirection: "column",
              textAlign: "center",
            }}
          >
            <h2>{best.name}</h2>
            <p>{best.ratio ? `${best.ratio}%` : "not enough matches"}</p>
          </div>
          <div
            style={{
              flex: 1,
              display: "flex",
              flexDirection: "column",
              textAlign: "center",
            }}
          >
            <h2>{worst.name}</h2>
            <p>{worst.ratio ? `${worst.ratio}%` : "not enough matches"}</p>
          </div>
        </div>
      </StyledBestWorstStageCardContent>
    </Card>
  );
};

export default BestWorstMap;

function bestMap(arr, fighter, threshold) {
  const stageRatios = StageList.map((s) => {
    const stageMatches = arr.filter(
      (match) => match.map && match.map.id === s.id
    );
    const stageWins = stageMatches.filter(
      (m) => m.fighter_id === fighter && m.win
    );

    const stageRatio =
      stageWins.length && stageWins.length >= threshold
        ? ((stageWins.length / stageMatches.length) * 100).toFixed(0)
        : 0;
    return {
      id: s.id,
      name: s.name,
      ratio: stageRatio,
    };
  });
  const bestMap = stageRatios.sort((a, b) => b.ratio - a.ratio);
  const returnMap = bestMap[0].ratio === 0 ? { id: -1, name: "" } : bestMap[0];
  return returnMap;
}

function worstMap(arr, fighter, threshold) {
  const stageRatios = StageList.map((s) => {
    const stageMatches = arr.filter(
      (match) => match.map && match.map.id === s.id
    );
    const stageLosses = stageMatches.filter(
      (m) => m.fighter_id === fighter && !m.win
    );

    const stageRatio =
      stageLosses.length && stageLosses.length >= threshold
        ? ((stageLosses.length / stageMatches.length) * 100).toFixed(0)
        : 0;
    return {
      id: s.id,
      name: s.name,
      ratio: stageRatio,
    };
  });
  const bestMap = stageRatios.sort((a, b) => b.ratio - a.ratio);
  const returnMap = bestMap[0].ratio === 0 ? { id: -1, name: "" } : bestMap[0];
  return returnMap;
}
