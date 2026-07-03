import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const meshDirectory = resolve("public/mesh");
const meshIndexFile = resolve(meshDirectory, "index.json");
const cardsDirectory = resolve("public/cards");
const cardsIndexFile = resolve(cardsDirectory, "index.json");

const ORIGINAL_BACKGROUND = "ai girl 2.mp4";
const ORIGINAL_FOREGROUND = "Green bg sample 2 swap.mp4";

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

function readCardLabel(cardDir: string, fallback: string) {
  const metaPath = resolve(cardDir, "meta.json");
  if (!existsSync(metaPath)) return fallback;
  try {
    const data = JSON.parse(readFileSync(metaPath, "utf8")) as { label?: string };
    if (typeof data.label === "string" && data.label.trim()) return data.label.trim();
  } catch {
    return fallback;
  }
  return fallback;
}

function publicCardUrl(relativePath: string) {
  return `/${relativePath.split("/").map(encodeURIComponent).join("/")}`;
}

function getCardsIndexPayload() {
  const cards: Array<{
    id: string;
    label: string;
    bottom: string;
    foreground: string;
    mesh: string;
  }> = [
    {
      id: "original",
      label: readCardLabel(cardsDirectory, "Original"),
      bottom: publicCardUrl(`cards/${ORIGINAL_BACKGROUND}`),
      foreground: publicCardUrl(`cards/${ORIGINAL_FOREGROUND}`),
      mesh: "tracked-mesh.json",
    },
  ];

  try {
    for (const entry of readdirSync(cardsDirectory, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const cardDir = resolve(cardsDirectory, entry.name);
      const background = resolve(cardDir, "background.mp4");
      const foreground = resolve(cardDir, "foreground.mp4");
      if (!existsSync(background) || !existsSync(foreground)) continue;
      cards.push({
        id: entry.name,
        label: readCardLabel(cardDir, entry.name.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase())),
        bottom: publicCardUrl(`cards/${entry.name}/background.mp4`),
        foreground: publicCardUrl(`cards/${entry.name}/foreground.mp4`),
        mesh: `${entry.name}.json`,
      });
    }
  } catch {
    return { cards };
  }

  return { cards };
}

function writeCardsIndex() {
  mkdirSync(cardsDirectory, { recursive: true });
  writeFileSync(cardsIndexFile, JSON.stringify(getCardsIndexPayload(), null, 2));
}

export default defineConfig({
  plugins: [
    react(),
    {
      name: "mesh-json-index",
      buildStart() {
        writeMeshIndex();
        writeCardsIndex();
      },
      configureServer(server) {
        server.middlewares.use("/mesh/index.json", (_request, response) => {
          response.setHeader("Content-Type", "application/json");
          response.end(JSON.stringify({ files: getMeshJsonFiles() }));
        });
        server.middlewares.use("/cards/index.json", (_request, response) => {
          response.setHeader("Content-Type", "application/json");
          response.end(JSON.stringify(getCardsIndexPayload()));
        });
      },
    },
  ],
  server: {
    host: "0.0.0.0",
    port: 5080,
    proxy: {
      "/api": "http://127.0.0.1:8090",
    },
  },
  preview: {
    host: "0.0.0.0",
    port: 5080,
  },
});
