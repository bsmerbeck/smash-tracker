import React from "react";
import { useSelector } from "react-redux";
import { isEmpty, isLoaded } from "react-redux-firebase";
import { SpriteList } from "../../../../components/Sprites/SpriteList";
import { Doughnut } from "react-chartjs-2";
import { jsgradient } from "../../../../components/RandomColor";

const FighterPieChart = (props) => {
  const matches = useSelector((state) => state.firebase.data.matches);
  const primaryFighters = useSelector(
    (state) => state.firebase.data.primaryFighters
  );
  const secondaryFighters = useSelector(
    (state) => state.firebase.data.secondaryFighters
  );

  if (
    !isLoaded(primaryFighters) ||
    !isLoaded(secondaryFighters) ||
    !isLoaded(matches)
  ) {
    return <div />;
  }

  let fighterIds = [...primaryFighters[props.auth.uid]];
  if (!isEmpty(secondaryFighters[props.auth.uid])) {
    fighterIds = [...fighterIds, ...secondaryFighters[props.auth.uid]];
  }

  const matchData = Object.keys(matches[props.auth.uid]).map((entry) => {
    return {
      ...matches[props.auth.uid][entry],
      key: entry,
    };
  });

  const chartData = fighterIds
    .map((fid) => {
      let the_matches = matchData.filter((md) => md.fighter_id === fid);
      let fighter = SpriteList.filter((sl) => sl.id === fid)[0];

      return {
        fighter: fighter,
        matchCount: the_matches.length,
        percentage: Math.round(
          Number.parseFloat(
            ((the_matches.length / matchData.length) * 100.0).toFixed(0)
          )
        ),
      };
    })
    .sort((a, b) => {
      return b.matchCount - a.matchCount;
    });

  const data = {
    labels: chartData.map((cd) => {
      return cd.fighter.name;
    }),
    datasets: [
      {
        data: chartData.map((cd) => {
          return cd.matchCount;
        }),
        backgroundColor: jsgradient.generateGradient(
          "#ff0000",
          "#070707",
          fighterIds.length
        ),
      },
    ],
  };

  const options = {
    cutoutPercentage: 70,
    rotation: 180,
    legend: {
      position: "bottom",
      labels: {
        fontSize: 16,
        fontColor: "#fff",
      },
    },
    tooltips: {
      titleFontSize: 16,
      titleFontColor: "#fff",
      bodyFontSize: 16,
      bodyFontColor: "#fff",
      footerFontSize: 16,
      callbacks: {
        label: (tooltipItem, data) => {
          let label = data.labels[tooltipItem.index];
          label += `: ${chartData[tooltipItem.index].percentage}%`;

          if (label) {
            label += ` (${
              data.datasets[tooltipItem.datasetIndex].data[tooltipItem.index]
            })`;
          }
          return label;
        },
      },
    },
  };

  return (
    <div>
      <Doughnut data={data} options={options} />
    </div>
  );
};

export default FighterPieChart;
