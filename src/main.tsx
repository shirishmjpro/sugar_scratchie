import React from "react";
import { createRoot } from "react-dom/client";
import { Theme } from "@radix-ui/themes";
import { Dashboard } from "./Dashboard";
import { ScratchPrototype } from "./ScratchPrototype";
import { VideoFlowDesignerPage } from "./videoFlow/VideoFlowDesignerPage";
import { VideoFlowHubPage } from "./videoFlow/VideoFlowHubPage";
import { VideoFlowRunPage } from "./videoFlow/VideoFlowRunPage";
import "@radix-ui/themes/styles.css";
import "./styles.css";

function pickApp() {
  const path = window.location.pathname.replace(/\/+$/, "") || "/";
  if (path === "/dashboard/video-flow/designer") return VideoFlowDesignerPage;
  if (path === "/dashboard/video-flow/run") return VideoFlowRunPage;
  if (path === "/dashboard/video-flow" || path === "/video-flow") return VideoFlowHubPage;
  if (path === "/dashboard") return Dashboard;
  return ScratchPrototype;
}

const App = pickApp();

createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <Theme accentColor="red" grayColor="sand" radius="medium">
      <App />
    </Theme>
  </React.StrictMode>,
);
