import styled from "styled-components";
import theme from "../../../../theme";

export const TableStyleDiv = styled.div`
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
      img {
        display: none;
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
      content: "Fighter";
      font-weight: bold;
      position: absolute;
    }
    td:nth-of-type(2):before {
      content: "Win Rate";
      font-weight: bold;
      position: absolute;
    }
    td:nth-of-type(3):before {
      content: "Matches";
      font-weight: bold;
      position: absolute;
    }
    td:nth-of-type(4):before {
      content: "Wins";
      font-weight: bold;
      position: absolute;
    }
    td:nth-of-type(5):before {
      content: "Losses";
      font-weight: bold;
      position: absolute;
    }
    td:nth-of-type(6):before {
      content: "Best Stage";
      font-weight: bold;
      position: absolute;
    }
    ,
    td:nth-of-type(7):before {
      content: "Worst Stage";
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
