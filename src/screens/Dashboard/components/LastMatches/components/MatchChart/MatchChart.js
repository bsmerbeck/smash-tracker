import React, { useContext } from "react";
import { isLoaded } from "react-redux-firebase";
import { Line } from "react-chartjs-2";
import { useSelector } from "react-redux";
import { DashboardContext } from "../../../../Dashboard";
import { SpriteList } from "../../../../../../components/Sprites/SpriteList";

const MatchChart = () => {
  const context = useContext(DashboardContext);
  const matches = useSelector((state) => state.firebase.data.matches);

  if (!isLoaded(matches)) {
    return <div />;
  }

  const entries = Object.keys(matches[context.auth.uid]);
  const real_matches = entries.map((e) => matches[context.auth.uid][e]);

  const fighter_matches = real_matches.filter(
    (m) => m.fighter_id === context.fighter.id
  );

  let winRate = 0;
  let count = 0;
  let winCount = 0;
  const labels = [];
  let winRates = fighter_matches.map((m) => {
    count += 1;
    labels.push(count.toString());
    if (m.win) {
      winCount += 1;
    }
    winRate = (winCount / count) * 100.0;
    return winRate;
  });

  const tooltipCallback = () => {
    return {
      title: (tooltipItem) => {
        const date = new Date(fighter_matches[tooltipItem[0].index].time);
        let year = date.getFullYear();
        let month = (1 + date.getMonth()).toString().padStart(2, "0");
        let day = date.getDate().toString().padStart(2, "0");

        return month + "/" + day + "/" + year;
      },
      label: (tooltipItem) => {
        let label = ": ";

        label += `${Math.round(tooltipItem.yLabel * 100) / 100}%`;
        return label;
      },
      footer: (tooltipItem) => {
        const m_fighter = SpriteList.filter(
          (fs) => fs.id === fighter_matches[tooltipItem[0].index].opponent_id
        )[0];
        return `Opponent: ${m_fighter.name}`;
      },
    };
  };

  const data = {
    labels: labels,
    datasets: [
      {
        label: "Win Rate",
        fill: false,
        lineTension: 0.1,
        backgroundColor: "rgba(75,192,192,0.4)",
        borderColor: "rgba(75,192,192,1)",
        borderCapStyle: "butt",
        borderDash: [],
        borderDashOffset: 0.0,
        borderJoinStyle: "miter",
        pointBorderColor: "rgba(75,192,192,1)",
        pointBackgroundColor: "#fff",
        pointBorderWidth: 1,
        pointHoverRadius: 5,
        pointHoverBackgroundColor: "rgba(75,192,192,1)",
        pointHoverBorderColor: "rgba(220,220,220,1)",
        pointHoverBorderWidth: 2,
        pointRadius: 5,
        pointHitRadius: 10,
        data: winRates,
      },
    ],
    options: {
      scales: {
        xAxes: [
          {
            ticks: {
              fontColor: "white",
              fontSize: 16,
            },
            gridLines: {
              color: "#fff",
              borderDash: [1, 3],
            },
            display: true,
          },
        ],
        yAxes: [
          {
            position: "right",
            ticks: {
              fontColor: "white",
              fontSize: 16,
            },
            gridLines: {
              color: "#fff",
              display: false,
            },
          },
        ],
      },
      legends: {
        labels: {
          fontSize: 16,
          fontColor: "#fff",
        },
      },
      tooltips: {
        mode: "nearest",
        titleFontSize: 16,
        bodyFontSize: 16,
        intersect: true,
        bodyAlign: "left",
        callbacks: tooltipCallback(),
      },
    },
  };
  return (
    <Line data={data} options={data.options} legend={data.options.legends} />
  );
};

export default MatchChart;
