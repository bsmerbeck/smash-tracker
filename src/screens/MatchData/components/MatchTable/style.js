import styled from "styled-components";
import theme from "../../../../theme";

export const StyledMatchTableDiv = styled.div`
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
