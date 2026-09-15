/**
 * 节目监视器 GPU 出画：WebGL2 全屏贴图。
 * 合成规则仍由 C++ EditGraph compose 权威产出；此处只负责 GPU 呈现。
 */
type PresentSource = HTMLCanvasElement | HTMLImageElement | ImageBitmap | OffscreenCanvas | VideoFrame

type GpuCtx = {
  gl: WebGL2RenderingContext
  prog: WebGLProgram
  vao: WebGLVertexArrayObject
  tex: WebGLTexture
  uTex: WebGLUniformLocation | null
  w: number
  h: number
}

const byCanvas = new WeakMap<HTMLCanvasElement, GpuCtx>()

function compile(gl: WebGL2RenderingContext, type: number, src: string) {
  const sh = gl.createShader(type)
  if (!sh) return null
  gl.shaderSource(sh, src)
  gl.compileShader(sh)
  if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
    gl.deleteShader(sh)
    return null
  }
  return sh
}

function makeProgram(gl: WebGL2RenderingContext) {
  const vs = compile(gl, gl.VERTEX_SHADER, `#version 300 es
in vec2 a; out vec2 v;
void main(){ v = a * 0.5 + 0.5; v.y = 1.0 - v.y; gl_Position = vec4(a,0.0,1.0); }`)
  const fs = compile(gl, gl.FRAGMENT_SHADER, `#version 300 es
precision mediump float; uniform sampler2D u; in vec2 v; out vec4 o;
void main(){ o = texture(u, v); }`)
  if (!vs || !fs) return null
  const p = gl.createProgram()
  if (!p) return null
  gl.attachShader(p, vs)
  gl.attachShader(p, fs)
  gl.bindAttribLocation(p, 0, 'a')
  gl.linkProgram(p)
  gl.deleteShader(vs)
  gl.deleteShader(fs)
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) {
    gl.deleteProgram(p)
    return null
  }
  return p
}

function ensure(canvas: HTMLCanvasElement, w: number, h: number): GpuCtx | null {
  let ctx = byCanvas.get(canvas)
  if (ctx && (canvas.width !== w || canvas.height !== h)) {
    canvas.width = w
    canvas.height = h
    ctx.gl.viewport(0, 0, w, h)
    ctx.w = w
    ctx.h = h
  }
  if (ctx) return ctx

  canvas.width = w
  canvas.height = h
  // 若此 canvas 已被 2d 占用，getContext('webgl2') 会返回 null
  const gl = canvas.getContext('webgl2', {
    alpha: false,
    antialias: false,
    depth: false,
    stencil: false,
    preserveDrawingBuffer: true,
    powerPreference: 'high-performance',
  })
  if (!gl) return null
  const prog = makeProgram(gl)
  if (!prog) return null
  const vao = gl.createVertexArray()
  const buf = gl.createBuffer()
  const tex = gl.createTexture()
  if (!vao || !buf || !tex) return null
  gl.bindVertexArray(vao)
  gl.bindBuffer(gl.ARRAY_BUFFER, buf)
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([
    -1, -1, 1, -1, -1, 1,
    -1, 1, 1, -1, 1, 1,
  ]), gl.STATIC_DRAW)
  gl.enableVertexAttribArray(0)
  gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0)
  gl.bindTexture(gl.TEXTURE_2D, tex)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
  gl.useProgram(prog)
  const uTex = gl.getUniformLocation(prog, 'u')
  gl.uniform1i(uTex, 0)
  gl.viewport(0, 0, w, h)
  ctx = { gl, prog, vao, tex, uTex, w, h }
  byCanvas.set(canvas, ctx)
  return ctx
}

/** GPU 呈现；失败返回 false（调用方回退 2d）。 */
export function presentOnGpu(
  canvas: HTMLCanvasElement,
  source: PresentSource,
  w: number,
  h: number,
): boolean {
  const ctx = ensure(canvas, w, h)
  if (!ctx) return false
  const { gl, prog, vao, tex } = ctx
  gl.bindVertexArray(vao)
  gl.useProgram(prog)
  gl.activeTexture(gl.TEXTURE0)
  gl.bindTexture(gl.TEXTURE_2D, tex)
  try {
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, source)
  } catch {
    return false
  }
  gl.clearColor(0.043, 0.051, 0.063, 1)
  gl.clear(gl.COLOR_BUFFER_BIT)
  gl.drawArrays(gl.TRIANGLES, 0, 6)
  return true
}

export function gpuPresentAvailable(): boolean {
  try {
    const c = document.createElement('canvas')
    const gl = c.getContext('webgl2')
    return !!gl
  } catch {
    return false
  }
}
