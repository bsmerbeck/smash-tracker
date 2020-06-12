import React, { useContext, useMemo, useState } from "react";
import { MatchupsContext } from "../../Matchups";
import { useTable, usePagination } from "react-table";
import MaUTable from "@material-ui/core/Table";
import TableBody from "@material-ui/core/TableBody";
import TableCell from "@material-ui/core/TableCell";
import TableHead from "@material-ui/core/TableHead";
import TableRow from "@material-ui/core/TableRow";
import Button from "@material-ui/core/Button";
import Select from "@material-ui/core/Select";
import Input from "@material-ui/core/Input";
import styled from "styled-components";
import theme from "../../../../theme";
import { useFirebase } from "react-redux-firebase";

const Styles = styled.div`
  padding: 1rem;
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
  const { matchups, fighter, opponent, auth } = useContext(MatchupsContext);
  const firebase = useFirebase();

  const [theMatches, setTheMatches] = useState(matchups);

  const handleDeleteClick = (e) => {
    const row = e.row;
    const rowKey = row.original.key;
    firebase.remove(`/matches/${auth.uid}/${rowKey}`).then(() => {
      const _matches = theMatches.filter((tm) => tm.key !== rowKey);
      setTheMatches(_matches);
    });
  };

  const newData = theMatches
    .map((m) => {
      return {
        ...m,
        fighter_id: fighter.name,
        opponent_id: opponent.name,
        time: new Date(m.time).toLocaleString(),
        win: m.win ? "Win" : "Loss",
      };
    })
    .reverse();

  const data = useMemo(() => newData, []);

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
                      {cell.render("Cell")}
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
          Page{" "}
          <strong>
            {pageIndex + 1} of {pageOptions.length}
          </strong>{" "}
        </div>
        <div>
          <span>
            | Go to page:{" "}
            <Input
              type="number"
              defaultValue={pageIndex + 1}
              onChange={(e) => {
                const page = e.target.value ? Number(e.target.value) - 1 : 0;
                gotoPage(page);
              }}
              style={{ width: "100px" }}
            />
          </span>{" "}
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
