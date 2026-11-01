import { render } from "preact";
import { App } from "./app.tsx";
import "pretendard/dist/web/variable/pretendardvariable-dynamic-subset.css"; // 자체 호스팅 (외부 요청 없음)
import "./styles.css";

render(<App />, document.getElementById("app")!);
