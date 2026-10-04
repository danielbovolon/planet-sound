/* Deep space behind the globe: a procedurally painted Milky Way, a dense
 * star field and a handful of bright stars that twinkle. Everything heavy is
 * painted once into an offscreen canvas; each frame only shifts it (slow
 * parallax as the globe turns) and redraws the twinkling stars.
 * Pauses when the globe fills the screen or the tab is hidden. */

const rand = (() => { let s = 1337; return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296); })();
const gauss = () => { let u = 0, v = 0; while (!u) u = rand(); while (!v) v = rand(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); };
const STAR_TINTS = ['255,255,255', '255,255,255', '220,232,255', '200,218,255', '255,244,226', '255,226,196', '255,206,170'];

function paint(W, H, dpr) {
  // A sky tile 2× wider than the screen so it can wrap while panning.
  const TW = Math.round(W * 2), TH = Math.round(H * 1.3);
  const c = document.createElement('canvas');
  c.width = Math.round(TW * dpr); c.height = Math.round(TH * dpr);
  const g = c.getContext('2d');
  g.scale(dpr, dpr);

  // deep space
  const bg = g.createLinearGradient(0, 0, 0, TH);
  bg.addColorStop(0, '#03050A'); bg.addColorStop(0.5, '#060912'); bg.addColorStop(1, '#03040A');
  g.fillStyle = bg; g.fillRect(0, 0, TW, TH);

  // the galactic band: a gently curving, tilted path across the tile
  // periodic in x, so the tile wraps without a seam
  const bandY = x => TH * 0.52 + Math.sin((x / TW) * Math.PI * 2) * TH * 0.16 + Math.sin((x / TW) * Math.PI * 4 + 1) * TH * 0.04;
  // draw something at x, and again on the other side if it crosses a tile edge
  const wrap = (x, r, fn) => { fn(x); if (x - r < 0) fn(x + TW); if (x + r > TW) fn(x - TW); };
  const bandW = Math.min(TH, TW * 0.6) * 0.17;
  // keep the same glow density on any screen size: scale counts by how many
  // band-sized blobs fit into the tile
  const k = (TW * TH) / (bandW * bandW);

  // diffuse glow, built from many soft blobs; warmer and brighter toward the core
  g.globalCompositeOperation = 'lighter';
  for (let i = 0, n = Math.round(15 * k); i < n; i++) {
    const x = rand() * TW;
    const core = Math.exp(-Math.pow((x / TW - 0.62) * 3.2, 2));          // galactic centre
    const y = bandY(x) + gauss() * bandW * (0.55 + 0.3 * rand());
    const r = bandW * (0.25 + rand() * 0.9);
    const a = 0.010 + 0.022 * core + rand() * 0.008;
    const warm = core > 0.5 && rand() < 0.6;
    const col = warm ? `255,226,190` : rand() < 0.5 ? `180,196,235` : `214,206,232`;
    wrap(x, r, X => {
      const rg = g.createRadialGradient(X, y, 0, X, y, r);
      rg.addColorStop(0, `rgba(${col},${a})`); rg.addColorStop(1, `rgba(${col},0)`);
      g.fillStyle = rg; g.fillRect(X - r, y - r, r * 2, r * 2);
    });
  }
  // faint coloured nebulae
  for (let i = 0, n = Math.max(6, Math.round(0.28 * k)); i < n; i++) {
    const x = rand() * TW, y = bandY(x) + gauss() * bandW * 1.1, r = bandW * (0.4 + rand());
    const col = rand() < 0.5 ? '120,90,160' : rand() < 0.5 ? '70,110,170' : '170,90,100';
    wrap(x, r, X => {
      const rg = g.createRadialGradient(X, y, 0, X, y, r);
      rg.addColorStop(0, `rgba(${col},0.05)`); rg.addColorStop(1, `rgba(${col},0)`);
      g.fillStyle = rg; g.fillRect(X - r, y - r, r * 2, r * 2);
    });
  }
  // dark dust lanes running along the band
  g.globalCompositeOperation = 'source-over';
  for (let i = 0, n = Math.round(5.5 * k); i < n; i++) {
    const x = rand() * TW;
    const y = bandY(x) + bandW * (0.08 * Math.sin(x / 90) + gauss() * 0.16);
    const r = bandW * (0.08 + rand() * 0.22);
    wrap(x, r, X => {
      const rg = g.createRadialGradient(X, y, 0, X, y, r);
      rg.addColorStop(0, 'rgba(3,4,9,0.22)'); rg.addColorStop(1, 'rgba(3,4,9,0)');
      g.fillStyle = rg; g.fillRect(X - r, y - r, r * 2, r * 2);
    });
  }

  // stars: everywhere, but far denser along the band
  g.globalCompositeOperation = 'lighter';
  const area = TW * TH;
  const n = Math.min(26000, Math.round(area / 55));
  for (let i = 0; i < n; i++) {
    const inBand = rand() < 0.62;
    const x = rand() * TW;
    const y = inBand ? bandY(x) + gauss() * bandW * 0.7 : rand() * TH;
    const m = Math.pow(rand(), 3.2);                 // most stars faint
    const r = 0.25 + m * 0.9;
    const a = 0.18 + m * 0.75;
    g.fillStyle = `rgba(${STAR_TINTS[(rand() * STAR_TINTS.length) | 0]},${a.toFixed(3)})`;
    g.beginPath(); g.arc(x, y, r, 0, Math.PI * 2); g.fill();
  }
  // a few bright stars with a soft halo
  for (let i = 0; i < 70; i++) {
    const x = rand() * TW, y = rand() * TH, r = 0.9 + rand() * 0.9;
    const tint = STAR_TINTS[(rand() * STAR_TINTS.length) | 0];
    wrap(x, r * 7, X => {
      const rg = g.createRadialGradient(X, y, 0, X, y, r * 7);
      rg.addColorStop(0, `rgba(${tint},0.35)`); rg.addColorStop(1, `rgba(${tint},0)`);
      g.fillStyle = rg; g.fillRect(X - r * 7, y - r * 7, r * 14, r * 14);
      g.fillStyle = `rgba(${tint},0.95)`; g.beginPath(); g.arc(X, y, r, 0, Math.PI * 2); g.fill();
    });
  }
  g.globalCompositeOperation = 'source-over';

  // twinkling stars, drawn live
  const twinkle = [];
  for (let i = 0; i < 160; i++) {
    const x = rand() * TW;
    const y = rand() < 0.5 ? bandY(x) + gauss() * bandW : rand() * TH;
    twinkle.push({ x, y, r: 0.6 + rand() * 1.1, tint: STAR_TINTS[(rand() * STAR_TINTS.length) | 0], f: 0.4 + rand() * 1.6, p: rand() * 6.28 });
  }
  return { tile: c, TW, TH, twinkle };
}

/* The real sky: ESO / S. Brunier's all-sky Milky Way panorama (CC BY 4.0).
 * It is equirectangular, a full 360° turn, so it wraps without a seam. */
const PHOTO = { large: 'assets/img/milkyway-6000.jpg', small: 'assets/img/milkyway-3000.jpg' };

function photoTile(img, W, H, dpr) {
  // Fit the panorama's height to 1.35× the view so the band crosses the
  // screen with room for the slow vertical parallax.
  const TH = Math.round(H * 1.35), TW = Math.round(TH * img.naturalWidth / img.naturalHeight);
  const c = document.createElement('canvas');
  c.width = Math.round(TW * dpr); c.height = Math.round(TH * dpr);
  const g = c.getContext('2d');
  g.imageSmoothingQuality = 'high';
  g.drawImage(img, 0, 0, c.width, c.height);
  // a touch darker overall, so pins, labels and the globe stay the brightest things
  g.fillStyle = 'rgba(2,3,8,0.22)'; g.fillRect(0, 0, c.width, c.height);
  return { tile: c, TW, TH, twinkle: [], photo: true };
}

export function createSpace(canvas, map) {
  const g = canvas.getContext('2d');
  const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
  let W = 0, H = 0, dpr = 1, sky = null, raf = 0, visible = true, offX = 0, offY = 0, tgtX = 0, tgtY = 0;
  let photo = null, drift = 0, last = 0;

  function build() { sky = photo ? photoTile(photo, W, H, dpr) : paint(W, H, dpr); }
  function resize() {
    dpr = Math.min(2, devicePixelRatio || 1);
    W = canvas.clientWidth || innerWidth; H = canvas.clientHeight || innerHeight;
    canvas.width = Math.round(W * dpr); canvas.height = Math.round(H * dpr);
    build();
    target(); offX = tgtX; offY = tgtY;
    draw(performance.now());
  }
  function loadPhoto() {
    const img = new Image();
    img.decoding = 'async';
    img.onload = () => { photo = img; build(); target(); draw(performance.now()); start(); };
    img.onerror = () => {};           // no photo in the repo: keep the painted sky
    img.src = (Math.max(screen.width, screen.height) * (devicePixelRatio || 1) > 2200) ? PHOTO.large : PHOTO.small;
  }
  function target() {
    // slow parallax: the sky turns a little as the globe turns
    const c = map.getCenter();
    tgtX = (-c.lng / 360) * sky.TW * 0.35 + drift;
    tgtY = (c.lat / 90) * H * 0.08;
  }
  function draw(t) {
    if (!sky) return;
    const { tile, TW, TH, twinkle } = sky;
    g.setTransform(1, 0, 0, 1, 0, 0);
    let x0 = ((offX % TW) + TW) % TW;
    const y0 = (TH - H) / 2 - offY;
    const sx = Math.round(x0 * dpr), sy = Math.round(Math.max(0, y0) * dpr);
    const sw = Math.min(tile.width - sx, Math.round(W * dpr)), sh = Math.min(tile.height - sy, Math.round(H * dpr));
    g.drawImage(tile, sx, sy, sw, sh, 0, 0, sw, sh);
    if (sw < W * dpr) g.drawImage(tile, 0, sy, Math.round(W * dpr) - sw, sh, sw, 0, Math.round(W * dpr) - sw, sh);
    if (!twinkle.length) return;
    // twinkling (painted sky only)
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    const time = t / 1000;
    for (const s of twinkle) {
      let x = s.x - x0; if (x < 0) x += TW;
      const y = s.y - Math.max(0, y0);
      if (x > W + 4 || y < -4 || y > H + 4) continue;
      const a = reduce ? 0.7 : 0.35 + 0.65 * Math.pow(0.5 + 0.5 * Math.sin(time * s.f + s.p), 2);
      g.fillStyle = `rgba(${s.tint},${a.toFixed(3)})`;
      g.beginPath(); g.arc(x, y, s.r, 0, Math.PI * 2); g.fill();
    }
  }
  function loop(t) {
    raf = 0;
    if (!visible || document.hidden) return;
    const dt = Math.min(0.1, (t - (last || t)) / 1000); last = t;
    // the sky turns very slowly on its own (about one screen width every ten minutes)
    if (!reduce) { drift -= dt * W / 600; tgtX -= dt * W / 600; }
    offX += (tgtX - offX) * 0.08; offY += (tgtY - offY) * 0.08;
    draw(t);
    if (!reduce) raf = requestAnimationFrame(loop);
  }
  function start() { if (!raf) { last = 0; raf = requestAnimationFrame(loop); } }
  function update() {
    // Past this zoom the globe fills the view and no sky is visible.
    const show = map.getZoom() < 4.2;
    if (show !== visible) { visible = show; canvas.style.visibility = show ? 'visible' : 'hidden'; }
    if (sky) target();
    if (visible) start();
  }

  map.on('move', update);
  addEventListener('resize', () => { clearTimeout(resize.t); resize.t = setTimeout(resize, 150); });
  document.addEventListener('visibilitychange', () => { if (!document.hidden) start(); });
  resize(); update(); start();
  return { resize };
}
