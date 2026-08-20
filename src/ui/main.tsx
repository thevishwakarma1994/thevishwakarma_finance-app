import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { registerProductionServiceWorker } from "../pwa/register.js";
import { App } from "./App.js";
import "./styles.css";

registerProductionServiceWorker();

const root = document.getElementById("root");
if (!root) {
  throw new Error("Missing #root");
}

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
