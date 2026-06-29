#!/usr/bin/env python3
"""Relax folded (inverted) cells in a tracked-mesh JSON so the lattice stays a
valid quad grid every frame.

A full-canvas deformation field driven by a fast-moving limb shears the cells
between the limb and the static background until some flip (negative area). The
scratch->UV inversion (`trackedWorldToUv`) needs non-degenerate cells, so those
folded regions become un-scratchable. This pass applies localized Laplacian
smoothing ONLY to vertices that belong to an inverted (or near-degenerate) cell,
repeated until folds clear or MAX_ITERS is hit. Well-behaved regions (the torso,
the tracked arm bulk) are left untouched, so arm motion is preserved.

Usage: python scripts/untangle-mesh.py <mesh-file.json>
Env: MAX_ITERS (default 40), RELAX (0..1 step, default 0.5),
     MIN_AREA (cell area below this is treated as folded, default 1.0).
"""
import json
import os
import sys

import numpy as np

MAX_ITERS = int(os.environ.get("MAX_ITERS", "40"))
RELAX = float(os.environ.get("RELAX", "0.5"))
MIN_AREA = float(os.environ.get("MIN_AREA", "1.0"))


def signed_areas(verts, cols, rows):
    """Signed area of every (cols-1)x(rows-1) quad cell. verts: (N,2)."""
    grid = verts.reshape(rows, cols, 2)
    tl = grid[:-1, :-1]
    tr = grid[:-1, 1:]
    br = grid[1:, 1:]
    bl = grid[1:, :-1]
    area = np.zeros((rows - 1, cols - 1))
    for a, b in ((tl, tr), (tr, br), (br, bl), (bl, tl)):
        area += a[..., 0] * b[..., 1] - b[..., 0] * a[..., 1]
    return area * 0.5


def neighbor_average(grid):
    """Average of the 4-connected grid neighbours for each vertex (edge-aware)."""
    rows, cols, _ = grid.shape
    acc = np.zeros_like(grid)
    cnt = np.zeros((rows, cols, 1))
    for dr, dc in ((1, 0), (-1, 0), (0, 1), (0, -1)):
        r0, r1 = max(0, dr), rows + min(0, dr)
        c0, c1 = max(0, dc), cols + min(0, dc)
        sr0, sr1 = max(0, -dr), rows + min(0, -dr)
        sc0, sc1 = max(0, -dc), cols + min(0, -dc)
        acc[r0:r1, c0:c1] += grid[sr0:sr1, sc0:sc1]
        cnt[r0:r1, c0:c1] += 1
    return acc / np.maximum(cnt, 1)


def untangle_frame(verts, cols, rows):
    grid = verts.reshape(rows, cols, 2).astype(np.float64).copy()
    for _ in range(MAX_ITERS):
        area = signed_areas(grid.reshape(-1, 2), cols, rows)
        bad = area <= MIN_AREA  # (rows-1, cols-1)
        if not bad.any():
            break
        # Mark every vertex touching a bad cell.
        vmask = np.zeros((rows, cols), bool)
        br, bc = np.where(bad)
        for ddr in (0, 1):
            for ddc in (0, 1):
                vmask[br + ddr, bc + ddc] = True
        avg = neighbor_average(grid)
        move = vmask[..., None]
        grid = np.where(move, grid + RELAX * (avg - grid), grid)
    return grid.reshape(-1, 2)


def main():
    if len(sys.argv) < 2:
        raise SystemExit("usage: untangle-mesh.py <mesh-file.json>")
    name = sys.argv[1]
    path = name if os.path.isabs(name) or os.path.exists(name) else os.path.join("public/mesh", name)
    data = json.load(open(path))
    cols, rows = data["mesh"]["cols"], data["mesh"]["rows"]
    total = (cols - 1) * (rows - 1)

    before_inv = after_inv = 0
    for frame in data["frames"]:
        verts = np.array(frame["verts"], dtype=np.float64)
        before_inv += int((signed_areas(verts, cols, rows) <= MIN_AREA).sum())
        fixed = untangle_frame(verts, cols, rows)
        after_inv += int((signed_areas(fixed, cols, rows) <= MIN_AREA).sum())
        frame["verts"] = [[round(float(x), 1), round(float(y), 1)] for x, y in fixed]

    data["untangled"] = {"relax": RELAX, "maxIters": MAX_ITERS, "minArea": MIN_AREA}
    json.dump(data, open(path, "w"))
    nf = len(data["frames"])
    print(f"{os.path.basename(path)}: {nf} frames, {total} cells/frame")
    print(f"  folded cells (total): {before_inv} -> {after_inv}  "
          f"(mean/frame {before_inv / nf:.1f} -> {after_inv / nf:.1f})")


if __name__ == "__main__":
    main()
