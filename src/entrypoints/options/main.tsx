import { render } from "preact";
import { App } from "./App";
import "../../styles/tokens.css";
import "../popup/style.css";
import "./style.css";

render(<App />, document.querySelector("#app")!);
