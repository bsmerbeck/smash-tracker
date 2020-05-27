import { createBrowserHistory } from "history";
import { createStore, applyMiddleware, compose } from "redux";
import createRootReducer from "./ducks";

export const history = createBrowserHistory();

export default function configureStore(initialState) {
  const store = createStore(
    createRootReducer(history),
    initialState,
    compose(
      window.__REDUX_DEVTOOLS_EXTENSION__ &&
        window.__REDUX_DEVTOOLS_EXTENSION__()
    )
  );

  return store;
}
