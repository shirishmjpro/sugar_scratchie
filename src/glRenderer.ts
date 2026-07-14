// WebGL2 renderer for the scratch prototype.
//
// Compositing pipeline (per frame):
//   1. bottom video  -> screen, aspect-cover (fills canvas, crops overflow)
//   2. foreground video -> offscreen FBO, chroma-keyed in the fragment shader
//   3. tracked mesh triangles -> punch holes in that FBO wherever the UV-space
//      scratch texture is marked (multiplies dst alpha by 1 - scratch)
//   4. composite the FBO over the bottom video
//   5. optional mesh lattice overlay
//
// Scratches live in a persistent UV-space texture painted by `paintScratch`,
// so a hole rides the same patch of fabric the mesh tracks.

type Pt = { x: number; y: number };

export type GLMeshSample = {
  cols: number;
  rows: number;
  uv: Pt[];
  verts: Pt[];
  vis: number[];
};

const SCRATCH_TEX_SIZE = 1024;
// Zoom applied to the presented layers (bottom video + final composite) for a
// tighter shot framed on the performer. It doubles as pan headroom: the
// chest-follow camera offset stays below PRESENT_ZOOM-1 so no canvas edge shows.
export const PRESENT_ZOOM = 1.15;

export type ImageLayerDepths = {
  back: number;
  mid: number;
  front: number;
};

export const PHOTO_LAYER_DEPTHS: ImageLayerDepths = {
  back: 1,
  mid: 0.6,
  front: 0.25,
};

export type ImageLayerCameras = {
  back: { x: number; y: number };
  mid: { x: number; y: number };
  front: { x: number; y: number };
};

function clamp(value: number, lo: number, hi: number) {
  return value < lo ? lo : value > hi ? hi : value;
}

function compile(gl: WebGL2RenderingContext, type: number, src: string) {
  const shader = gl.createShader(type)!;
  gl.shaderSource(shader, src);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    throw new Error("shader compile failed: " + gl.getShaderInfoLog(shader) + "\n" + src);
  }
  return shader;
}

function program(gl: WebGL2RenderingContext, vs: string, fs: string) {
  const p = gl.createProgram()!;
  gl.attachShader(p, compile(gl, gl.VERTEX_SHADER, vs));
  gl.attachShader(p, compile(gl, gl.FRAGMENT_SHADER, fs));
  gl.linkProgram(p);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) {
    throw new Error("program link failed: " + gl.getProgramInfoLog(p));
  }
  return p;
}

function makeTexture(gl: WebGL2RenderingContext, width: number, height: number) {
  const tex = gl.createTexture()!;
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, width, height, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  return tex;
}

function makeVideoTexture(gl: WebGL2RenderingContext) {
  const tex = gl.createTexture()!;
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  return tex;
}

type ImageSource = HTMLImageElement | HTMLVideoElement | HTMLCanvasElement;

function sourceDimensions(source: ImageSource): { w: number; h: number } {
  if (source instanceof HTMLVideoElement) {
    return { w: source.videoWidth, h: source.videoHeight };
  }
  if (source instanceof HTMLImageElement) {
    return { w: source.naturalWidth, h: source.naturalHeight };
  }
  return { w: source.width, h: source.height };
}

// Fullscreen-ish quad in [0,1]^2, drawn as a triangle strip.
const QUAD = new Float32Array([0, 0, 1, 0, 0, 1, 1, 1]);

const BLIT_VS = `#version 300 es
in vec2 aPos;
uniform vec2 uScale;
uniform vec2 uOffset;
out vec2 vUV;
void main() {
  vUV = aPos;
  vec2 p = aPos * 2.0 - 1.0;
  gl_Position = vec4(p * uScale + uOffset, 0.0, 1.0);
}`;

const BLIT_FS = `#version 300 es
precision highp float;
in vec2 vUV;
uniform sampler2D uTex;
uniform bool uChroma;
out vec4 frag;
void main() {
  vec4 c = texture(uTex, vUV);
  if (uChroma) {
    float dominance = c.g - max(c.r, c.b);
    if (c.g > 0.51 && dominance > 0.149) {
      c.a = max(0.0, 1.0 - dominance * 6.0);
    }
  }
  frag = c;
}`;

// Composite an FBO color texture (already canvas-space) over the screen.
const COMPOSITE_FS = `#version 300 es
precision highp float;
in vec2 vUV;
uniform sampler2D uTex;
out vec4 frag;
void main() { frag = texture(uTex, vUV); }`;

const PUNCH_VS = `#version 300 es
in vec2 aPos;   // canvas pixels
in vec2 aUV;    // garment uv
uniform vec2 uCanvas;
out vec2 vUV;
void main() {
  vUV = aUV;
  vec2 clip = vec2(aPos.x / uCanvas.x * 2.0 - 1.0, 1.0 - aPos.y / uCanvas.y * 2.0);
  gl_Position = vec4(clip, 0.0, 1.0);
}`;

const PUNCH_FS = `#version 300 es
precision highp float;
in vec2 vUV;
uniform sampler2D uScratch;
out vec4 frag;
void main() {
  float s = clamp(texture(uScratch, vUV).r, 0.0, 1.0);
  frag = vec4(0.0, 0.0, 0.0, s); // src alpha = scratch amount
}`;

// Paint a soft dot into the UV-space scratch texture.
const PAINT_VS = `#version 300 es
in vec2 aPos;        // unit quad 0..1
uniform vec2 uCenter; // uv center 0..1
uniform float uRadius; // uv radius
out vec2 vLocal;
void main() {
  vLocal = aPos * 2.0 - 1.0;
  vec2 uv = uCenter + vLocal * uRadius;
  gl_Position = vec4(uv * 2.0 - 1.0, 0.0, 1.0);
}`;

const PAINT_FS = `#version 300 es
precision highp float;
in vec2 vLocal;
out vec4 frag;
void main() {
  float d = length(vLocal);
  float a = smoothstep(1.0, 0.55, d);
  frag = vec4(a, 0.0, 0.0, 1.0);
}`;

const LINE_VS = `#version 300 es
in vec2 aPos;
uniform vec2 uCanvas;
void main() {
  vec2 clip = vec2(aPos.x / uCanvas.x * 2.0 - 1.0, 1.0 - aPos.y / uCanvas.y * 2.0);
  gl_Position = vec4(clip, 0.0, 1.0);
}`;

const LINE_FS = `#version 300 es
precision highp float;
out vec4 frag;
void main() { frag = vec4(1.0, 1.0, 1.0, 0.2); }`;

// Flying fabric flakes: peel off at scratch points, scale up toward the viewer,
// spin, drift, and fade. Fabric color is sampled from fgColorTex at spawn UV.
const FLAKE_VS = `#version 300 es
in vec2 aPos;
uniform vec2 uCanvas;
uniform vec2 uCenter;
uniform vec2 uSpawnUV;
uniform float uSize;
uniform float uRotation;
uniform vec2 uPresentScale;
uniform vec2 uPresentOffset;
out vec2 vLocal;
out vec2 vFabricUV;
void main() {
  vLocal = aPos * 2.0 - 1.0;
  vFabricUV = uSpawnUV;
  vec2 local = vLocal * uSize;
  float c = cos(uRotation);
  float s = sin(uRotation);
  vec2 rotated = vec2(local.x * c - local.y * s, local.x * s + local.y * c);
  vec2 refPx = uCenter + rotated;
  vec2 clip = vec2(refPx.x / uCanvas.x * 2.0 - 1.0, 1.0 - refPx.y / uCanvas.y * 2.0);
  gl_Position = vec4(clip * uPresentScale + uPresentOffset, 0.0, 1.0);
}`;

const FLAKE_FS = `#version 300 es
precision highp float;
in vec2 vLocal;
in vec2 vFabricUV;
uniform sampler2D uFabric;
uniform float uAlpha;
out vec4 frag;
void main() {
  vec4 fabric = texture(uFabric, vFabricUV);
  float d = length(vLocal);
  float round = smoothstep(1.0, 0.25, d);
  float tear = smoothstep(0.95, 0.55, abs(vLocal.x) + abs(vLocal.y) * 0.35);
  float mask = round * tear;
  frag = vec4(fabric.rgb, mask * uAlpha);
}`;

const FLAKE_COUNT_PER_SCRATCH = 2;
const FLAKE_MAX = 120;
const FLAKE_LIFE = 0.7;
const FLAKE_SCALE_MIN = 0.2;
const FLAKE_SCALE_MAX = 0.55;
const FLAKE_BASE_SIZE = 6;
const FLAKE_GRAVITY = 140;

type Flake = {
  x: number;
  y: number;
  spawnU: number;
  spawnV: number;
  baseSize: number;
  rotation: number;
  angularVel: number;
  vx: number;
  vy: number;
  age: number;
  life: number;
};

export class GarmentGLRenderer {
  private gl: WebGL2RenderingContext;
  private width: number;
  private height: number;

  private blit: WebGLProgram;
  private composite: WebGLProgram;
  private punch: WebGLProgram;
  private paint: WebGLProgram;
  private line: WebGLProgram;
  private flake: WebGLProgram;

  private quadBuf: WebGLBuffer;
  private meshPosBuf: WebGLBuffer;
  private meshUvBuf: WebGLBuffer;
  private meshIndexBuf: WebGLBuffer;
  private lineBuf: WebGLBuffer;

  private bottomTex: WebGLTexture;
  private midTex: WebGLTexture;
  private fgTex: WebGLTexture;
  private scratchTex: WebGLTexture;
  private scratchFbo: WebGLFramebuffer;
  private fgColorTex: WebGLTexture;
  private fgFbo: WebGLFramebuffer;
  // Once a video has been drawn at least once we keep drawing its last good
  // frame even if it momentarily stalls (common on mobile during a loop wrap, or
  // when a second video element gets suspended). This stops the foreground from
  // blinking out to "just the bottom video", and stops scratched holes from
  // flashing black when the bottom video wraps.
  private fgEverReady = false;
  private bottomEverReady = false;
  private flakes: Flake[] = [];
  private lastRenderTime = 0;
  // Per-video-texture upload state: the dimensions we allocated storage at and
  // the last video time we uploaded. Lets us (a) update with texSubImage2D
  // instead of reallocating with texImage2D every frame, and (b) skip uploads
  // entirely when the video hasn't advanced to a new frame. Both are large wins
  // in Safari, where texImage2D-from-video is very expensive.
  private videoTexState = new WeakMap<WebGLTexture, { w: number; h: number; t: number }>();
  // requestVideoFrameCallback bookkeeping: which videos we've hooked, and whether
  // a genuinely new decoded frame is waiting to be uploaded. rVFC fires exactly
  // once per presented frame, so it's the precise way to avoid re-uploading the
  // same frame (better than the currentTime heuristic, which is the fallback for
  // browsers without rVFC).
  private videoFrameHooked = new WeakSet<HTMLVideoElement>();
  private videoFrameReady = new WeakMap<HTMLVideoElement, boolean>();
  private imageTexState = new WeakMap<WebGLTexture, { w: number; h: number; src: ImageSource }>();
  private lastFrontPresentCamera = { x: 0, y: 0 };

  constructor(
    canvas: HTMLCanvasElement,
    width: number,
    height: number,
    options?: { alpha?: boolean; preserveDrawingBuffer?: boolean },
  ) {
    const gl = canvas.getContext("webgl2", {
      premultipliedAlpha: false,
      alpha: options?.alpha ?? false,
      preserveDrawingBuffer: options?.preserveDrawingBuffer ?? false,
    });
    if (!gl) throw new Error("WebGL2 not available");
    this.gl = gl;
    this.width = width;
    this.height = height;

    this.blit = program(gl, BLIT_VS, BLIT_FS);
    this.composite = program(gl, BLIT_VS, COMPOSITE_FS);
    this.punch = program(gl, PUNCH_VS, PUNCH_FS);
    this.paint = program(gl, PAINT_VS, PAINT_FS);
    this.line = program(gl, LINE_VS, LINE_FS);
    this.flake = program(gl, FLAKE_VS, FLAKE_FS);

    this.quadBuf = gl.createBuffer()!;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.quadBuf);
    gl.bufferData(gl.ARRAY_BUFFER, QUAD, gl.STATIC_DRAW);

    this.meshPosBuf = gl.createBuffer()!;
    this.meshUvBuf = gl.createBuffer()!;
    this.meshIndexBuf = gl.createBuffer()!;
    this.lineBuf = gl.createBuffer()!;

    this.bottomTex = makeVideoTexture(gl);
    this.midTex = makeVideoTexture(gl);
    this.fgTex = makeVideoTexture(gl);

    this.scratchTex = makeTexture(gl, SCRATCH_TEX_SIZE, SCRATCH_TEX_SIZE);
    this.scratchFbo = gl.createFramebuffer()!;
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.scratchFbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this.scratchTex, 0);
    this.clearScratch();

    this.fgColorTex = makeTexture(gl, width, height);
    this.fgFbo = gl.createFramebuffer()!;
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.fgFbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this.fgColorTex, 0);

    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
  }

  // Drop the "last good frame" memory so a card switch doesn't briefly composite
  // the previous clip's performer over the new background while it decodes.
  resetForeground() {
    this.fgEverReady = false;
    this.bottomEverReady = false;
    // Force the next frame of each video to re-upload (and reallocate if the new
    // clip differs in size) rather than being skipped as an unchanged frame.
    this.videoTexState.delete(this.bottomTex);
    this.videoTexState.delete(this.fgTex);
    this.imageTexState.delete(this.bottomTex);
    this.imageTexState.delete(this.midTex);
    this.imageTexState.delete(this.fgTex);
    this.clearFlakes();
  }

  getFrontPresentCamera() {
    return { ...this.lastFrontPresentCamera };
  }

  clearFlakes() {
    this.flakes = [];
  }

  spawnFlakes(refX: number, refY: number, count = FLAKE_COUNT_PER_SCRATCH) {
    for (let i = 0; i < count; i += 1) {
      const angle = Math.random() * Math.PI * 2;
      const speed = 40 + Math.random() * 60;
      this.flakes.push({
        x: refX + (Math.random() - 0.5) * 8,
        y: refY + (Math.random() - 0.5) * 8,
        spawnU: refX / this.width,
        spawnV: refY / this.height,
        baseSize: FLAKE_BASE_SIZE * (0.75 + Math.random() * 0.5),
        rotation: Math.random() * Math.PI * 2,
        angularVel: (Math.random() - 0.5) * 10,
        vx: Math.cos(angle) * speed * 0.35,
        vy: Math.sin(angle) * speed * 0.35 - 30,
        age: 0,
        life: FLAKE_LIFE * (0.85 + Math.random() * 0.3),
      });
    }
    while (this.flakes.length > FLAKE_MAX) {
      this.flakes.shift();
    }
  }

  clearScratch() {
    const gl = this.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.scratchFbo);
    gl.viewport(0, 0, SCRATCH_TEX_SIZE, SCRATCH_TEX_SIZE);
    gl.clearColor(0, 0, 0, 1);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  }

  // Paint a scratch dot at garment uv (0..1).
  paintScratch(u: number, v: number, radius: number) {
    const gl = this.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.scratchFbo);
    gl.viewport(0, 0, SCRATCH_TEX_SIZE, SCRATCH_TEX_SIZE);
    gl.useProgram(this.paint);
    gl.enable(gl.BLEND);
    gl.blendEquation(gl.MAX);
    gl.blendFunc(gl.ONE, gl.ONE);
    gl.uniform2f(gl.getUniformLocation(this.paint, "uCenter"), u, v);
    gl.uniform1f(gl.getUniformLocation(this.paint, "uRadius"), radius);
    this.bindQuad(this.paint);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    gl.blendEquation(gl.FUNC_ADD);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  }

  private bindQuad(prog: WebGLProgram) {
    const gl = this.gl;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.quadBuf);
    const loc = gl.getAttribLocation(prog, "aPos");
    gl.enableVertexAttribArray(loc);
    gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
  }

  private coverUniforms(
    prog: WebGLProgram,
    videoW: number,
    videoH: number,
    camX = 0,
    camY = 0,
    overscan = 1,
  ) {
    const gl = this.gl;
    // Cover: scale so the video fills the whole canvas, cropping the overflowing
    // edge (Math.max). The offline mesh generator letterboxes/crops identically
    // (force_original_aspect_ratio=increase + center crop), so the tracked verts
    // stay aligned with the drawn pixels. `overscan` adds pan headroom; the
    // camera offset is clamped to that headroom so no canvas edge is revealed.
    const scale = Math.max(this.width / videoW, this.height / videoH) * overscan;
    const w = (videoW * scale) / this.width; // >=1: overflow is cropped at clip edges
    const h = (videoH * scale) / this.height;
    gl.uniform2f(gl.getUniformLocation(prog, "uScale"), w, h);
    gl.uniform2f(gl.getUniformLocation(prog, "uOffset"), clamp(camX, -(w - 1), w - 1), clamp(camY, -(h - 1), h - 1));
  }

  // Hook requestVideoFrameCallback (once per video) so we know precisely when a
  // new decoded frame is available. Returns false if rVFC is unsupported, so the
  // caller falls back to the currentTime heuristic.
  private hookVideoFrames(video: HTMLVideoElement): boolean {
    type RVFCVideo = HTMLVideoElement & {
      requestVideoFrameCallback?: (cb: () => void) => number;
    };
    const rvfcVideo = video as RVFCVideo;
    if (typeof rvfcVideo.requestVideoFrameCallback !== "function") return false;
    if (this.videoFrameHooked.has(video)) return true;
    this.videoFrameHooked.add(video);
    this.videoFrameReady.set(video, true);
    const onFrame = () => {
      this.videoFrameReady.set(video, true);
      rvfcVideo.requestVideoFrameCallback?.(onFrame);
    };
    rvfcVideo.requestVideoFrameCallback(onFrame);
    return true;
  }

  private uploadVideo(tex: WebGLTexture, video: HTMLVideoElement) {
    const gl = this.gl;
    const vw = video.videoWidth;
    const vh = video.videoHeight;
    if (!vw || !vh) return;

    const state = this.videoTexState.get(tex);
    const sizeChanged = !state || state.w !== vw || state.h !== vh;

    // Re-uploading a frame the texture already holds is pure waste (the render
    // loop ticks faster than the clip's fps). Decide if there's anything new:
    // prefer rVFC ("a new frame was presented"); fall back to a currentTime
    // change. Either way this cuts uploads to roughly the clip's real fps.
    if (this.hookVideoFrames(video)) {
      if (!sizeChanged && !this.videoFrameReady.get(video)) return;
      this.videoFrameReady.set(video, false);
    } else if (!sizeChanged && state && state.t === video.currentTime) {
      return;
    }

    gl.bindTexture(gl.TEXTURE_2D, tex);
    if (sizeChanged) {
      // First frame, or the source changed size (card switch): (re)allocate.
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, video);
    } else {
      // Steady state: update the existing texture in place. Much cheaper than a
      // fresh texImage2D allocation each frame on Safari.
      gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, gl.RGBA, gl.UNSIGNED_BYTE, video);
    }
    this.videoTexState.set(tex, { w: vw, h: vh, t: video.currentTime });
  }

  private uploadImage(tex: WebGLTexture, source: ImageSource) {
    const gl = this.gl;
    const { w, h } = sourceDimensions(source);
    if (!w || !h) return;

    const state = this.imageTexState.get(tex);
    const sizeChanged = !state || state.w !== w || state.h !== h || state.src !== source;
    if (!sizeChanged) return;

    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, source);
    this.imageTexState.set(tex, { w, h, src: source });
  }

  private drawSource(
    prog: WebGLProgram,
    tex: WebGLTexture,
    source: ImageSource,
    chroma: boolean,
    camX = 0,
    camY = 0,
    overscan = 1,
    upload = true,
  ) {
    const gl = this.gl;
    gl.useProgram(prog);
    if (upload) {
      if (source instanceof HTMLVideoElement) {
        this.uploadVideo(tex, source);
      } else {
        this.uploadImage(tex, source);
      }
    }
    const { w, h } = sourceDimensions(source);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.uniform1i(gl.getUniformLocation(prog, "uTex"), 0);
    const chromaLoc = gl.getUniformLocation(prog, "uChroma");
    if (chromaLoc) gl.uniform1i(chromaLoc, chroma ? 1 : 0);
    this.coverUniforms(prog, w || this.width, h || this.height, camX, camY, overscan);
    this.bindQuad(prog);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  }

  private drawVideo(
    prog: WebGLProgram,
    tex: WebGLTexture,
    video: HTMLVideoElement,
    chroma: boolean,
    camX = 0,
    camY = 0,
    overscan = 1,
    upload = true,
  ) {
    this.drawSource(prog, tex, video, chroma, camX, camY, overscan, upload);
  }

  private drawImageLayer(
    image: HTMLImageElement | null,
    tex: WebGLTexture,
    camera: { x: number; y: number },
    chroma: boolean,
    blendOnTop: boolean,
    overscan = PRESENT_ZOOM,
  ) {
    if (!image || !image.complete || !image.naturalWidth) return false;
    const gl = this.gl;
    if (blendOnTop) {
      gl.enable(gl.BLEND);
      gl.blendEquation(gl.FUNC_ADD);
      gl.blendFuncSeparate(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA, gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    } else {
      gl.disable(gl.BLEND);
    }
    this.drawSource(this.blit, tex, image, chroma, camera.x, camera.y, overscan);
    return true;
  }

  // Still-image variant: background can parallax independently; foreground +
  // scratch holes stay in the reference frame (presented without bg camera).
  renderImages(
    bottomImage: HTMLImageElement | null,
    foregroundImage: HTMLImageElement | null,
    sample: GLMeshSample | null,
    showMesh: boolean,
    backgroundCamera: { x: number; y: number } = { x: 0, y: 0 },
    foregroundChroma = false,
  ) {
    this.renderImageLayers(
      bottomImage,
      null,
      foregroundImage,
      sample,
      showMesh,
      {
        back: backgroundCamera,
        mid: { x: 0, y: 0 },
        front: { x: 0, y: 0 },
      },
      foregroundChroma,
    );
  }

  /**
   * Photo-scratch foreground pass: mid (bikini) + front (clothes) share one
   * camera so they stay locked together. Background is a separate CSS layer.
   * Canvas must be created with `{ alpha: true }` so the room shows through.
   */
  renderPhotoForeground(
    midImage: HTMLImageElement | null,
    frontImage: HTMLImageElement | null,
    sample: GLMeshSample | null,
    showMesh: boolean,
    camera: { x: number; y: number } = { x: 0, y: 0 },
    frontChroma = false,
  ) {
    const gl = this.gl;
    const cam = {
      x: clamp(camera.x, -(PRESENT_ZOOM - 1), PRESENT_ZOOM - 1),
      y: clamp(camera.y, -(PRESENT_ZOOM - 1), PRESENT_ZOOM - 1),
    };
    this.lastFrontPresentCamera = cam;

    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, this.width, this.height);
    gl.disable(gl.BLEND);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);

    // Bikini / mid — same present camera as clothes.
    if (midImage) {
      this.drawImageLayer(midImage, this.midTex, cam, false, true);
    }

    const frontReady =
      !!frontImage && frontImage.complete && frontImage.naturalWidth > 0;
    if (!frontReady) {
      if (showMesh && sample) {
        this.drawMeshLines(sample);
      }
      return;
    }

    gl.bindFramebuffer(gl.FRAMEBUFFER, this.fgFbo);
    gl.viewport(0, 0, this.width, this.height);
    gl.disable(gl.BLEND);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    this.drawSource(this.blit, this.fgTex, frontImage!, frontChroma);

    if (sample) {
      this.drawMeshPunch(sample);
    }
    this.fgEverReady = true;

    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, this.width, this.height);
    gl.useProgram(this.composite);
    gl.enable(gl.BLEND);
    gl.blendEquation(gl.FUNC_ADD);
    gl.blendFuncSeparate(
      gl.SRC_ALPHA,
      gl.ONE_MINUS_SRC_ALPHA,
      gl.ONE,
      gl.ONE_MINUS_SRC_ALPHA,
    );
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.fgColorTex);
    gl.uniform1i(gl.getUniformLocation(this.composite, "uTex"), 0);
    gl.uniform2f(
      gl.getUniformLocation(this.composite, "uScale"),
      PRESENT_ZOOM,
      PRESENT_ZOOM,
    );
    gl.uniform2f(gl.getUniformLocation(this.composite, "uOffset"), cam.x, cam.y);
    this.bindQuad(this.composite);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);

    if (showMesh && sample) {
      this.drawMeshLines(sample);
    }
  }

  // Linked parallax layers: one shared tilt vector scaled by depth; scratch FBO
  // stays in the reference frame so holes remain glued to the front garment.
  renderImageLayers(
    backImage: HTMLImageElement | null,
    midImage: HTMLImageElement | null,
    frontImage: HTMLImageElement | null,
    sample: GLMeshSample | null,
    showMesh: boolean,
    cameras: ImageLayerCameras,
    frontChroma = true,
  ) {
    const gl = this.gl;
    const backCam = {
      x: clamp(cameras.back.x, -(PRESENT_ZOOM - 1), PRESENT_ZOOM - 1),
      y: clamp(cameras.back.y, -(PRESENT_ZOOM - 1), PRESENT_ZOOM - 1),
    };
    const midCam = {
      x: clamp(cameras.mid.x, -(PRESENT_ZOOM - 1), PRESENT_ZOOM - 1),
      y: clamp(cameras.mid.y, -(PRESENT_ZOOM - 1), PRESENT_ZOOM - 1),
    };
    const frontCam = {
      x: clamp(cameras.front.x, -(PRESENT_ZOOM - 1), PRESENT_ZOOM - 1),
      y: clamp(cameras.front.y, -(PRESENT_ZOOM - 1), PRESENT_ZOOM - 1),
    };
    this.lastFrontPresentCamera = frontCam;

    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, this.width, this.height);
    gl.disable(gl.BLEND);
    gl.clearColor(0, 0, 0, 1);
    gl.clear(gl.COLOR_BUFFER_BIT);

    if (this.drawImageLayer(backImage, this.bottomTex, backCam, false, false)) {
      this.bottomEverReady = true;
    } else if (backImage && this.bottomEverReady) {
      this.drawSource(this.blit, this.bottomTex, backImage, false, backCam.x, backCam.y, PRESENT_ZOOM, false);
    }

    this.drawImageLayer(midImage, this.midTex, midCam, false, true);

    const frontReady = !!frontImage && frontImage.complete && frontImage.naturalWidth > 0;
    if (!frontReady && !this.fgEverReady) return;

    if (frontReady) {
      gl.bindFramebuffer(gl.FRAMEBUFFER, this.fgFbo);
      gl.viewport(0, 0, this.width, this.height);
      gl.disable(gl.BLEND);
      gl.clearColor(0, 0, 0, 0);
      gl.clear(gl.COLOR_BUFFER_BIT);
      this.drawSource(this.blit, this.fgTex, frontImage!, frontChroma);

      if (sample) {
        this.drawMeshPunch(sample);
      }
      this.fgEverReady = true;
    }

    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, this.width, this.height);
    gl.useProgram(this.composite);
    gl.enable(gl.BLEND);
    gl.blendEquation(gl.FUNC_ADD);
    gl.blendFuncSeparate(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA, gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.fgColorTex);
    gl.uniform1i(gl.getUniformLocation(this.composite, "uTex"), 0);
    gl.uniform2f(gl.getUniformLocation(this.composite, "uScale"), PRESENT_ZOOM, PRESENT_ZOOM);
    gl.uniform2f(gl.getUniformLocation(this.composite, "uOffset"), frontCam.x, frontCam.y);
    this.bindQuad(this.composite);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);

    if (showMesh && sample) {
      this.drawMeshLines(sample);
    }
  }

  render(
    bottomVideo: HTMLVideoElement | null,
    foregroundVideo: HTMLVideoElement | null,
    sample: GLMeshSample | null,
    showMesh: boolean,
    camera: { x: number; y: number } = { x: 0, y: 0 },
    hideForeground = false,
    foregroundChroma = true,
  ) {
    const gl = this.gl;

    // The chest-follow camera pans the PRESENTED layers (bottom video in step 1,
    // composite in step 4) by the same clip-space offset, with overscan headroom.
    // The foreground-into-FBO (step 2) and hole punching (step 3) stay in the
    // un-panned reference frame so scratch holes remain glued to the mesh.
    const camX = clamp(camera.x, -(PRESENT_ZOOM - 1), PRESENT_ZOOM - 1);
    const camY = clamp(camera.y, -(PRESENT_ZOOM - 1), PRESENT_ZOOM - 1);

    const now = performance.now();
    const dt = this.lastRenderTime > 0 ? Math.min(0.05, (now - this.lastRenderTime) / 1000) : 0;
    this.lastRenderTime = now;
    this.updateFlakes(dt);

    // 1. bottom video to screen
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, this.width, this.height);
    gl.disable(gl.BLEND);
    gl.clearColor(0, 0, 0, 1);
    gl.clear(gl.COLOR_BUFFER_BIT);
    if (bottomVideo && bottomVideo.readyState >= 2) {
      this.drawVideo(this.blit, this.bottomTex, bottomVideo, false, camX, camY, PRESENT_ZOOM);
      this.bottomEverReady = true;
    } else if (bottomVideo && this.bottomEverReady) {
      // Bottom stalled (e.g. mid loop wrap): redraw its last frame so scratched
      // holes keep revealing video instead of flashing black.
      this.drawVideo(this.blit, this.bottomTex, bottomVideo, false, camX, camY, PRESENT_ZOOM, false);
    }

    const fgFresh = !!foregroundVideo && foregroundVideo.readyState >= 2;
    // Nothing to show yet: bail until the foreground has decoded its first frame.
    if (!hideForeground && !fgFresh && !this.fgEverReady) return;

    if (!hideForeground && fgFresh) {
      // 2. keyed foreground into fgFbo (reference frame — no camera/overscan)
      gl.bindFramebuffer(gl.FRAMEBUFFER, this.fgFbo);
      gl.viewport(0, 0, this.width, this.height);
      gl.disable(gl.BLEND);
      gl.clearColor(0, 0, 0, 0);
      gl.clear(gl.COLOR_BUFFER_BIT);
      this.drawVideo(this.blit, this.fgTex, foregroundVideo!, foregroundChroma);

      // 3. punch holes where scratched, within the tracked mesh
      if (sample) {
        this.drawMeshPunch(sample);
      }
      this.fgEverReady = true;
    }
    // If the foreground stalled we skip steps 2-3 and re-composite the last good
    // FBO contents below, so the performer freezes instead of disappearing.

    if (!hideForeground) {
    // 4. composite fg (with holes) over the bottom video on screen
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, this.width, this.height);
    gl.useProgram(this.composite);
    gl.enable(gl.BLEND);
    gl.blendEquation(gl.FUNC_ADD);
    gl.blendFuncSeparate(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA, gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.fgColorTex);
    gl.uniform1i(gl.getUniformLocation(this.composite, "uTex"), 0);
    // Present the FBO (foreground + holes) with the same overscan + camera pan
    // as the bottom video so the whole shot moves together.
    gl.uniform2f(gl.getUniformLocation(this.composite, "uScale"), PRESENT_ZOOM, PRESENT_ZOOM);
    gl.uniform2f(gl.getUniformLocation(this.composite, "uOffset"), camX, camY);
    this.bindQuad(this.composite);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    }

    // 4.5. flying fabric flakes over the composite
    this.drawFlakes(camX, camY);

    // 5. mesh overlay
    if (showMesh && sample) {
      this.drawMeshLines(sample);
    }
  }

  private buildVisibleIndices(sample: GLMeshSample) {
    const { cols, rows, vis } = sample;
    const idx: number[] = [];
    const v = (c: number, r: number) => vis[r * cols + c];
    for (let r = 0; r < rows - 1; r++) {
      for (let c = 0; c < cols - 1; c++) {
        const tl = r * cols + c;
        const tr = tl + 1;
        const bl = tl + cols;
        const br = bl + 1;
        if (v(c, r) && v(c + 1, r) && v(c, r + 1) && v(c + 1, r + 1)) {
          idx.push(tl, tr, br, tl, br, bl);
        }
      }
    }
    return new Uint16Array(idx);
  }

  private uploadMesh(sample: GLMeshSample) {
    const gl = this.gl;
    const n = sample.verts.length;
    const pos = new Float32Array(n * 2);
    const uv = new Float32Array(n * 2);
    for (let i = 0; i < n; i++) {
      pos[i * 2] = sample.verts[i].x;
      pos[i * 2 + 1] = sample.verts[i].y;
      uv[i * 2] = sample.uv[i].x;
      uv[i * 2 + 1] = sample.uv[i].y;
    }
    gl.bindBuffer(gl.ARRAY_BUFFER, this.meshPosBuf);
    gl.bufferData(gl.ARRAY_BUFFER, pos, gl.DYNAMIC_DRAW);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.meshUvBuf);
    gl.bufferData(gl.ARRAY_BUFFER, uv, gl.DYNAMIC_DRAW);
  }

  private drawMeshPunch(sample: GLMeshSample) {
    const gl = this.gl;
    const indices = this.buildVisibleIndices(sample);
    if (indices.length === 0) return;
    this.uploadMesh(sample);

    gl.useProgram(this.punch);
    gl.enable(gl.BLEND);
    gl.blendEquation(gl.FUNC_ADD);
    // dst.rgb unchanged, dst.a *= (1 - src.a)
    gl.blendFuncSeparate(gl.ZERO, gl.ONE, gl.ZERO, gl.ONE_MINUS_SRC_ALPHA);

    gl.bindBuffer(gl.ARRAY_BUFFER, this.meshPosBuf);
    const posLoc = gl.getAttribLocation(this.punch, "aPos");
    gl.enableVertexAttribArray(posLoc);
    gl.vertexAttribPointer(posLoc, 2, gl.FLOAT, false, 0, 0);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.meshUvBuf);
    const uvLoc = gl.getAttribLocation(this.punch, "aUV");
    gl.enableVertexAttribArray(uvLoc);
    gl.vertexAttribPointer(uvLoc, 2, gl.FLOAT, false, 0, 0);

    gl.uniform2f(gl.getUniformLocation(this.punch, "uCanvas"), this.width, this.height);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.scratchTex);
    gl.uniform1i(gl.getUniformLocation(this.punch, "uScratch"), 0);

    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.meshIndexBuf);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, indices, gl.DYNAMIC_DRAW);
    gl.drawElements(gl.TRIANGLES, indices.length, gl.UNSIGNED_SHORT, 0);
  }

  private updateFlakes(dt: number) {
    if (dt <= 0 || this.flakes.length === 0) return;
    const next: Flake[] = [];
    for (const flake of this.flakes) {
      flake.age += dt;
      if (flake.age >= flake.life) continue;
      flake.x += flake.vx * dt;
      flake.y += flake.vy * dt;
      flake.vy += FLAKE_GRAVITY * dt;
      flake.rotation += flake.angularVel * dt;
      next.push(flake);
    }
    this.flakes = next;
  }

  private drawFlakes(camX: number, camY: number) {
    if (this.flakes.length === 0 || !this.fgEverReady) return;
    const gl = this.gl;
    gl.useProgram(this.flake);
    gl.enable(gl.BLEND);
    gl.blendEquation(gl.FUNC_ADD);
    gl.blendFuncSeparate(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA, gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.fgColorTex);
    gl.uniform1i(gl.getUniformLocation(this.flake, "uFabric"), 0);
    gl.uniform2f(gl.getUniformLocation(this.flake, "uCanvas"), this.width, this.height);
    gl.uniform2f(gl.getUniformLocation(this.flake, "uPresentScale"), PRESENT_ZOOM, PRESENT_ZOOM);
    gl.uniform2f(gl.getUniformLocation(this.flake, "uPresentOffset"), camX, camY);
    this.bindQuad(this.flake);

    const centerLoc = gl.getUniformLocation(this.flake, "uCenter");
    const spawnLoc = gl.getUniformLocation(this.flake, "uSpawnUV");
    const sizeLoc = gl.getUniformLocation(this.flake, "uSize");
    const rotLoc = gl.getUniformLocation(this.flake, "uRotation");
    const alphaLoc = gl.getUniformLocation(this.flake, "uAlpha");

    for (const flake of this.flakes) {
      const t = flake.age / flake.life;
      const ease = 1 - (1 - t) * (1 - t);
      const scaleMult = FLAKE_SCALE_MIN + (FLAKE_SCALE_MAX - FLAKE_SCALE_MIN) * ease;
      const alpha = t < 0.65 ? 1 : 1 - (t - 0.65) / 0.35;
      gl.uniform2f(centerLoc, flake.x, flake.y);
      gl.uniform2f(spawnLoc, flake.spawnU, 1 - flake.spawnV);
      gl.uniform1f(sizeLoc, flake.baseSize * scaleMult);
      gl.uniform1f(rotLoc, flake.rotation);
      gl.uniform1f(alphaLoc, alpha);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    }
  }

  private drawMeshLines(sample: GLMeshSample) {
    const gl = this.gl;
    const { cols, rows, verts, vis } = sample;
    const segs: number[] = [];
    const push = (a: number, b: number) => {
      if (!vis[a] || !vis[b]) return;
      segs.push(verts[a].x, verts[a].y, verts[b].x, verts[b].y);
    };
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const i = r * cols + c;
        if (c + 1 < cols) push(i, i + 1);
        if (r + 1 < rows) push(i, i + cols);
      }
    }
    if (segs.length === 0) return;
    gl.useProgram(this.line);
    gl.enable(gl.BLEND);
    gl.blendEquation(gl.FUNC_ADD);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.lineBuf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(segs), gl.DYNAMIC_DRAW);
    const loc = gl.getAttribLocation(this.line, "aPos");
    gl.enableVertexAttribArray(loc);
    gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
    gl.uniform2f(gl.getUniformLocation(this.line, "uCanvas"), this.width, this.height);
    gl.drawArrays(gl.LINES, 0, segs.length / 2);
  }
}
