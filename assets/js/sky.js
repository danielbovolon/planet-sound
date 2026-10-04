/* A real sky around the globe.
 *
 * The ESO / S. Brunier all-sky panorama (galactic coordinates) is drawn as a
 * true 3D sky sphere by a small WebGL shader. The camera orbits the Earth with
 * the map: when you swipe, you move through space and the stars pass by
 * accordingly. The sky is placed as it really is: the galaxy is tilted to the
 * equator as in nature (galactic → J2000 equatorial), and it turns with
 * Greenwich sidereal time, so the stars behind any place on the globe are the
 * ones actually above it at this moment.
 *
 * Returns null where WebGL2 is unavailable, so the caller can fall back. */

const PHOTO = { large: 'assets/img/milkyway.jpg', small: 'assets/img/milkyway-small.jpg' };

const VS = `#version 300 es
in vec2 p; out vec2 uv;
void main(){ uv = p; gl_Position = vec4(p, 0.0, 1.0); }`;

const FS = `#version 300 es
precision highp float;
in vec2 uv; out vec4 o;
uniform sampler2D sky;
uniform vec3 fwd, up, right;      // camera basis, Earth-fixed frame
uniform float tanHalf, aspect, gmst, texW, pxH, exposure;
const float PI = 3.141592653589793;
// J2000 equatorial -> galactic
const mat3 EQ2GAL = mat3(
  -0.0548755604, 0.4941094279, -0.8676661490,
  -0.8734370902, -0.4448296300, -0.1980763734,
  -0.4838350155, 0.7469822445, 0.4559837762);
void main(){
  vec3 d = normalize(fwd + uv.x * tanHalf * aspect * right + uv.y * tanHalf * up);
  // Earth-fixed -> celestial: undo the Earth's rotation
  float c = cos(gmst), s = sin(gmst);
  vec3 eq = vec3(c * d.x - s * d.y, s * d.x + c * d.y, d.z);
  vec3 g = EQ2GAL * eq;
  float l = atan(g.y, g.x), b = asin(clamp(g.z, -1.0, 1.0));
  vec2 t = vec2(0.5 - l / (2.0 * PI), 0.5 - b / PI);
  // pick the mip level from how many texels one screen pixel covers
  float texPerRad = texW / (2.0 * PI);
  float radPerPx = 2.0 * tanHalf / pxH;
  float lod = max(0.0, log2(texPerRad * radPerPx));
  vec3 col = textureLod(sky, vec2(fract(t.x), t.y), lod).rgb;
  o = vec4(col * exposure, 1.0);
}`;

function gmstRad(date) {
  // Greenwich mean sidereal time (IAU 1982, good to well under a second)
  const jd = date.getTime() / 86400000 + 2440587.5;
  const T = (jd - 2451545.0) / 36525;
  let deg = 280.46061837 + 360.98564736629 * (jd - 2451545.0) + 0.000387933 * T * T - T * T * T / 38710000;
  deg = ((deg % 360) + 360) % 360;
  return deg * Math.PI / 180;
}

export function createSky(canvas, map, { onFail } = {}) {
  const gl = canvas.getContext('webgl2', { antialias: false, alpha: false, premultipliedAlpha: false, powerPreference: 'low-power' });
  if (!gl) return null;
  const sh = (type, src) => { const s = gl.createShader(type); gl.shaderSource(s, src); gl.compileShader(s); if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s)); return s; };
  let prog;
  try {
    prog = gl.createProgram();
    gl.attachShader(prog, sh(gl.VERTEX_SHADER, VS)); gl.attachShader(prog, sh(gl.FRAGMENT_SHADER, FS));
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(prog));
  } catch (e) { console.warn('sky shader', e); return null; }
  gl.useProgram(prog);
  const buf = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, buf);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
  const loc = gl.getAttribLocation(prog, 'p');
  gl.enableVertexAttribArray(loc); gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
  const U = n => gl.getUniformLocation(prog, n);
  const u = { fwd: U('fwd'), up: U('up'), right: U('right'), tanHalf: U('tanHalf'), aspect: U('aspect'), gmst: U('gmst'), texW: U('texW'), pxH: U('pxH'), exposure: U('exposure') };
  let texW = 0, ready = false, raf = 0, visible = true, fade = 0;

  const img = new Image();
  img.decoding = 'async';
  img.onload = () => {
    const tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGB, gl.RGB, gl.UNSIGNED_BYTE, img);
    gl.generateMipmap(gl.TEXTURE_2D);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.REPEAT);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    const an = gl.getExtension('EXT_texture_filter_anisotropic');
    if (an) gl.texParameterf(gl.TEXTURE_2D, an.TEXTURE_MAX_ANISOTROPY_EXT, Math.min(8, gl.getParameter(an.MAX_TEXTURE_MAX_ANISOTROPY_EXT)));
    texW = img.naturalWidth; ready = true;
    request();
  };
  img.onerror = () => { onFail && onFail(); };
  const big = Math.max(screen.width, screen.height) * (devicePixelRatio || 1) > 1800;
  img.src = big ? PHOTO.large : PHOTO.small;

  function resize() {
    const dpr = Math.min(2, devicePixelRatio || 1);
    canvas.width = Math.round((canvas.clientWidth || innerWidth) * dpr);
    canvas.height = Math.round((canvas.clientHeight || innerHeight) * dpr);
    gl.viewport(0, 0, canvas.width, canvas.height);
    request();
  }
  function draw() {
    raf = 0;
    if (!ready || !visible) return;
    const c = map.getCenter(), z = map.getZoom();
    const la = Math.max(-89, Math.min(89, c.lat)) * Math.PI / 180, lo = c.lng * Math.PI / 180;
    // camera sits above (lng, lat) and looks at the Earth's centre
    const P = [Math.cos(la) * Math.cos(lo), Math.cos(la) * Math.sin(lo), Math.sin(la)];
    const fwd = [-P[0], -P[1], -P[2]];
    // screen-up is local north; right completes the frame (east)
    const N = [0, 0, 1], k = N[2] * P[2];
    let up = [N[0] - k * P[0], N[1] - k * P[1], N[2] - k * P[2]];
    const ul = Math.hypot(...up); up = up.map(v => v / ul);
    const right = [fwd[1] * up[2] - fwd[2] * up[1], fwd[2] * up[0] - fwd[0] * up[2], fwd[0] * up[1] - fwd[1] * up[0]];
    // zooming in narrows the view a little, as if moving closer
    const fov = Math.max(34, 62 - z * 6) * Math.PI / 180;
    gl.uniform3fv(u.fwd, fwd); gl.uniform3fv(u.up, up); gl.uniform3fv(u.right, right);
    gl.uniform1f(u.tanHalf, Math.tan(fov / 2));
    gl.uniform1f(u.aspect, canvas.width / canvas.height);
    gl.uniform1f(u.gmst, gmstRad(new Date()));
    gl.uniform1f(u.texW, texW);
    gl.uniform1f(u.pxH, canvas.height);
    fade = Math.min(1, fade + 0.08);
    gl.uniform1f(u.exposure, 0.92 * fade);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    if (fade < 1) request();
  }
  function request() { if (!raf) raf = requestAnimationFrame(draw); }
  function update() {
    const show = map.getZoom() < 4.2;   // beyond this the globe fills the view
    if (show !== visible) { visible = show; canvas.style.visibility = show ? 'visible' : 'hidden'; }
    request();
  }
  map.on('move', update);
  addEventListener('resize', () => { clearTimeout(resize.t); resize.t = setTimeout(resize, 120); });
  // the real sky turns with the Earth: refresh once a minute
  setInterval(request, 60000);
  resize(); update();
  return { resize };
}
