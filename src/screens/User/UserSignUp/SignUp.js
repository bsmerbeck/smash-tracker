import React, { useState } from "react";
import Link from "@material-ui/core/Link";
import TextField from "@material-ui/core/TextField";
import Button from "@material-ui/core/Button";
import FormControlLabel from "@material-ui/core/FormControlLabel";
import FormGroup from "@material-ui/core/FormGroup";
import { useHistory } from "react-router";

import { StyledSignUpInputDiv } from "./style";
import { connect, useSelector } from "react-redux";
import { useFirebase } from "react-redux-firebase";

const SignUp = ({ handleClose }) => {
  const firebase = useFirebase();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState(null);
  const history = useHistory();

  const createUserWithEmailAndPasswordHandler = (event, email, password) => {
    event.preventDefault();
    setEmail("");
    setPassword("");
    firebase
      .auth()
      .createUserWithEmailAndPassword(email, password)
      .then(() => {
        handleClose();
      })
      .catch(function (error) {
        // Handle Errors here.
        const errorCode = error.code;
        const errorMessage = error.message;
        setError(`${errorCode}: ${errorMessage}`);
        // ...
      });
  };
  const onChangeHandler = (event) => {
    const { name, value } = event.currentTarget;
    if (name === "userEmail") {
      setEmail(value);
    } else if (name === "userPassword") {
      setPassword(value);
    }
  };

  return (
    <div className="start">
      <h1>Sign Up</h1>
      <div>
        {error !== null && <div>{error}</div>}
        <FormGroup>
          <StyledSignUpInputDiv>
            <p>Email:</p>
            <TextField
              type="email"
              name="userEmail"
              value={email}
              placeholder="E.g: bob@gmail.com"
              id="userEmail"
              onChange={(event) => onChangeHandler(event)}
            />
          </StyledSignUpInputDiv>
          <StyledSignUpInputDiv>
            <p>Password:</p>
            <TextField
              type="password"
              name="userPassword"
              value={password}
              placeholder="Your Password"
              id="userPassword"
              onChange={(event) => onChangeHandler(event)}
            />
          </StyledSignUpInputDiv>
          <Button
            style={{ margin: "5px 0" }}
            variant="contained"
            onClick={(event) => {
              createUserWithEmailAndPasswordHandler(event, email, password);
            }}
          >
            Sign up
          </Button>
        </FormGroup>
        <p>
          Already have an account?{" "}
          <Link href="#" onClick={() => history.push("/signin")}>
            Sign in here
          </Link>
        </p>
      </div>
    </div>
  );
};

export default SignUp;
