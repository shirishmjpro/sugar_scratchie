export type Vec2 = {
  x: number;
  y: number;
};

export type SymbolPoint = {
  u: number;
  v: number;
};

export const CANVAS_WIDTH = 390;
export const CANVAS_HEIGHT = 672;
export const SYMBOL_POINT_COUNT = 12;

export type TrackedMeshFrame = {
  t: number;
  verts: Vec2[];
  vis: number[];
};

export type TrackedMesh = {
  cols: number;
  rows: number;
  fps: number;
  uv: Vec2[];
  frames: TrackedMeshFrame[];
  garment: number[] | null;
  symbolPoints: SymbolPoint[] | null;
};

export type TrackedMeshSample = {
  cols: number;
  rows: number;
  uv: Vec2[];
  verts: Vec2[];
  vis: number[];
};

function clampValue(value: number, lo: number, hi: number) {
  return value < lo ? lo : value > hi ? hi : value;
}

export function parseTrackedMesh(value: unknown): TrackedMesh | null {
  if (!value || typeof value !== "object") return null;
  const data = value as {
    mesh?: { cols?: unknown; rows?: unknown };
    fps?: unknown;
    uv?: unknown;
    frames?: unknown;
    garment?: unknown;
    symbolPoints?: unknown;
  };
  const cols = Number(data.mesh?.cols);
  const rows = Number(data.mesh?.rows);
  if (
    !Number.isInteger(cols) ||
    !Number.isInteger(rows) ||
    cols < 2 ||
    rows < 2
  ) {
    return null;
  }
  if (
    !Array.isArray(data.uv) ||
    !Array.isArray(data.frames) ||
    data.frames.length === 0
  ) {
    return null;
  }

  const expected = cols * rows;
  const uv = data.uv as unknown[];
  if (uv.length !== expected) return null;

  const garmentSource = Array.isArray(data.garment)
    ? (data.garment as unknown[])
    : null;
  const garment =
    garmentSource && garmentSource.length === expected
      ? garmentSource.map((flag) => (Number(flag) ? 1 : 0))
      : null;

  const parsedUv = uv.map((pair) => {
    const point = pair as number[];
    return { x: Number(point?.[0]), y: Number(point?.[1]) };
  });
  if (
    parsedUv.some(
      (point) => !Number.isFinite(point.x) || !Number.isFinite(point.y),
    )
  ) {
    return null;
  }

  const frames: TrackedMeshFrame[] = [];
  for (const rawFrame of data.frames as unknown[]) {
    const frame = rawFrame as { t?: unknown; verts?: unknown; vis?: unknown };
    if (
      typeof frame.t !== "number" ||
      !Array.isArray(frame.verts) ||
      frame.verts.length !== expected
    ) {
      return null;
    }
    const verts = (frame.verts as unknown[]).map((pair) => {
      const point = pair as number[];
      return { x: Number(point?.[0]), y: Number(point?.[1]) };
    });
    if (
      verts.some(
        (point) => !Number.isFinite(point.x) || !Number.isFinite(point.y),
      )
    ) {
      return null;
    }
    const visSource = Array.isArray(frame.vis) ? (frame.vis as unknown[]) : [];
    const vis = verts.map((_, index) => {
      if (garment && !garment[index]) return 0;
      return Number(visSource[index]) ? 1 : 0;
    });
    frames.push({ t: frame.t, verts, vis });
  }

  let symbolPoints: SymbolPoint[] | null = null;
  if (Array.isArray(data.symbolPoints)) {
    const parsed: SymbolPoint[] = [];
    for (const raw of data.symbolPoints as unknown[]) {
      if (!raw || typeof raw !== "object") continue;
      const entry = raw as { u?: unknown; v?: unknown };
      const u = Number(entry.u);
      const v = Number(entry.v);
      if (!Number.isFinite(u) || !Number.isFinite(v)) continue;
      if (u < 0 || u > 1 || v < 0 || v > 1) continue;
      parsed.push({ u, v });
    }
    symbolPoints = parsed.length > 0 ? parsed : null;
  }

  return {
    cols,
    rows,
    fps: Number(data.fps) || 10,
    uv: parsedUv,
    frames: frames.sort((a, b) => a.t - b.t),
    garment,
    symbolPoints,
  };
}

export function sampleTrackedMesh(mesh: TrackedMesh, time: number): TrackedMeshSample {
  const frames = mesh.frames;
  const loopTime =
    frames.length > 1 ? time % (frames[frames.length - 1].t || 1) : time;
  let previous = frames[0];
  let next = frames[frames.length - 1];
  for (let index = 0; index < frames.length; index += 1) {
    if (frames[index].t <= loopTime) previous = frames[index];
    if (frames[index].t >= loopTime) {
      next = frames[index];
      break;
    }
  }

  const span = next.t - previous.t;
  const blend = span > 0 ? (loopTime - previous.t) / span : 0;
  const verts = previous.verts.map((point, index) => {
    const target = next.verts[index] ?? point;
    return {
      x: point.x + (target.x - point.x) * blend,
      y: point.y + (target.y - point.y) * blend,
    };
  });
  const vis = previous.vis.map((value, index) =>
    value && next.vis[index] ? 1 : 0,
  );

  return { cols: mesh.cols, rows: mesh.rows, uv: mesh.uv, verts, vis };
}

export function meshVertexAt(sample: TrackedMeshSample, col: number, row: number) {
  return sample.verts[row * sample.cols + col];
}

export function cellVisible(sample: TrackedMeshSample, col: number, row: number) {
  const { cols, vis } = sample;
  return Boolean(
    vis[row * cols + col] &&
      vis[row * cols + col + 1] &&
      vis[(row + 1) * cols + col] &&
      vis[(row + 1) * cols + col + 1],
  );
}

function barycentric(point: Vec2, a: Vec2, b: Vec2, c: Vec2) {
  const v0x = b.x - a.x;
  const v0y = b.y - a.y;
  const v1x = c.x - a.x;
  const v1y = c.y - a.y;
  const v2x = point.x - a.x;
  const v2y = point.y - a.y;
  const denominator = v0x * v1y - v1x * v0y;
  if (Math.abs(denominator) < 1e-6) return null;
  const v = (v2x * v1y - v1x * v2y) / denominator;
  const w = (v0x * v2y - v2x * v0y) / denominator;
  const u = 1 - v - w;
  if (u < -0.001 || v < -0.001 || w < -0.001) return null;
  return { u, v, w };
}

export function trackedWorldToUv(
  sample: TrackedMeshSample,
  point: Vec2,
): Vec2 | null {
  for (let row = 0; row < sample.rows - 1; row += 1) {
    for (let col = 0; col < sample.cols - 1; col += 1) {
      if (!cellVisible(sample, col, row)) continue;
      const topLeft = meshVertexAt(sample, col, row);
      const topRight = meshVertexAt(sample, col + 1, row);
      const bottomLeft = meshVertexAt(sample, col, row + 1);
      const bottomRight = meshVertexAt(sample, col + 1, row + 1);
      const uvTL = sample.uv[row * sample.cols + col];
      const uvTR = sample.uv[row * sample.cols + col + 1];
      const uvBL = sample.uv[(row + 1) * sample.cols + col];
      const uvBR = sample.uv[(row + 1) * sample.cols + col + 1];

      const first = barycentric(point, topLeft, topRight, bottomRight);
      if (first) {
        return {
          x: uvTL.x * first.u + uvTR.x * first.v + uvBR.x * first.w,
          y: uvTL.y * first.u + uvTR.y * first.v + uvBR.y * first.w,
        };
      }
      const second = barycentric(point, topLeft, bottomRight, bottomLeft);
      if (second) {
        return {
          x: uvTL.x * second.u + uvBR.x * second.v + uvBL.x * second.w,
          y: uvTL.y * second.u + uvBR.y * second.v + uvBL.y * second.w,
        };
      }
    }
  }
  return null;
}

export function sampleMeshUvToWorld(
  sample: TrackedMeshSample,
  u: number,
  v: number,
): Vec2 {
  const { cols, rows, verts } = sample;
  const gx = clampValue(u * (cols - 1), 0, cols - 1);
  const gy = clampValue(v * (rows - 1), 0, rows - 1);
  const x0 = Math.floor(gx);
  const y0 = Math.floor(gy);
  const x1 = Math.min(cols - 1, x0 + 1);
  const y1 = Math.min(rows - 1, y0 + 1);
  const fx = gx - x0;
  const fy = gy - y0;
  const v00 = verts[y0 * cols + x0];
  const v10 = verts[y0 * cols + x1];
  const v01 = verts[y1 * cols + x0];
  const v11 = verts[y1 * cols + x1];
  const topX = v00.x + (v10.x - v00.x) * fx;
  const topY = v00.y + (v10.y - v00.y) * fx;
  const botX = v01.x + (v11.x - v01.x) * fx;
  const botY = v01.y + (v11.y - v01.y) * fx;
  return { x: topX + (botX - topX) * fy, y: topY + (botY - topY) * fy };
}

export function drawMeshLines(
  ctx: CanvasRenderingContext2D,
  sample: TrackedMeshSample,
) {
  const { cols, rows, verts, vis } = sample;
  ctx.strokeStyle = "rgba(120, 255, 180, 0.55)";
  ctx.lineWidth = 1;
  for (let row = 0; row < rows; row += 1) {
    for (let col = 0; col < cols; col += 1) {
      const index = row * cols + col;
      if (col + 1 < cols && vis[index] && vis[index + 1]) {
        ctx.beginPath();
        ctx.moveTo(verts[index].x, verts[index].y);
        ctx.lineTo(verts[index + 1].x, verts[index + 1].y);
        ctx.stroke();
      }
      if (row + 1 < rows && vis[index] && vis[index + cols]) {
        ctx.beginPath();
        ctx.moveTo(verts[index].x, verts[index].y);
        ctx.lineTo(verts[index + cols].x, verts[index + cols].y);
        ctx.stroke();
      }
    }
  }
}
