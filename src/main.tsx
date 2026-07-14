import React, { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { Theme } from "@radix-ui/themes";
import { Dashboard } from "./Dashboard";
import { ModelsPage } from "./ModelsPage";
import { PhotoScratchTest } from "./PhotoScratchTest";
import { ScratchPrototype } from "./ScratchPrototype";
import { VideoFlowDesignerPage } from "./videoFlow/VideoFlowDesignerPage";
import { VideoFlowHubPage } from "./videoFlow/VideoFlowHubPage";
import { VideoFlowRunPage } from "./videoFlow/VideoFlowRunPage";
import "@radix-ui/themes/styles.css";
import "./styles.css";

function normalizePath(pathname: string): string {
  return pathname.replace(/\/+$/, "") || "/";
}

function pickApp(pathname: string) {
  const path = normalizePath(pathname);
  if (path === "/dashboard/video-flow/designer") return VideoFlowDesignerPage;
  if (path === "/dashboard/video-flow/run") return VideoFlowRunPage;
  if (path === "/dashboard/models") return ModelsPage;
  if (path === "/dashboard/video-flow" || path === "/video-flow") return VideoFlowHubPage;
  if (path === "/dashboard") return Dashboard;
  if (path === "/photo-scratch") return PhotoScratchTest;
  return ScratchPrototype;
}

function readLocation() {
  return {
    path: window.location.pathname,
    search: window.location.search,
  };
}

function App() {
  const [location, setLocation] = useState(readLocation);

  useEffect(() => {
    const sync = () => setLocation(readLocation());
    window.addEventListener("popstate", sync);
    return () => window.removeEventListener("popstate", sync);
  }, []);

  useEffect(() => {
    const onClick = (event: MouseEvent) => {
      if (event.defaultPrevented || event.button !== 0) return;
      if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      const target = event.target;
      if (!(target instanceof Element)) return;
      const anchor = target.closest("a");
      if (!anchor) return;
      if (anchor.target && anchor.target !== "_self") return;
      if (anchor.hasAttribute("download")) return;
      const href = anchor.getAttribute("href");
      if (!href || href.startsWith("#") || href.startsWith("mailto:") || href.startsWith("http")) {
        return;
      }
      const url = new URL(href, window.location.origin);
      if (url.origin !== window.location.origin) return;
      event.preventDefault();
      const next = `${url.pathname}${url.search}${url.hash}`;
      const current = `${window.location.pathname}${window.location.search}${window.location.hash}`;
      if (next !== current) {
        window.history.pushState(null, "", next);
      }
      setLocation({ path: url.pathname, search: url.search });
      window.scrollTo(0, 0);
    };
    document.addEventListener("click", onClick);
    return () => document.removeEventListener("click", onClick);
  }, []);

  const Page = pickApp(location.path);
  return <Page key={`${normalizePath(location.path)}${location.search}`} />;
}

createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <Theme accentColor="red" grayColor="sand" radius="medium">
      <App />
    </Theme>
  </React.StrictMode>,
);
