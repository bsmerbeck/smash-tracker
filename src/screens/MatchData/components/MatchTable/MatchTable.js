import React from "react";
import { MatchDataContext } from "../../MatchData";
import { SpriteList } from "../../../../components/Sprites/SpriteList";
import {
  useTable,
  usePagination,
  useSortBy,
  useFilters,
  useAsyncDebounce,
  useGlobalFilter,
} from "react-table";
import MaUTable from "@material-ui/core/Table";
import TableBody from "@material-ui/core/TableBody";
import TableCell from "@material-ui/core/TableCell";
import TableHead from "@material-ui/core/TableHead";
import TableRow from "@material-ui/core/TableRow";
import Button from "@material-ui/core/Button";
import Select from "@material-ui/core/Select";
import Typography from "@material-ui/core/Typography";
import { StyledMatchTableDiv } from "./style";
import CustomInput from "./CustomInput";

const MatchTable = () => {
  const { matches, auth, removeMatchup, updateMatch } = React.useContext(
    MatchDataContext
  );

  const [rowData, setRowData] = React.useState({});

  const [dialogState, setDialogState] = React.useState(false);

  const handleDeleteClick = (e) => {
    const row = e.row;
    const rowKey = row.original.key;
    removeMatchup(rowKey);
  };

  const handleUpdateSave = () => {};

  const toggleEditDialog = () => {
    setDialogState(!dialogState);
  };

  const openEditWindow = (e) => {
    const row = e.row;
    const rowData = row.original;
    setRowData(rowData);
    toggleEditDialog();
  };

  const headers = [
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
      Header: "Opponent Name",
      accessor: "opponent",
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
      Header: "Notes",
      accessor: "notes",
    },
    {
      Header: "Manage",
      accessor: "key",
      Cell: (row) => (
        <div>
          <Button
            style={{ margin: "3px" }}
            variant="contained"
            onClick={() => openEditWindow(row)}
          >
            Edit
          </Button>
          <Button
            color="primary"
            style={{ margin: "3px" }}
            variant="contained"
            onClick={() => handleDeleteClick(row)}
          >
            Delete
          </Button>
        </div>
      ),
    },
  ];

  if (matches === undefined) {
    return <div />;
  }

  const matchData = Object.keys(matches[auth.uid]).map((entry) => {
    return {
      ...matches[auth.uid][entry],
      key: entry,
    };
  });

  const getFighterName = (fid) => {
    return SpriteList.filter((sl) => sl.id === fid)[0].name;
  };

  const newData = matchData
    .map((m) => {
      return {
        ...m,
        fighter_id: getFighterName(m.fighter_id),
        opponent_id: getFighterName(m.opponent_id),
        time: new Date(m.time).toLocaleString(),
        win: m.win ? "Win" : "Loss",
        stage: m.map ? m.map.name : "unknown",
        matchType: m.matchType ? m.matchType : "",
        opponent: m.opponent ? m.opponent : "",
        notes: m.notes ? m.notes : "",
      };
    })
    .reverse();

  return (
    <StyledMatchTableDiv>
      <Table columns={headers} data={newData} />
    </StyledMatchTableDiv>
  );
};

function dateValid(rowValue) {
  return new Date.prototype.getTime() === rowValue.getTime();
}

function Table({ columns, data }) {
  const filterTypes = {
    year: (rows, id, filterValue) => {
      return rows.filter((row) => {
        const rowValue = row.values[id];
        return rowValue !== undefined &&
          Number(filterValue) &&
          new Date(rowValue) &&
          dateValid(new Date(rowValue))
          ? new Date(rowValue).getFullYear() === Number(filterValue)
          : true;
      });
    },
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
  };

  function GlobalFilter({
    preGlobalFilteredRows,
    globalFilter,
    setGlobalFilter,
  }) {
    const count = preGlobalFilteredRows.length;
    const [value, setValue] = React.useState(globalFilter);
    const onChange = useAsyncDebounce((value) => {
      setGlobalFilter(value || undefined);
    }, 200);

    return (
      <span>
        Search:{" "}
        <input
          value={value || ""}
          onChange={(e) => {
            setValue(e.target.value);
            onChange(e.target.value);
          }}
          placeholder={`${count} records...`}
          style={{
            fontSize: "1.1rem",
            border: "0",
          }}
        />
      </span>
    );
  }

  // Define a default UI for filtering
  function DefaultColumnFilter({
    column: { filterValue, preFilteredRows, setFilter },
  }) {
    const count = preFilteredRows.length;

    return (
      <input
        value={filterValue || ""}
        onChange={(e) => {
          setFilter(e.target.value || undefined); // Set undefined to remove the filter entirely
        }}
        placeholder={`Search ${count} records...`}
      />
    );
  }

  // This is a custom filter UI for selecting
  // a unique option from a list
  function SelectColumnFilter({
    column: { filterValue, setFilter, preFilteredRows, id },
  }) {
    // Calculate the options for filtering
    // using the preFilteredRows
    const options = React.useMemo(() => {
      const options = new Set();
      preFilteredRows.forEach((row) => {
        options.add(row.values[id]);
      });
      return [...options.values()];
    }, [id, preFilteredRows]);

    // Render a multi-select box
    return (
      <select
        value={filterValue}
        onChange={(e) => {
          setFilter(e.target.value || undefined);
        }}
      >
        <option value="">All</option>
        {options.map((option, i) => (
          <option key={i} value={option}>
            {option}
          </option>
        ))}
      </select>
    );
  }

  const defaultColumn = {
    // Let's set up our default Filter UI
    Filter: DefaultColumnFilter,
  };
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
    state,
    nextPage,
    previousPage,
    visibleColumns,
    setPageSize,
    preGlobalFilteredRows,
    setGlobalFilter,
    state: { pageIndex, pageSize },
  } = useTable(
    {
      columns,
      data,
      defaultColumn,
      filterTypes,
      initialState: { pageIndex: 0 },
    },
    useFilters,
    useGlobalFilter,
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
                <TableCell {...column.getHeaderProps()}>
                  <span {...column.getSortByToggleProps()}>
                    {column.render("Header")}
                    {column.isSorted
                      ? column.isSortedDesc
                        ? " 🔽"
                        : " 🔼"
                      : ""}
                  </span>
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

export default MatchTable;
