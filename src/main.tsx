import React from "react";
import { createRoot } from "react-dom/client";
import { Theme } from "@radix-ui/themes";
import { Dashboard } from "./Dashboard";
import { ScratchPrototype } from "./ScratchPrototype";
import "@radix-ui/themes/styles.css";
import "./styles.css";

const App = window.location.pathname === "/dashboard" ? Dashboard : ScratchPrototype;

createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <Theme
      accentColor="red"
      grayColor="sand"
      radius="medium"
    >
      <App />
    </Theme>
  </React.StrictMode>,
);
