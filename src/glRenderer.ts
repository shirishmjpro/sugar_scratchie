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

export class GarmentGLRenderer {
  private gl: WebGL2RenderingContext;
  private width: number;
  private height: number;

  private blit: WebGLProgram;
  private composite: WebGLProgram;
  private punch: WebGLProgram;
  private paint: WebGLProgram;
  private line: WebGLProgram;

  private quadBuf: WebGLBuffer;
  private meshPosBuf: WebGLBuffer;
  private meshUvBuf: WebGLBuffer;
  private meshIndexBuf: WebGLBuffer;
  private lineBuf: WebGLBuffer;

  private bottomTex: WebGLTexture;
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

  constructor(canvas: HTMLCanvasElement, width: number, height: number) {
    const gl = canvas.getContext("webgl2", { premultipliedAlpha: false, alpha: false });
    if (!gl) throw new Error("WebGL2 not available");
    this.gl = gl;
    this.width = width;
    this.height = height;

    this.blit = program(gl, BLIT_VS, BLIT_FS);
    this.composite = program(gl, BLIT_VS, COMPOSITE_FS);
    this.punch = program(gl, PUNCH_VS, PUNCH_FS);
    this.paint = program(gl, PAINT_VS, PAINT_FS);
    this.line = program(gl, LINE_VS, LINE_FS);

    this.quadBuf = gl.createBuffer()!;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.quadBuf);
    gl.bufferData(gl.ARRAY_BUFFER, QUAD, gl.STATIC_DRAW);

    this.meshPosBuf = gl.createBuffer()!;
    this.meshUvBuf = gl.createBuffer()!;
    this.meshIndexBuf = gl.createBuffer()!;
    this.lineBuf = gl.createBuffer()!;

    this.bottomTex = makeVideoTexture(gl);
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

  private uploadVideo(tex: WebGLTexture, video: HTMLVideoElement) {
    const gl = this.gl;
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, video);
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
    const gl = this.gl;
    gl.useProgram(prog);
    // Skip the upload to redraw the previously cached frame (video stalled but
    // its metadata — and thus videoWidth/Height for cover framing — persists).
    if (upload) this.uploadVideo(tex, video);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.uniform1i(gl.getUniformLocation(prog, "uTex"), 0);
    const chromaLoc = gl.getUniformLocation(prog, "uChroma");
    if (chromaLoc) gl.uniform1i(chromaLoc, chroma ? 1 : 0);
    this.coverUniforms(prog, video.videoWidth || this.width, video.videoHeight || this.height, camX, camY, overscan);
    this.bindQuad(prog);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  }

  render(
    bottomVideo: HTMLVideoElement | null,
    foregroundVideo: HTMLVideoElement | null,
    sample: GLMeshSample | null,
    showMesh: boolean,
    camera: { x: number; y: number } = { x: 0, y: 0 },
  ) {
    const gl = this.gl;

    // The chest-follow camera pans the PRESENTED layers (bottom video in step 1,
    // composite in step 4) by the same clip-space offset, with overscan headroom.
    // The foreground-into-FBO (step 2) and hole punching (step 3) stay in the
    // un-panned reference frame so scratch holes remain glued to the mesh.
    const camX = clamp(camera.x, -(PRESENT_ZOOM - 1), PRESENT_ZOOM - 1);
    const camY = clamp(camera.y, -(PRESENT_ZOOM - 1), PRESENT_ZOOM - 1);

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
    if (!fgFresh && !this.fgEverReady) return;

    if (fgFresh) {
      // 2. keyed foreground into fgFbo (reference frame — no camera/overscan)
      gl.bindFramebuffer(gl.FRAMEBUFFER, this.fgFbo);
      gl.viewport(0, 0, this.width, this.height);
      gl.disable(gl.BLEND);
      gl.clearColor(0, 0, 0, 0);
      gl.clear(gl.COLOR_BUFFER_BIT);
      this.drawVideo(this.blit, this.fgTex, foregroundVideo!, true);

      // 3. punch holes where scratched, within the tracked mesh
      if (sample) {
        this.drawMeshPunch(sample);
      }
      this.fgEverReady = true;
    }
    // If the foreground stalled we skip steps 2-3 and re-composite the last good
    // FBO contents below, so the performer freezes instead of disappearing.

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
