import React from "react";
import Card from "@material-ui/core/Card";
import CardHeader from "@material-ui/core/CardHeader";
import CardContent from "@material-ui/core/CardContent";
import { FighterAnalysisContext } from "../../FighterAnalysis";

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

  const win_streak = winStreak(real_matches);
  const lose_streak = loseStreak(real_matches);
  const { streak, lastValue } = lastStreak(real_matches);

  const currentColor = lastValue ? "limegreen" : "red";

  return (
    <Card>
      <CardHeader title="Streaks" />
      <CardContent>
        <div style={{ display: "flex" }}>
          <div style={{ flex: 1, textAlign: "center" }}>
            <p>Current</p>
            <h2 style={{ color: currentColor }}>{streak}</h2>
            <p>{lastValue ? "Wins" : "Losses"}</p>
          </div>
          <div style={{ flex: 1, textAlign: "center" }}>
            <p>Best</p>
            <h2 style={{ color: "limegreen" }}>{win_streak}</h2>
            <p>Wins</p>
          </div>
          <div style={{ flex: 1, textAlign: "center" }}>
            <p>Worst</p>
            <h2 style={{ color: "red" }}>{lose_streak}</h2>
            <p>Losses</p>
          </div>
        </div>
      </CardContent>
    </Card>
  );
};

export default StreakCard;
