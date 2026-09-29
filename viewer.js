// WebGL 360 viewer for equirectangular panoramas, with the desktop viewer's camera model and controls.
const VERTEX = `#version 300 es
in vec2 position;
void main() { gl_Position = vec4(position, 0.0, 1.0); }`;

const FRAGMENT = `#version 300 es
precision highp float;
uniform sampler2D panorama;
uniform vec2 size;
uniform float focal;
uniform float yaw;
uniform float pitch;
out vec4 color;
const float PI = 3.141592653589793;
void main() {
  // Ray (right, up, 1) through this pixel, turned by yaw and pitch into world space.
  float right = (gl_FragCoord.x - 0.5 * size.x) / focal;
  float up = (gl_FragCoord.y - 0.5 * size.y) / focal;
  float cy = cos(yaw), sy = sin(yaw), cp = cos(pitch), sp = sin(pitch);
  vec3 ray = vec3(cp * sy - up * sp * sy + right * cy,
                  cp * cy - up * sp * cy - right * sy,
                  sp + up * cp);
  vec2 uv = vec2(atan(ray.x, ray.y) / (2.0 * PI) + 0.5,
                 0.5 - asin(clamp(ray.z / length(ray), -1.0, 1.0)) / PI);
  // Longitude jumps from 1 to 0 at the back seam; take gradients from a copy whose jump is elsewhere.
  float shifted = fract(uv.x + 0.5);
  float shiftedX = dFdx(shifted), shiftedY = dFdy(shifted);
  vec2 gradX = dFdx(uv), gradY = dFdy(uv);
  if (abs(shiftedX) < abs(gradX.x)) gradX.x = shiftedX;
  if (abs(shiftedY) < abs(gradY.x)) gradY.x = shiftedY;
  color = textureGrad(panorama, uv, gradX, gradY);
}`;

const clampPitch = (value) => Math.max(-Math.PI / 2, Math.min(Math.PI / 2, value));

export class PanoramaViewer {
  constructor(canvas, frame) {
    this.canvas = canvas;
    this.frame = frame;
    this.yaw = 0;
    this.pitch = 0;
    this.fov = 75;
    this.pointers = new Map();
    this.pinch = null;
    this.source = null;
    this.hasImage = false;
    this.queued = false;
    this.gl = canvas.getContext('webgl2', { antialias: false, alpha: false });
    if (!this.gl) return;
    this.setup();
    new ResizeObserver(() => this.draw()).observe(canvas);
    canvas.addEventListener('webglcontextlost', (event) => event.preventDefault());
    canvas.addEventListener('webglcontextrestored', () => {
      this.setup();
      if (this.source) this.load(this.source);
    });
    this.bindInput();
  }

  get supported() {
    return Boolean(this.gl);
  }

  setup() {
    const { gl } = this;
    const program = gl.createProgram();
    for (const [type, source] of [[gl.VERTEX_SHADER, VERTEX], [gl.FRAGMENT_SHADER, FRAGMENT]]) {
      const shader = gl.createShader(type);
      gl.shaderSource(shader, source);
      gl.compileShader(shader);
      if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(shader));
      gl.attachShader(program, shader);
    }
    gl.bindAttribLocation(program, 0, 'position');
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(program));
    this.program = program;
    this.uniforms = Object.fromEntries(['size', 'focal', 'yaw', 'pitch'].map((name) => [name, gl.getUniformLocation(program, name)]));

    // One triangle that covers the whole canvas.
    gl.bindVertexArray(gl.createVertexArray());
    gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer());
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);

    this.texture = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, this.texture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.REPEAT);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    const anisotropic = gl.getExtension('EXT_texture_filter_anisotropic');
    if (anisotropic) {
      const limit = gl.getParameter(anisotropic.MAX_TEXTURE_MAX_ANISOTROPY_EXT);
      gl.texParameterf(gl.TEXTURE_2D, anisotropic.TEXTURE_MAX_ANISOTROPY_EXT, Math.min(8, limit));
    }
    this.hasImage = false;
  }

  async load(blob) {
    const { gl } = this;
    if (!gl) throw new Error('this browser has no WebGL 2 support');
    let image = await createImageBitmap(blob);
    const limit = gl.getParameter(gl.MAX_TEXTURE_SIZE);
    if (image.width > limit || image.height > limit) {
      const scale = Math.min(limit / image.width, limit / image.height);
      const smaller = await createImageBitmap(image, {
        resizeWidth: Math.floor(image.width * scale),
        resizeHeight: Math.floor(image.height * scale),
        resizeQuality: 'high',
      });
      image.close();
      image = smaller;
    }
    const { width, height } = image;
    gl.bindTexture(gl.TEXTURE_2D, this.texture);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, image);
    gl.generateMipmap(gl.TEXTURE_2D);
    image.close();
    this.source = blob;
    this.hasImage = true;
    this.reset();
    return { width, height };
  }

  reset() {
    this.yaw = 0;
    this.pitch = 0;
    this.fov = 75;
    this.draw();
  }

  draw() {
    if (this.queued || !this.gl) return;
    this.queued = true;
    requestAnimationFrame(() => {
      this.queued = false;
      this.render();
    });
  }

  render() {
    const { gl, canvas } = this;
    const ratio = Math.min(window.devicePixelRatio || 1, 2);
    const width = Math.max(1, Math.round(canvas.clientWidth * ratio));
    const height = Math.max(1, Math.round(canvas.clientHeight * ratio));
    if (canvas.width !== width || canvas.height !== height) {
      canvas.width = width;
      canvas.height = height;
    }
    gl.viewport(0, 0, width, height);
    gl.clearColor(0, 0, 0, 1);
    gl.clear(gl.COLOR_BUFFER_BIT);
    if (!this.hasImage) return;
    gl.useProgram(this.program);
    gl.uniform2f(this.uniforms.size, width, height);
    gl.uniform1f(this.uniforms.focal, width / 2 / Math.tan((this.fov * Math.PI) / 360));
    gl.uniform1f(this.uniforms.yaw, this.yaw);
    gl.uniform1f(this.uniforms.pitch, this.pitch);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }

  turn(dx, dy) {
    // Turn by the angle one screen pixel spans, so the scene stays under the pointer.
    const focal = this.canvas.clientWidth / 2 / Math.tan((this.fov * Math.PI) / 360);
    this.yaw -= dx / focal;
    this.pitch = clampPitch(this.pitch + dy / focal);
    this.draw();
  }

  zoom(factor) {
    this.fov = Math.max(30, Math.min(110, this.fov * factor));
    this.draw();
  }

  get expanded() {
    return this.frame.classList.contains('expanded');
  }

  setExpanded(on) {
    this.frame.classList.toggle('expanded', on);
    document.body.classList.toggle('viewer-open', on);
    this.onexpand?.(on);
    this.draw();
  }

  toggleFullscreen() {
    if (document.fullscreenElement || document.webkitFullscreenElement) {
      (document.exitFullscreen || document.webkitExitFullscreen).call(document);
      return;
    }
    if (this.expanded) {
      this.setExpanded(false);
      return;
    }
    // Fill the browser window at once; true full screen takes over where the browser allows it
    // (phones and in-app browsers often don't).
    this.setExpanded(true);
    const request = this.frame.requestFullscreen || this.frame.webkitRequestFullscreen;
    request?.call(this.frame)?.catch?.(() => {});
  }

  bindInput() {
    const { canvas } = this;
    const spread = () => {
      const [a, b] = [...this.pointers.values()];
      return Math.hypot(a.x - b.x, a.y - b.y) || 1;
    };
    canvas.addEventListener('pointerdown', (event) => {
      canvas.setPointerCapture(event.pointerId);
      this.pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
      if (this.pointers.size === 2) this.pinch = { spread: spread(), fov: this.fov };
    });
    canvas.addEventListener('pointermove', (event) => {
      const point = this.pointers.get(event.pointerId);
      if (!point) return;
      if (this.pointers.size === 1) this.turn(event.clientX - point.x, event.clientY - point.y);
      point.x = event.clientX;
      point.y = event.clientY;
      if (this.pinch) {
        this.fov = this.pinch.fov;
        this.zoom(this.pinch.spread / spread());
      }
    });
    const release = (event) => {
      this.pointers.delete(event.pointerId);
      if (this.pointers.size < 2) this.pinch = null;
    };
    canvas.addEventListener('pointerup', release);
    canvas.addEventListener('pointercancel', release);
    canvas.addEventListener('wheel', (event) => {
      event.preventDefault();
      const pixels = event.deltaY * (event.deltaMode === 1 ? 33 : event.deltaMode === 2 ? 600 : 1);
      this.zoom(1.1 ** (pixels / 100));
    }, { passive: false });
    canvas.addEventListener('dblclick', () => this.toggleFullscreen());
    // Leaving true full screen (the browser handles Esc there) also leaves the window-filling view.
    let wasFullscreen = false;
    const fullscreenChanged = () => {
      const active = (document.fullscreenElement || document.webkitFullscreenElement) === this.frame;
      if (wasFullscreen && !active) this.setExpanded(false);
      wasFullscreen = active;
    };
    document.addEventListener('fullscreenchange', fullscreenChanged);
    document.addEventListener('webkitfullscreenchange', fullscreenChanged);
    document.addEventListener('keydown', (event) => {
      if (event.key === 'Escape' && this.expanded) this.setExpanded(false);
    });
    canvas.addEventListener('keydown', (event) => {
      const step = Math.PI / 36;
      const actions = {
        ArrowLeft: () => { this.yaw -= step; },
        ArrowRight: () => { this.yaw += step; },
        ArrowUp: () => { this.pitch = clampPitch(this.pitch + step); },
        ArrowDown: () => { this.pitch = clampPitch(this.pitch - step); },
        '+': () => this.zoom(0.9),
        '=': () => this.zoom(0.9),
        '-': () => this.zoom(1.1),
        0: () => this.reset(),
      };
      const action = actions[event.key];
      if (!action) return;
      event.preventDefault();
      action();
      this.draw();
    });
  }
}
