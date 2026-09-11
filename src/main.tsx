import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import { UiProvider } from "./components/ui/Feedback";
import "katex/dist/katex.min.css";
import "./styles.css";
import "./paper-reader-wireframe.css";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <UiProvider><App /></UiProvider>
  </StrictMode>,
);
