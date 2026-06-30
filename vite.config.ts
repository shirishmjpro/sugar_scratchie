import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const meshDirectory = resolve("public/mesh");
const meshIndexFile = resolve(meshDirectory, "index.json");

function getMeshJsonFiles() {
  try {
    return readdirSync(meshDirectory)
      .filter((file) => file.toLowerCase().endsWith(".json") && file !== "index.json")
      .sort((a, b) => a.localeCompare(b));
  } catch {
    return [];
  }
}

function writeMeshIndex() {
  mkdirSync(meshDirectory, { recursive: true });
  writeFileSync(meshIndexFile, JSON.stringify({ files: getMeshJsonFiles() }, null, 2));
}

const crossOriginIsolationHeaders = {
  "Cross-Origin-Opener-Policy": "same-origin",
  "Cross-Origin-Embedder-Policy": "require-corp",
};

function crossOriginIsolationPlugin() {
  return {
    name: "cross-origin-isolation",
    configureServer(server: { middlewares: { use: (fn: (req: unknown, res: { setHeader: (k: string, v: string) => void }, next: () => void) => void) => void } }) {
      server.middlewares.use((_req, res, next) => {
        res.setHeader("Cross-Origin-Resource-Policy", "same-origin");
        next();
      });
    },
    configurePreviewServer(server: { middlewares: { use: (fn: (req: unknown, res: { setHeader: (k: string, v: string) => void }, next: () => void) => void) => void } }) {
      server.middlewares.use((_req, res, next) => {
        res.setHeader("Cross-Origin-Resource-Policy", "same-origin");
        next();
      });
    },
  };
}

export default defineConfig({
  plugins: [
    react(),
    crossOriginIsolationPlugin(),
    {
      name: "mesh-json-index",
      buildStart() {
        writeMeshIndex();
      },
      configureServer(server) {
        server.middlewares.use("/mesh/index.json", (_request, response) => {
          response.setHeader("Content-Type", "application/json");
          response.end(JSON.stringify({ files: getMeshJsonFiles() }));
        });
      },
    },
  ],
  server: {
    host: "0.0.0.0",
    port: 5080,
    headers: crossOriginIsolationHeaders,
    proxy: {
      "/api": "http://127.0.0.1:8090",
    },
  },
  preview: {
    host: "0.0.0.0",
    port: 5080,
    headers: crossOriginIsolationHeaders,
  },
});
