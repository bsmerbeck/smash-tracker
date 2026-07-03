import React from "react";
import FormControl from "@material-ui/core/FormControl";
import FormGroup from "@material-ui/core/FormGroup";

export default (props) => {
  let { placeholder, name, value, onChange = () => null } = props;
  return (
    // <div class="col-lg">
    <FormGroup>
      <FormControl
        placeholder={placeholder}
        name={name}
        value={value ? value : ""}
        onChange={onChange}
      />
    </FormGroup>
  );
};
