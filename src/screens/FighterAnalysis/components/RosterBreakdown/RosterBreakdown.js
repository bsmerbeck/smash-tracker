import React from "react";
import { StageList } from "../../../../components/Stages/StageList";
import { SpriteList } from "../../../../components/Sprites/SpriteList";
import { FighterAnalysisContext } from "../../FighterAnalysis";
import {
  useTable,
  usePagination,
  useSortBy,
  useFilters,
  useGlobalFilter,
} from "react-table";
import MaUTable from "@material-ui/core/Table";
import TableContainer from "@material-ui/core/TableContainer";
import TableBody from "@material-ui/core/TableBody";
import TableCell from "@material-ui/core/TableCell";
import TableHead from "@material-ui/core/TableHead";
import TableRow from "@material-ui/core/TableRow";
import Button from "@material-ui/core/Button";
import Typography from "@material-ui/core/Typography";
import Select from "@material-ui/core/Select";
import { TableStyleDiv } from "./style";

const headers = [
  {
    Header: "Fighter",
    accessor: "id",
    Cell: ({ cell }) => (
      <div style={{ display: "flex", alignItems: "center" }}>
        <img
          style={{ maxWidth: "4vw", maxHeight: "4vh" }}
          src={cell.row.original.url}
          alt=""
        />
        <p style={{ flex: 1 }}>{cell.row.original.name}</p>
      </div>
    ),
  },
  {
    Header: "Win Rate",
    accessor: "win_rate",
  },
  {
    Header: "Matches",
    Filter: NumberRangeColumnFilter,
    filter: "between",
    accessor: "matches_count",
  },
  {
    Header: "Wins",
    accessor: "wins_count",
  },
  {
    Header: "Losses",
    accessor: "losses_count",
  },
  {
    Header: "Best Stage",
    accessor: "best_stage",
  },
  {
    Header: "Worst Stage",
    accessor: "worst_stage",
  },
];

const RosterBreakdown = () => {
  const context = React.useContext(FighterAnalysisContext);

  const { matches, fighter } = context;

  const entries = Object.keys(matches[context.auth.uid]);
  const real_matches = entries.map((e) => matches[context.auth.uid][e]);
  const fighter_matches = real_matches.filter(
    (m) => m.fighter_id === fighter.id
  );

  let tableData = SpriteList.map((s) => {
    const opponent_matches = fighter_matches.filter(
      (m) => m.opponent_id === s.id
    );
    const wins_count = opponent_matches.filter((m) => m.win);
    const losses_count = opponent_matches.filter(
      (m) => m.opponent_id === s.id && !m.win
    );
    const matches_count = wins_count.length + losses_count.length;
    const win_rate =
      wins_count && matches_count > 0
        ? Number.parseInt(
            ((wins_count.length / matches_count) * 100).toFixed(0)
          )
        : 0;

    const best_stage = bestMap(opponent_matches);
    const worst_stage = worstMap(opponent_matches);
    // const best_string = best_stage.ratio ? `${best_stage.name} (${best_stage.ratio} %)` : `${best_stage.name}`;
    // const worst_string = worst_stage.ratio ? `${worst_stage.name} (${worst_stage.ratio} %)` : `${worst_stage.name}`;
    return {
      id: s.id,
      name: s.name,
      url: s.url,
      matches_count: matches_count,
      win_rate: win_rate,
      wins_count: wins_count.length,
      losses_count: losses_count.length,
      best_stage: best_stage.name,
      worst_stage: worst_stage.name,
    };
  });

  return (
    <TableStyleDiv style={{ flex: 1 }}>
      <TableContainer style={{ maxHeight: "800px" }}>
        <Table columns={headers} data={tableData} />
      </TableContainer>
    </TableStyleDiv>
  );
};

export default RosterBreakdown;

// Define a default UI for filtering
function DefaultColumnFilter({
  column: { filterValue, preFilteredRows, setFilter },
}) {
  const count = preFilteredRows.length;

  return <div />;
}

function NumberRangeColumnFilter({
  column: { filterValue = [], preFilteredRows, setFilter, id },
}) {
  const [min, max] = React.useMemo(() => {
    let min = preFilteredRows.length ? preFilteredRows[0].values[id] : 0;
    let max = preFilteredRows.length ? preFilteredRows[0].values[id] : 0;
    preFilteredRows.forEach((row) => {
      min = Math.min(row.values[id], min);
      max = Math.max(row.values[id], max);
    });
    return [min, max];
  }, [id, preFilteredRows]);

  return (
    <div
      style={{
        margin: "0 auto",
        display: "flex",
        justifyContent: "center",
      }}
    >
      <input
        value={filterValue[0] || ""}
        type="number"
        onChange={(e) => {
          const val = e.target.value;
          setFilter((old = []) => [
            val ? parseInt(val, 10) : undefined,
            old[1],
          ]);
        }}
        placeholder={`Min (${min})`}
        style={{
          width: "70px",
          marginRight: "0.5rem",
        }}
      />
      to
      <input
        value={filterValue[1] || ""}
        type="number"
        onChange={(e) => {
          const val = e.target.value;
          setFilter((old = []) => [
            old[0],
            val ? parseInt(val, 10) : undefined,
          ]);
        }}
        placeholder={`Max (${max})`}
        style={{
          width: "70px",
          marginLeft: "0.5rem",
        }}
      />
    </div>
  );
}

function Table({ columns, data }) {
  const defaultColumn = React.useMemo(
    () => ({
      // Let's set up our default Filter UI
      Filter: DefaultColumnFilter,
    }),
    []
  );

  const filterTypes = React.useMemo(
    () => ({
      // Add a new fuzzyTextFilterFn filter type.
      // Or, override the default text filter to use
      // "startWith"
      text: (rows, id, filterValue) => {
        return rows.filter((row) => {
          const rowValue = row.values[id];
          return rowValue !== undefined
            ? String(rowValue)
                .toLowerCase()
                .startsWith(String(filterValue).toLowerCase())
            : true;
        });
      },
    }),
    []
  );

  // Use the state and functions returned from useTable to build your UI
  const {
    getTableProps,
    getTableBodyProps,
    headerGroups,
    prepareRow,
    page, // Instead of using 'rows', we'll use page,
    // which has only the rows for the active page

    // The rest of these things are super handy, too ;)
    canPreviousPage,
    canNextPage,
    pageOptions,
    pageCount,
    gotoPage,
    nextPage,
    previousPage,
    setPageSize,
    state: { pageIndex, pageSize },
  } = useTable(
    {
      columns,
      data,
      initialState: {
        pageIndex: 0,
        sortBy: [
          {
            id: "id",
            desc: false,
          },
        ],
      },
      defaultColumn,
      filterTypes,
    },

    useFilters,
    useSortBy,
    usePagination
  );

  // Render the UI for your table
  return (
    <>
      <MaUTable {...getTableProps()}>
        <TableHead>
          {headerGroups.map((headerGroup) => (
            <TableRow {...headerGroup.getHeaderGroupProps()}>
              {headerGroup.headers.map((column) => (
                <TableCell>
                  <div
                    {...column.getHeaderProps(column.getSortByToggleProps())}
                  >
                    {column.render("Header")}
                    {column.isSorted
                      ? column.isSortedDesc
                        ? " 🔽"
                        : " 🔼"
                      : ""}
                  </div>
                  <div>{column.canFilter ? column.render("Filter") : null}</div>
                </TableCell>
              ))}
            </TableRow>
          ))}
        </TableHead>
        <TableBody {...getTableBodyProps()}>
          {page.map((row, i) => {
            prepareRow(row);
            return (
              <TableRow {...row.getRowProps()}>
                {row.cells.map((cell) => {
                  return (
                    <TableCell {...cell.getCellProps()}>
                      <div>{cell.render("Cell")}</div>
                    </TableCell>
                  );
                })}
              </TableRow>
            );
          })}
        </TableBody>
      </MaUTable>
      {/*
        Pagination can be built however you'd like.
        This is just a very basic UI implementation:
      */}
      <div className="pagination">
        <div>
          <Button
            variant="outlined"
            onClick={() => gotoPage(0)}
            disabled={!canPreviousPage}
          >
            {"<<"}
          </Button>{" "}
          <Button
            variant="outlined"
            onClick={() => previousPage()}
            disabled={!canPreviousPage}
          >
            {"<"}
          </Button>{" "}
          <Button
            variant="outlined"
            onClick={() => nextPage()}
            disabled={!canNextPage}
          >
            {">"}
          </Button>{" "}
          <Button
            variant="outlined"
            onClick={() => gotoPage(pageCount - 1)}
            disabled={!canNextPage}
          >
            {">>"}
          </Button>{" "}
        </div>
        <div>
          <Typography variant="subtitle1">
            Page {pageIndex + 1} of {pageOptions.length}
          </Typography>
        </div>
        <div>
          <Select
            value={pageSize}
            onChange={(e) => {
              setPageSize(Number(e.target.value));
            }}
          >
            {[8, 10, 20, 40, 100].map((pageSize) => (
              <option key={pageSize} value={pageSize}>
                Show {pageSize}
              </option>
            ))}
          </Select>
        </div>
      </div>
    </>
  );
}

function bestMap(arr) {
  const stageRatios = StageList.map((s) => {
    const stageMatches = arr.filter((match) => {
      if (match.map) {
        return match.map.id === s.id;
      }
    });
    const stageWins = stageMatches.filter((m) => m.win);

    const stageRatio =
      stageWins.length && stageMatches.length > 3
        ? parseInt(((stageWins.length / stageMatches.length) * 100).toFixed(0))
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

function worstMap(arr) {
  const stageRatios = StageList.map((s) => {
    const stageMatches = arr.filter((match) => {
      if (match.map) {
        return match.map.id === s.id;
      }
    });
    const stageLosses = stageMatches.filter((m) => m.win === false);

    const stageRatio =
      stageLosses.length && stageLosses.length > 3
        ? parseInt(
            ((stageLosses.length / stageMatches.length) * 100).toFixed(0)
          )
        : -1;

    return {
      id: s.id,
      name: s.name,
      ratio: stageRatio,
    };
  });
  const theMaps = stageRatios.filter((sr) => sr.ratio !== -1);
  const bestMap = theMaps.sort((a, b) => b.ratio - a.ratio);
  if (bestMap.length === 0) {
    return {
      id: -1,
      name: "",
    };
  }
  const returnMap =
    bestMap[bestMap.length - 1].ratio === 0
      ? { id: -1, name: "" }
      : bestMap[bestMap.length - 1];
  return returnMap;
}
