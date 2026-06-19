import React from "react";
import { createRoot } from "react-dom/client";
import { Dashboard } from "./Dashboard";
import { ScratchPrototype } from "./ScratchPrototype";
import "./styles.css";

const App = window.location.pathname === "/dashboard" ? Dashboard : ScratchPrototype;

createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
