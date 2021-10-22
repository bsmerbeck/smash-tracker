import React from "react";
//import Card from "@material-ui/core/Card";
import CardHeader from "@material-ui/core/CardHeader";
import CardContent from "@material-ui/core/CardContent";
import { FighterAnalysisContext } from "../../FighterAnalysis";

import { StyledStreakCardContentDiv, StyledStreakCard } from "./style";

function winStreak(arr) {
  let i,
    temp,
    streak,
    length = arr.length,
    highestStreak = 0;

  for (i = 0; i < length; i++) {
    // check the value of the current entry against the last
    if (temp === arr[i].win && temp === true) {
      // it's a match
      streak++;
    } else {
      // it's not a match, start streak from 1
      streak = 1;
    }

    // set current letter for next time
    temp = arr[i].win;

    // set the master streak var
    if (streak > highestStreak) {
      highestStreak = streak;
    }
  }

  return highestStreak;
}

function loseStreak(arr) {
  let i,
    temp,
    streak,
    length = arr.length,
    highestStreak = 0;

  for (i = 0; i < length; i++) {
    // check the value of the current entry against the last
    if (temp === arr[i].win && temp === false) {
      // it's a match
      streak++;
    } else {
      // it's not a match, start streak from 1
      streak = 1;
    }

    // set current letter for next time
    temp = arr[i].win;

    // set the master streak var
    if (streak > highestStreak) {
      highestStreak = streak;
    }
  }

  return highestStreak;
}

function lastStreak(arr) {
  if (arr.length === 0) {
    return { streak: 0, lastValue: false };
  }
  const reverse = arr.reverse();
  const lastValue = reverse[0].win;
  let streak = 1;

  for (let i = 1; i < reverse.length; i++) {
    if (reverse[i].win !== lastValue) {
      break;
    } else {
      streak++;
    }
  }
  return { streak, lastValue };
}

const StreakCard = () => {
  const context = React.useContext(FighterAnalysisContext);

  const { matches, fighter } = context;

  const entries = Object.keys(matches[context.auth.uid]);
  const real_matches = entries.map((e) => matches[context.auth.uid][e]);

  const real_fighter_matches = real_matches.filter(
    (m) => m.fighter_id === fighter.id
  );

  const win_streak = winStreak(real_fighter_matches);
  const lose_streak = loseStreak(real_fighter_matches);
  const { streak, lastValue } = lastStreak(real_fighter_matches);

  return (
    <StyledStreakCard style={{ flex: 1, margin: "5px" }}>
      <CardHeader style={{ paddingBottom: 0 }} title="Streaks" />
      <CardContent style={{ paddingBottom: 0, paddingTop: 0 }}>
        <StyledStreakCardContentDiv lastValue={lastValue}>
          <div>
            <p>Current</p>
            <h2 className="currentStreak">{streak}</h2>
            <p>{lastValue ? "Wins" : "Losses"}</p>
          </div>
          <div>
            <p>Best</p>
            <h2 className="winCount">{win_streak}</h2>
            <p>Wins</p>
          </div>
          <div>
            <p>Worst</p>
            <h2 className="lossCount">{lose_streak}</h2>
            <p>Losses</p>
          </div>
        </StyledStreakCardContentDiv>
      </CardContent>
    </StyledStreakCard>
  );
};

export default StreakCard;
