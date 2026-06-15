import React from "react";
import { createRoot } from "react-dom/client";
import { ScratchPrototype } from "./ScratchPrototype";
import "./styles.css";

createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <ScratchPrototype />
  </React.StrictMode>,
);
