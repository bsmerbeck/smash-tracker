import React, { useContext } from "react";
import { FighterAnalysisContext } from "../../FighterAnalysis";
import { useFilters, usePagination, useSortBy, useTable } from "react-table";
import MaUTable from "@material-ui/core/Table";
import TableHead from "@material-ui/core/TableHead";
import TableRow from "@material-ui/core/TableRow";
import TableCell from "@material-ui/core/TableCell";
import TableBody from "@material-ui/core/TableBody";
import Button from "@material-ui/core/Button";
import Typography from "@material-ui/core/Typography";
import Select from "@material-ui/core/Select";
import TableContainer from "@material-ui/core/TableContainer";
import { TableStyleDiv } from "../RosterBreakdown/style";

const OpponentTable = (props) => {
  const context = useContext(FighterAnalysisContext);
  const { matches, fighter, opponents } = context;

  const entries = Object.keys(matches[context.auth.uid]);
  const real_matches = entries.map((e) => matches[context.auth.uid][e]);
  const fighter_matches = real_matches.filter(
    (m) => m.fighter_id === fighter.id
  );

  const fighter_opponent_matches = fighter_matches.filter(
    (m) => m.opponent && m.opponent.length > 0
  );

  const flags = new Set();
  fighter_opponent_matches.filter((entry) => {
    if (!flags.has(entry.opponent)) {
      flags.add(entry.opponent);
      return true;
    }
    return false;
  });

  let tableData = [];
  flags.forEach((f) => {
    const opp_match = fighter_opponent_matches.filter((m) => m.opponent === f);
    const opp_length = opp_match.length;
    const opp_wins = opp_match.filter((m) => m.win).length;
    const opp_win_rate = ((opp_wins / opp_length) * 100).toFixed(0);
    tableData.push({
      opponent: f,
      match_count: opp_length,
      win_count: opp_wins,
      loss_count: opp_length - opp_wins,
      win_rate: opp_win_rate,
    });
  });

  console.log(tableData);

  return (
    <TableStyleDiv style={{ flex: 1 }}>
      <TableContainer style={{ maxHeight: "400px" }}>
        <Table columns={headers} data={tableData} />
      </TableContainer>
    </TableStyleDiv>
  );
};

export default OpponentTable;

const headers = [
  {
    Header: "Opponent",
    accessor: "opponent",
  },
  {
    Header: "Win Rate",
    accessor: "win_rate",
  },
  {
    Header: "Matches",
    Filter: NumberRangeColumnFilter,
    filter: "between",
    accessor: "match_count",
  },
  {
    Header: "Wins",
    accessor: "win_count",
  },
  {
    Header: "Losses",
    accessor: "loss_count",
  },
];

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
            {[10, 20, 30, 40, 50].map((pageSize) => (
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
