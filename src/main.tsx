import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import { InteractionMotion } from "./components/ui/InteractionMotion";
import { UiProvider } from "./components/ui/Feedback";
import "katex/dist/katex.min.css";
import "./styles.css";
import "./paper-reader-wireframe.css";
import "./workspace-shell.css";
import "./interaction-motion.css";
import "./ui-system.css";
import "./markdown-workspace.css";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <InteractionMotion><UiProvider><App /></UiProvider></InteractionMotion>
  </StrictMode>,
);
