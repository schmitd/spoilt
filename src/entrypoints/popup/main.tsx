import { render } from "preact";
import { App } from "./App";
import "../../styles/tokens.css";
import "./style.css";

render(<App />, document.querySelector("#app")!);
