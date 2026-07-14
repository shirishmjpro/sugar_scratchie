import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import basicSsl from "@vitejs/plugin-basic-ssl";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const meshDirectory = resolve("public/mesh");
const meshIndexFile = resolve(meshDirectory, "index.json");
const cardsDirectory = resolve("public/cards");
const cardsIndexFile = resolve(cardsDirectory, "index.json");
const modelsDirectory = resolve("public/models");
const modelsIndexFile = resolve(modelsDirectory, "index.json");

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

function readCardMeta(cardDir: string, fallback: string) {
  const metaPath = resolve(cardDir, "meta.json");
  if (!existsSync(metaPath)) return { label: fallback };
  try {
    const data = JSON.parse(readFileSync(metaPath, "utf8")) as {
      label?: string;
      model_id?: string;
      photos?: Array<{ id?: string; src?: string }>;
    };
    return data;
  } catch {
    return { label: fallback };
  }
}

function readCardLabel(cardDir: string, fallback: string) {
  const meta = readCardMeta(cardDir, fallback);
  if (typeof meta.label === "string" && meta.label.trim()) return meta.label.trim();
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
    chroma_key?: boolean;
    model_id?: string;
    photos?: Array<{ id: string; src: string }>;
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
      const meta = readCardMeta(cardDir, entry.name.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase()));
      const photos = Array.isArray(meta.photos)
        ? meta.photos
            .filter(
              (photo): photo is { id: string; src: string } =>
                typeof photo?.id === "string" && typeof photo?.src === "string",
            )
            .map((photo) => ({ id: photo.id, src: photo.src }))
        : undefined;
      cards.push({
        id: entry.name,
        label: readCardLabel(cardDir, entry.name.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase())),
        bottom: publicCardUrl(`cards/${entry.name}/background.mp4`),
        foreground: publicCardUrl(`cards/${entry.name}/foreground.mp4`),
        mesh: `${entry.name}.json`,
        ...(typeof meta.model_id === "string" && meta.model_id.trim()
          ? { model_id: meta.model_id.trim() }
          : {}),
        ...(photos && photos.length > 0 ? { photos } : {}),
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

function findModelAvatar(modelId: string) {
  const modelDir = resolve(modelsDirectory, modelId);
  for (const ext of [".jpg", ".jpeg", ".png", ".webp"]) {
    const candidate = resolve(modelDir, `avatar${ext}`);
    if (existsSync(candidate)) return publicCardUrl(`models/${modelId}/avatar${ext}`);
  }
  return null;
}

function getModelsIndexPayload() {
  const models: Array<{ id: string; label: string; avatar: string | null }> = [];
  try {
    for (const entry of readdirSync(modelsDirectory, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const modelDir = resolve(modelsDirectory, entry.name);
      const metaPath = resolve(modelDir, "meta.json");
      let label = entry.name.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
      if (existsSync(metaPath)) {
        try {
          const data = JSON.parse(readFileSync(metaPath, "utf8")) as { label?: string };
          if (typeof data.label === "string" && data.label.trim()) label = data.label.trim();
        } catch {
          // keep fallback label
        }
      }
      models.push({
        id: entry.name,
        label,
        avatar: findModelAvatar(entry.name),
      });
    }
  } catch {
    return { models };
  }
  return { models };
}

function writeModelsIndex() {
  mkdirSync(modelsDirectory, { recursive: true });
  writeFileSync(modelsIndexFile, JSON.stringify(getModelsIndexPayload(), null, 2));
}

export default defineConfig({
  plugins: [
    react(),
    basicSsl(),
    {
      name: "mesh-json-index",
      buildStart() {
        writeMeshIndex();
        writeCardsIndex();
        writeModelsIndex();
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
        server.middlewares.use("/models/index.json", (_request, response) => {
          response.setHeader("Content-Type", "application/json");
          response.end(JSON.stringify(getModelsIndexPayload()));
        });
      },
    },
  ],
  server: {
    host: "0.0.0.0",
    port: 5080,
    https: true,
    proxy: {
      "/api": "http://127.0.0.1:8090",
    },
  },
  preview: {
    host: "0.0.0.0",
    port: 5080,
    https: true,
  },
});
