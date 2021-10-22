import palette from "../palette";
import typography from "../typography";

const muiTableCellOverride = {
  root: {
    ...typography.body1,
    borderBottom: `1px solid ${palette.divider}`,
  },
};

export default muiTableCellOverride;
