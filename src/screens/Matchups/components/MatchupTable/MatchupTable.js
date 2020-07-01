import React, { useContext } from "react";
import { MatchupsContext } from "../../Matchups";
import { useTable, usePagination } from "react-table";
import MaUTable from "@material-ui/core/Table";
import TableBody from "@material-ui/core/TableBody";
import TableCell from "@material-ui/core/TableCell";
import TableHead from "@material-ui/core/TableHead";
import TableRow from "@material-ui/core/TableRow";
import Button from "@material-ui/core/Button";
import Select from "@material-ui/core/Select";
import Typography from "@material-ui/core/Typography";
import styled from "styled-components";
import theme from "../../../../theme";

const Styles = styled.div`
  padding: 1rem;
  @media only screen and (max-width: 760px),
    (min-device-width: 768px) and (max-device-width: 1024px) {
    /* Force table to not be like tables anymore */

    thead,
    tbody,
    th,
    td,
    tr,
    tr .-odd,
    tr .-even {
      display: block !important;
    }

    thead.-header,
    thead.-filters,
    tbody {
      min-width: initial !important;
    }
    td {
      width: initial !important;
      div {
        text-align: center;
      }
      div {
        text-align: right !important;
      }
    }

    /* Hide table headers (but not display: none;, for accessibility) */
    thead tr {
      position: absolute;
      top: -9999px;
      left: -9999px;
    }

    tr {
      border: 1px solid #ccc;
    }

    td {
      /* Behave  like a "row" */
      z-index: 0;
      border: none;
      border-bottom: 1px solid #eee;
      position: relative;
      padding-left: 5px;
    }

    td:before {
      /* Now like a table header */
      position: absolute;
      z-index: -2;
      /* Top/left values mimic padding */
      text-align: left;
      white-space: nowrap;
    }

    /*
	Label the data
	*/
    td:nth-of-type(1):before {
      content: "Date:";
      font-weight: bold;
      position: absolute;
    }
    td:nth-of-type(2):before {
      content: "Fighter:";
      font-weight: bold;
      position: absolute;
    }
    td:nth-of-type(3):before {
      content: "Opponent";
      font-weight: bold;
      position: absolute;
    }
    td:nth-of-type(4):before {
      content: "Result";
      font-weight: bold;
      position: absolute;
    }
    td:nth-of-type(5):before {
      content: "Manage";
      font-weight: bold;
      position: absolute;
    }
  }
  table {
    border-spacing: 0;
    border: 1px solid black;
    .MuiTableHead-root {
      background-color: ${theme.palette.primary.dark};
    }

    tr {
      :last-child {
        td {
          border-bottom: 0;
        }
      }
    }
    th {
      color: ${theme.palette.primary.contrastText};
      text-align: center;
    }
    ,
    td {
      margin: 0;
      text-align: center;
      @media only screen and (max-width: 760px),
        (min-device-width: 768px) and (max-device-width: 1024px) {
        text-align: unset;
      }
      padding: 0.5rem;
      border-bottom: 1px solid black;
      border-right: 1px solid black;
      :last-child {
        border-right: 0;
      }
    }
  }
  .pagination {
    padding: 0.5rem;
    display: flex;
    justify-content: space-between;
  }
`;

const MatchupTable = () => {
  const { fighter, opponent, matches, auth, removeMatchup } = useContext(
    MatchupsContext
  );

  const columns = React.useMemo(
    () => [
      {
        Header: "Date",
        accessor: "time",
      },
      {
        Header: "Fighter",
        accessor: "fighter_id",
      },
      {
        Header: "Opponent",
        accessor: "opponent_id",
      },
      {
        Header: "Stage",
        accessor: "stage",
      },
      {
        Header: "Result",
        accessor: "win",
      },
      {
        Header: "Manage",
        accessor: "key",
        Cell: (row) => (
          <Button variant="contained" onClick={() => handleDeleteClick(row)}>
            Delete
          </Button>
        ),
      },
    ],
    []
  );

  if (matches[auth.uid] === null) {
    return (
      <div>
        <h3>No matches reported yet!</h3>
      </div>
    );
  }

  const matchData = Object.keys(matches[auth.uid])
    .map((entry) => {
      return {
        ...matches[auth.uid][entry],
        key: entry,
      };
    })
    .filter((match) => match.fighter_id === fighter.id)
    .filter((match2) => match2.opponent_id === opponent.id);

  const handleDeleteClick = (e) => {
    const row = e.row;
    const rowKey = row.original.key;
    removeMatchup(rowKey);
  };

  const newData = matchData
    .map((m) => {
      return {
        ...m,
        fighter_id: fighter.name,
        opponent_id: opponent.name,
        time: new Date(m.time).toLocaleString(),
        win: m.win ? "Win" : "Loss",
        stage: m.map ? m.map.name : "unknown",
      };
    })
    .reverse();

  return (
    <Styles>
      <Table columns={columns} data={newData} />
    </Styles>
  );
};

function Table({ columns, data }) {
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
      initialState: { pageIndex: 0 },
    },
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
                <TableCell {...column.getHeaderProps()}>
                  {column.render("Header")}
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

export default MatchupTable;
