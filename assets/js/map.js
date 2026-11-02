/* The map: a globe that flattens as you zoom in, drawn in the same ink and
 * board colours as the rest of the archive. Vector data from OpenFreeMap
 * (no key, no quota), optional Esri imagery. */
import * as maplibregl from '../../vendor/maplibre/maplibre-gl.mjs';
import { accession } from './ui.js';

/* Which map: the satellite globe (Paper, Night), or the Observatory: land as a field of light dots on a slate sphere, in red and white. */
const lookBase = () => { const l = document.documentElement.dataset.look; return l === 'observatory' || l === 'atlas' ? l : 'imagery'; };
/* Atlas: an antique printed map, flat. Parchment, sepia ink, oxblood. */
const INK = '#4A3420', OXBLOOD = '#9E2B1C', PARCH = '#EADBB4', SEA = '#C6D2BD';
/** A tile of paper grain: faint flecks and fibres (64 px, drawn at 2×). */
function paperImage() {
  const n = 128, d = new Uint8Array(n * n * 4); let seed = 7;
  const rnd = () => { seed = (Math.imul(seed, 1664525) + 1013904223) | 0; return (seed >>> 0) / 4294967296; };
  for (let i = 0; i < n * n; i++) { const v = rnd(); d[i * 4] = 92; d[i * 4 + 1] = 66; d[i * 4 + 2] = 36; d[i * 4 + 3] = v < 0.55 ? Math.round(v * 22) : v > 0.985 ? 70 : 0; }
  for (let f = 0; f < 18; f++) {                       // fibres
    let x = rnd() * n, y = rnd() * n; const a = rnd() * Math.PI, len = 6 + rnd() * 18;
    for (let t = 0; t < len; t++) { const xi = (((x + Math.cos(a) * t) | 0) + n) % n, yi = (((y + Math.sin(a) * t) | 0) + n) % n, i = (yi * n + xi) * 4; d[i + 3] = Math.max(d[i + 3], 34); }
  }
  return { width: n, height: n, data: d };
}
/** Fine engraved hatching for the sea (one line every 4 px). */
function hatchImage() {
  const n = 8, d = new Uint8Array(n * n * 4);
  for (let x = 0; x < n; x++) { const i = (0 * n + x) * 4; d[i] = 70; d[i + 1] = 98; d[i + 2] = 96; d[i + 3] = 70; }
  return { width: n, height: n, data: d };
}
const AMBER = '#F0503A', AMBER_HI = '#FF8A73', OBS_LAND = '#2C3845', OBS_SEA = '#18222D', OBS_TEXT = 'rgba(236,241,246,0.78)';   // (the Observatory red)
/** The dot pattern the Observatory's land is printed with (7 px pitch, drawn at 2×). */
function dotImage() {
  const n = 14, d = new Uint8Array(n * n * 4), c = (n - 1) / 2, r = 1.25;
  for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) {
    const dist = Math.hypot(x - c, y - c), a = Math.max(0, Math.min(1, r + 0.5 - dist)), i = (y * n + x) * 4;
    d[i] = 222; d[i + 1] = 232; d[i + 2] = 242; d[i + 3] = Math.round(a * 235);
  }
  return { width: n, height: n, data: d };
}
const hms = s => { s = Math.max(0, Math.round(s || 0)); return [Math.floor(s / 3600), Math.floor(s / 60) % 60, s % 60].map(v => String(v).padStart(2, '0')).join(':'); };

const OFM = 'https://tiles.openfreemap.org';
const ESRI = 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}';
const NAME = ['coalesce', ['get', 'name:en'], ['get', 'name:latin'], ['get', 'name']];

function css(name) { return getComputedStyle(document.documentElement).getPropertyValue(name).trim(); }
function mix(a, b, t) {
  const p = h => [1, 3, 5].map(i => parseInt(h.slice(i, i + 2), 16));
  const A = p(a), B = p(b);
  return '#' + A.map((v, i) => Math.round(v + (B[i] - v) * t).toString(16).padStart(2, '0')).join('');
}

function palette() {
  const paper = css('--paper') || '#EEEFEA', ink = css('--ink') || '#1E2B4D', board = css('--board') || '#C3CCCF';
  const graphite = css('--graphite') || '#5C6570', sheet = css('--sheet') || '#F7F7F4', signal = css('--signal') || '#CF3A2C';
  return {
    paper, ink, board, graphite, sheet, signal,
    water: board, waterLine: mix(board, ink, 0.18),
    wood: mix(paper, board, 0.32), ice: mix(paper, '#ffffff', 0.4),
    road: mix(paper, graphite, 0.28), roadMajor: mix(paper, graphite, 0.42), building: mix(paper, board, 0.55),
    border: mix(paper, ink, 0.45), label: mix(paper, ink, 0.78), labelSoft: mix(paper, ink, 0.55), waterLabel: mix(board, ink, 0.55),
  };
}

function soundLayers(c, base) {
  if (base === 'atlas') return [
    { id: 'ps-clusters', type: 'circle', source: 'sounds', filter: ['has', 'point_count'],
      paint: { 'circle-color': '#F3E7C8', 'circle-stroke-color': OXBLOOD, 'circle-stroke-width': 1.4,
        'circle-radius': ['interpolate', ['linear'], ['get', 'point_count'], 2, 11, 20, 15, 200, 21] } },
    { id: 'ps-count', type: 'symbol', source: 'sounds', filter: ['has', 'point_count'],
      layout: { 'text-field': ['get', 'point_count_abbreviated'], 'text-font': ['Noto Sans Bold'], 'text-size': 11, 'text-allow-overlap': true, 'text-ignore-placement': true },
      paint: { 'text-color': OXBLOOD } },
    { id: 'ps-halo', type: 'circle', source: 'sounds', filter: ['!', ['has', 'point_count']],
      paint: { 'circle-color': 'rgba(0,0,0,0)', 'circle-stroke-color': OXBLOOD, 'circle-stroke-width': 0.8, 'circle-stroke-opacity': ['case', ['boolean', ['feature-state', 'selected'], false], 0, 0.55],
        'circle-radius': ['interpolate', ['linear'], ['zoom'], 1, 7, 8, 9, 14, 11] } },
    { id: 'ps-points', type: 'circle', source: 'sounds', filter: ['!', ['has', 'point_count']],
      paint: {
        'circle-color': ['case', ['==', ['get', 'private'], 1], '#F3E7C8', OXBLOOD], 'circle-stroke-color': ['case', ['==', ['get', 'private'], 1], OXBLOOD, '#F3E7C8'],
        'circle-stroke-width': 1.2, 'circle-radius': ['interpolate', ['linear'], ['zoom'], 1, 3.4, 8, 4.2, 14, 5.2],
      } },
  ];
  if (base === 'observatory') return [
    { id: 'ps-clusters', type: 'circle', source: 'sounds', filter: ['has', 'point_count'],
      paint: { 'circle-color': 'rgba(240,80,58,0.16)', 'circle-stroke-color': AMBER, 'circle-stroke-width': 1, 'circle-stroke-opacity': 0.8,
        'circle-radius': ['interpolate', ['linear'], ['get', 'point_count'], 2, 11, 20, 16, 200, 22] } },
    { id: 'ps-count', type: 'symbol', source: 'sounds', filter: ['has', 'point_count'],
      layout: { 'text-field': ['get', 'point_count_abbreviated'], 'text-font': ['Noto Sans Regular'], 'text-size': 10.5, 'text-allow-overlap': true, 'text-ignore-placement': true },
      paint: { 'text-color': AMBER_HI } },
    { id: 'ps-glow', type: 'circle', source: 'sounds', filter: ['!', ['has', 'point_count']],
      paint: { 'circle-color': AMBER, 'circle-blur': 1, 'circle-opacity': ['case', ['boolean', ['feature-state', 'selected'], false], 0, 0.5],
        'circle-radius': ['interpolate', ['linear'], ['zoom'], 1, 9, 8, 12, 14, 15] } },
    { id: 'ps-halo', type: 'circle', source: 'sounds', filter: ['!', ['has', 'point_count']], paint: { 'circle-opacity': 0, 'circle-radius': 0 } },
    { id: 'ps-points', type: 'circle', source: 'sounds', filter: ['!', ['has', 'point_count']],
      paint: {
        'circle-color': ['case', ['boolean', ['feature-state', 'selected'], false], '#FFFFFF', ['==', ['get', 'private'], 1], OBS_LAND, AMBER_HI],
        'circle-stroke-color': AMBER, 'circle-stroke-width': ['case', ['==', ['get', 'private'], 1], 1.2, 0],
        'circle-radius': ['interpolate', ['linear'], ['zoom'], 1, 3, 8, 3.8, 14, 4.8],
      } },
  ];
  const imagery = base === 'imagery';
  const fill = imagery ? '#F7F7F4' : c.ink, ring = imagery ? '#1E2B4D' : c.paper;
  return [
    { id: 'ps-clusters', type: 'circle', source: 'sounds', filter: ['has', 'point_count'],
      paint: {
        'circle-color': fill, 'circle-stroke-color': ring, 'circle-stroke-width': 2,
        'circle-radius': ['interpolate', ['linear'], ['get', 'point_count'], 2, 12, 20, 17, 200, 24],
      } },
    { id: 'ps-count', type: 'symbol', source: 'sounds', filter: ['has', 'point_count'],
      layout: { 'text-field': ['get', 'point_count_abbreviated'], 'text-font': ['Noto Sans Bold'], 'text-size': 11.5, 'text-allow-overlap': true, 'text-ignore-placement': true },
      paint: { 'text-color': ring } },
    { id: 'ps-halo', type: 'circle', source: 'sounds', filter: ['!', ['has', 'point_count']],
      paint: {
        'circle-color': c.signal, 'circle-opacity': ['case', ['boolean', ['feature-state', 'selected'], false], 0.22, 0],
        'circle-radius': ['case', ['boolean', ['feature-state', 'selected'], false], 18, 0],
      } },
    { id: 'ps-points', type: 'circle', source: 'sounds', filter: ['!', ['has', 'point_count']],
      paint: {
        'circle-color': ['case', ['boolean', ['feature-state', 'selected'], false], c.signal, ['==', ['get', 'private'], 1], ring, fill],
        'circle-stroke-color': ['case', ['boolean', ['feature-state', 'selected'], false], ring, ['==', ['get', 'private'], 1], fill, ring],
        'circle-stroke-width': ['case', ['==', ['get', 'private'], 1], 2, 1.6],
        'circle-radius': ['interpolate', ['linear'], ['zoom'], 1, 4.5, 8, 6, 14, 7.5],
      } },
  ];
}

function buildStyle(base) {
  const c = palette();
  const sources = {
    ofm: { type: 'vector', url: `${OFM}/planet`, attribution: '<a href="https://openfreemap.org" target="_blank" rel="noopener">OpenFreeMap</a> © <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a>' },
    sounds: { type: 'geojson', data: { type: 'FeatureCollection', features: [] }, cluster: true, clusterRadius: 38, clusterMaxZoom: 15, promoteId: 'id' },
  };
  if (base === 'observatory') return observatoryStyle(sources, c);
  if (base === 'atlas') return atlasStyle(sources);
  const layers = [{ id: 'bg', type: 'background', paint: { 'background-color': c.paper } }];
  const labelHalo = base === 'imagery' ? 'rgba(10,16,24,.75)' : c.paper;
  const labelColor = base === 'imagery' ? '#F2F3EF' : c.label;
  if (base === 'imagery') {
    sources.esri = { type: 'raster', tiles: [ESRI], tileSize: 256, maxzoom: 19, attribution: 'Imagery © Esri, Maxar, Earthstar Geographics' };
    layers.push({ id: 'esri', type: 'raster', source: 'esri', paint: { 'raster-fade-duration': 150 } });
    layers.push({ id: 'b-country', type: 'line', source: 'ofm', 'source-layer': 'boundary', filter: ['all', ['==', ['get', 'admin_level'], 2], ['!=', ['get', 'maritime'], 1]],
      paint: { 'line-color': 'rgba(255,255,255,.45)', 'line-width': ['interpolate', ['linear'], ['zoom'], 1, 0.4, 8, 1.2] } });
  } else {
    layers.push(
      { id: 'water', type: 'fill', source: 'ofm', 'source-layer': 'water', paint: { 'fill-color': c.water } },
      { id: 'ice', type: 'fill', source: 'ofm', 'source-layer': 'landcover', filter: ['==', ['get', 'class'], 'ice'], paint: { 'fill-color': c.ice } },
      { id: 'wood', type: 'fill', source: 'ofm', 'source-layer': 'landcover', minzoom: 4, filter: ['match', ['get', 'class'], ['wood', 'forest'], true, false],
        paint: { 'fill-color': c.wood, 'fill-opacity': ['interpolate', ['linear'], ['zoom'], 4, 0, 7, 0.7] } },
      { id: 'park', type: 'fill', source: 'ofm', 'source-layer': 'park', minzoom: 8, paint: { 'fill-color': c.wood, 'fill-opacity': 0.6 } },
      { id: 'waterway', type: 'line', source: 'ofm', 'source-layer': 'waterway', minzoom: 6,
        paint: { 'line-color': c.waterLine, 'line-width': ['interpolate', ['linear'], ['zoom'], 6, 0.4, 12, 1.4, 16, 3] } },
      { id: 'building', type: 'fill', source: 'ofm', 'source-layer': 'building', minzoom: 14, paint: { 'fill-color': c.building, 'fill-opacity': 0.8 } },
      { id: 'road-minor', type: 'line', source: 'ofm', 'source-layer': 'transportation', minzoom: 11,
        filter: ['match', ['get', 'class'], ['minor', 'service', 'tertiary', 'track', 'path'], true, false],
        layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: { 'line-color': c.road, 'line-width': ['interpolate', ['linear'], ['zoom'], 11, 0.4, 16, 2.6] } },
      { id: 'road-major', type: 'line', source: 'ofm', 'source-layer': 'transportation', minzoom: 5,
        filter: ['match', ['get', 'class'], ['motorway', 'trunk', 'primary', 'secondary'], true, false],
        layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: { 'line-color': c.roadMajor, 'line-width': ['interpolate', ['linear'], ['zoom'], 5, 0.4, 10, 1.1, 16, 4] } },
      { id: 'rail', type: 'line', source: 'ofm', 'source-layer': 'transportation', minzoom: 10, filter: ['==', ['get', 'class'], 'rail'],
        paint: { 'line-color': c.roadMajor, 'line-width': 0.8, 'line-dasharray': [3, 2] } },
      { id: 'b-region', type: 'line', source: 'ofm', 'source-layer': 'boundary', minzoom: 5,
        filter: ['all', ['==', ['get', 'admin_level'], 4], ['!=', ['get', 'maritime'], 1]],
        paint: { 'line-color': c.border, 'line-opacity': 0.35, 'line-width': 0.6, 'line-dasharray': [2, 2] } },
      { id: 'b-country', type: 'line', source: 'ofm', 'source-layer': 'boundary',
        filter: ['all', ['==', ['get', 'admin_level'], 2], ['!=', ['get', 'maritime'], 1]],
        paint: { 'line-color': c.border, 'line-opacity': 0.7, 'line-width': ['interpolate', ['linear'], ['zoom'], 1, 0.4, 6, 0.9, 12, 1.4] } },
      { id: 'water-name', type: 'symbol', source: 'ofm', 'source-layer': 'water_name', minzoom: 2,
        layout: { 'text-field': NAME, 'text-font': ['Noto Sans Italic'], 'text-size': ['interpolate', ['linear'], ['zoom'], 2, 11, 8, 13], 'text-max-width': 6, 'text-letter-spacing': 0.06 },
        paint: { 'text-color': c.waterLabel, 'text-halo-color': c.water, 'text-halo-width': 1 } },
    );
  }
  layers.push(
    { id: 'place-small', type: 'symbol', source: 'ofm', 'source-layer': 'place', minzoom: 9,
      filter: ['match', ['get', 'class'], ['village', 'hamlet', 'suburb', 'neighbourhood'], true, false],
      layout: { 'text-field': NAME, 'text-font': ['Noto Sans Regular'], 'text-size': 11.5, 'text-max-width': 8 },
      paint: { 'text-color': base === 'imagery' ? labelColor : c.labelSoft, 'text-halo-color': labelHalo, 'text-halo-width': 1.4 } },
    { id: 'place-town', type: 'symbol', source: 'ofm', 'source-layer': 'place', minzoom: 5,
      filter: ['match', ['get', 'class'], ['city', 'town'], true, false],
      layout: { 'text-field': NAME, 'text-font': ['Noto Sans Regular'], 'text-max-width': 8,
        'text-size': ['interpolate', ['linear'], ['zoom'], 5, ['case', ['==', ['get', 'class'], 'city'], 12, 10.5], 12, ['case', ['==', ['get', 'class'], 'city'], 17, 14]] },
      paint: { 'text-color': labelColor, 'text-halo-color': labelHalo, 'text-halo-width': 1.5 } },
    { id: 'place-country', type: 'symbol', source: 'ofm', 'source-layer': 'place', minzoom: 1.5, maxzoom: 8,
      filter: ['==', ['get', 'class'], 'country'],
      layout: { 'text-field': NAME, 'text-font': ['Noto Sans Regular'], 'text-transform': 'none', 'text-max-width': 7,
        'text-size': ['interpolate', ['linear'], ['zoom'], 2, 10.5, 6, 14], 'text-letter-spacing': 0.04 },
      paint: { 'text-color': base === 'imagery' ? labelColor : c.labelSoft, 'text-halo-color': labelHalo, 'text-halo-width': 1.4 } },
    ...soundLayers(c, base),
  );
  return {
    version: 8,
    glyphs: `${OFM}/fonts/{fontstack}/{range}.pbf`,
    projection: { type: 'globe' },
    sky: {
      'sky-color': '#04060B', 'horizon-color': '#8FB4E8', 'fog-color': '#04060B',
      'atmosphere-blend': ['interpolate', ['linear'], ['zoom'], 0, 1, 4, 0.6, 7, 0],
    },
    sources, layers,
  };
}

/** Atlas: a flat (Mercator) antique map. Parchment land with paper grain, a pale engraved sea, sepia coasts with a
 *  second faint waterline, a graticule with the equator and the tropics, dotted borders, italic names. */
function atlasStyle(sources) {
  const it = { 'text-font': ['Noto Sans Italic'], 'text-letter-spacing': 0.12, 'text-max-width': 8 };
  return {
    version: 8,
    glyphs: `${OFM}/fonts/{fontstack}/{range}.pbf`,
    projection: { type: 'mercator' },
    sources: { ...sources, frame: { type: 'geojson', data: { type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: [[-180, -85.05], [-180, 85.05], [180, 85.05], [180, -85.05], [-180, -85.05]] } } } },
    layers: [
      { id: 'bg', type: 'background', paint: { 'background-color': PARCH } },
      { id: 'bg-grain', type: 'background', paint: { 'background-pattern': 'ps-paper' } },
      { id: 'water', type: 'fill', source: 'ofm', 'source-layer': 'water', paint: { 'fill-color': SEA } },
      { id: 'sea-hatch', type: 'fill', source: 'ofm', 'source-layer': 'water', paint: { 'fill-pattern': 'ps-hatch', 'fill-opacity': ['interpolate', ['linear'], ['zoom'], 2, 0.38, 9, 0.18] } },
      { id: 'waterline', type: 'line', source: 'ofm', 'source-layer': 'water', filter: ['==', ['get', 'class'], 'ocean'],
        paint: { 'line-color': 'rgba(74,52,32,0.28)', 'line-width': 0.7, 'line-offset': ['interpolate', ['linear'], ['zoom'], 1, 2.2, 8, 3.5] } },
      { id: 'coast', type: 'line', source: 'ofm', 'source-layer': 'water', paint: { 'line-color': INK, 'line-width': ['interpolate', ['linear'], ['zoom'], 1, 0.8, 8, 1.3] } },
      { id: 'waterway', type: 'line', source: 'ofm', 'source-layer': 'waterway', minzoom: 5, paint: { 'line-color': 'rgba(70,98,110,0.7)', 'line-width': ['interpolate', ['linear'], ['zoom'], 5, 0.4, 12, 1.4] } },
      { id: 'wood', type: 'fill', source: 'ofm', 'source-layer': 'landcover', minzoom: 5, filter: ['match', ['get', 'class'], ['wood', 'forest'], true, false],
        paint: { 'fill-color': 'rgba(120,128,70,0.16)' } },
      { id: 'building', type: 'fill', source: 'ofm', 'source-layer': 'building', minzoom: 14, paint: { 'fill-color': 'rgba(74,52,32,0.12)', 'fill-outline-color': 'rgba(74,52,32,0.35)' } },
      { id: 'road-minor', type: 'line', source: 'ofm', 'source-layer': 'transportation', minzoom: 12, filter: ['match', ['get', 'class'], ['minor', 'service', 'tertiary', 'track', 'path'], true, false],
        paint: { 'line-color': 'rgba(74,52,32,0.25)', 'line-width': ['interpolate', ['linear'], ['zoom'], 12, 0.4, 16, 1.8] } },
      { id: 'road-major', type: 'line', source: 'ofm', 'source-layer': 'transportation', minzoom: 6, filter: ['match', ['get', 'class'], ['motorway', 'trunk', 'primary', 'secondary'], true, false],
        paint: { 'line-color': 'rgba(158,43,28,0.45)', 'line-width': ['interpolate', ['linear'], ['zoom'], 6, 0.4, 12, 1.2, 16, 2.8] } },
      { id: 'b-region', type: 'line', source: 'ofm', 'source-layer': 'boundary', minzoom: 5, filter: ['all', ['==', ['get', 'admin_level'], 4], ['!=', ['get', 'maritime'], 1]],
        paint: { 'line-color': 'rgba(74,52,32,0.3)', 'line-width': 0.6, 'line-dasharray': [1, 2] } },
      { id: 'b-country', type: 'line', source: 'ofm', 'source-layer': 'boundary', filter: ['all', ['==', ['get', 'admin_level'], 2], ['!=', ['get', 'maritime'], 1]],
        paint: { 'line-color': 'rgba(158,43,28,0.55)', 'line-width': ['interpolate', ['linear'], ['zoom'], 1, 0.6, 8, 1.2], 'line-dasharray': [1, 1.6] } },
      { id: 'water-name', type: 'symbol', source: 'ofm', 'source-layer': 'water_name', minzoom: 1.5,
        layout: { ...it, 'text-field': NAME, 'text-size': ['interpolate', ['linear'], ['zoom'], 2, 11, 8, 14], 'text-letter-spacing': 0.3 },
        paint: { 'text-color': 'rgba(52,80,86,0.85)', 'text-halo-color': SEA, 'text-halo-width': 1 } },
      { id: 'place-small', type: 'symbol', source: 'ofm', 'source-layer': 'place', minzoom: 9, filter: ['match', ['get', 'class'], ['village', 'hamlet', 'suburb', 'neighbourhood'], true, false],
        layout: { ...it, 'text-field': NAME, 'text-size': 11.5 }, paint: { 'text-color': 'rgba(74,52,32,0.8)', 'text-halo-color': PARCH, 'text-halo-width': 1.2 } },
      { id: 'place-town', type: 'symbol', source: 'ofm', 'source-layer': 'place', minzoom: 4, filter: ['match', ['get', 'class'], ['city', 'town'], true, false],
        layout: { ...it, 'text-font': ['Noto Sans Regular'], 'text-field': NAME, 'text-size': ['interpolate', ['linear'], ['zoom'], 4, 10.5, 12, 15] },
        paint: { 'text-color': INK, 'text-halo-color': PARCH, 'text-halo-width': 1.4 } },
      { id: 'place-country', type: 'symbol', source: 'ofm', 'source-layer': 'place', minzoom: 1.5, maxzoom: 7, filter: ['==', ['get', 'class'], 'country'],
        layout: { ...it, 'text-field': NAME, 'text-transform': 'uppercase', 'text-letter-spacing': 0.35, 'text-size': ['interpolate', ['linear'], ['zoom'], 2, 10, 6, 14] },
        paint: { 'text-color': 'rgba(158,43,28,0.75)', 'text-halo-color': PARCH, 'text-halo-width': 1.2 } },
      // the neatline: a double ink rule around the edge of the world, as on a printed map
      { id: 'frame', type: 'line', source: 'frame', paint: { 'line-color': '#4A3420', 'line-width': 1.4 } },
      { id: 'frame-2', type: 'line', source: 'frame', paint: { 'line-color': 'rgba(74,52,32,0.55)', 'line-width': 0.7, 'line-offset': -5 } },
      ...soundLayers({}, 'atlas'),
    ],
  };
}
/** Lines of latitude and longitude every 15°; the equator and the prime meridian are marked in red. */
function graticule() {
  const f = [];
  for (let lng = -180; lng < 180; lng += 15) { const c = []; for (let lat = -80; lat <= 80; lat += 4) c.push([lng, lat]); f.push({ type: 'Feature', properties: { main: false }, geometry: { type: 'LineString', coordinates: c } }); }
  // (each parallel in two halves: a line across the whole width is cut short by the map's tiling)
  const parallel = (lat, props) => { for (const [a, b] of [[-180, 0], [0, 180]]) { const c = []; for (let lng = a; lng <= b; lng += 3) c.push([lng, lat]); f.push({ type: 'Feature', properties: props, geometry: { type: 'LineString', coordinates: c } }); } };
  for (let lat = -75; lat <= 75; lat += 15) parallel(lat, { main: false });
  for (const lat of [23.44, -23.44, 66.56, -66.56]) parallel(lat, { main: false, tropic: true });
  return { type: 'FeatureCollection', features: f };
}
/** The Observatory: land is a field of dots, the sea is slate, a grid of latitude and longitude, the recordings glow red. */
function observatoryStyle(sources, c) {
  const txt = (extra = {}) => ({ 'text-color': OBS_TEXT, 'text-halo-color': OBS_SEA, 'text-halo-width': 1.2, ...extra });
  const lay = { 'text-font': ['Noto Sans Regular'], 'text-transform': 'uppercase', 'text-letter-spacing': 0.22, 'text-max-width': 8 };
  return {
    version: 8,
    glyphs: `${OFM}/fonts/{fontstack}/{range}.pbf`,
    projection: { type: 'globe' },
    sky: { 'sky-color': '#0B1018', 'horizon-color': '#BFD8F5', 'fog-color': '#0B1018',
      'atmosphere-blend': ['interpolate', ['linear'], ['zoom'], 0, 0.95, 4, 0.55, 7, 0] },
    sources: { ...sources, grid: { type: 'geojson', data: graticule() } },
    layers: [
      { id: 'bg', type: 'background', paint: { 'background-color': OBS_LAND } },
      { id: 'bg-dots', type: 'background', paint: { 'background-pattern': 'ps-dot', 'background-opacity': ['interpolate', ['linear'], ['zoom'], 6, 1, 11, 0.5] } },
      { id: 'water', type: 'fill', source: 'ofm', 'source-layer': 'water', paint: { 'fill-color': OBS_SEA } },
      { id: 'coast', type: 'line', source: 'ofm', 'source-layer': 'water', filter: ['==', ['get', 'class'], 'ocean'],
        paint: { 'line-color': 'rgba(214,228,244,0.42)', 'line-width': ['interpolate', ['linear'], ['zoom'], 1, 0.6, 8, 1.1] } },
      { id: 'waterway', type: 'line', source: 'ofm', 'source-layer': 'waterway', minzoom: 8, paint: { 'line-color': 'rgba(150,190,230,0.35)', 'line-width': 0.9 } },
      { id: 'building', type: 'fill', source: 'ofm', 'source-layer': 'building', minzoom: 14, paint: { 'fill-color': 'rgba(236,241,246,0.07)', 'fill-outline-color': 'rgba(236,241,246,0.16)' } },
      { id: 'road-minor', type: 'line', source: 'ofm', 'source-layer': 'transportation', minzoom: 12,
        filter: ['match', ['get', 'class'], ['minor', 'service', 'tertiary', 'track', 'path'], true, false],
        paint: { 'line-color': 'rgba(236,241,246,0.16)', 'line-width': ['interpolate', ['linear'], ['zoom'], 12, 0.4, 16, 1.6] } },
      { id: 'road-major', type: 'line', source: 'ofm', 'source-layer': 'transportation', minzoom: 6,
        filter: ['match', ['get', 'class'], ['motorway', 'trunk', 'primary', 'secondary'], true, false],
        paint: { 'line-color': 'rgba(240,80,58,0.45)', 'line-width': ['interpolate', ['linear'], ['zoom'], 6, 0.3, 12, 1, 16, 2.4] } },
      { id: 'grid', type: 'line', source: 'grid', maxzoom: 7, filter: ['!', ['has', 'tropic']], paint: { 'line-color': ['case', ['get', 'main'], 'rgba(240,80,58,0.55)', 'rgba(214,228,244,0.14)'],
        'line-width': ['case', ['get', 'main'], 0.9, 0.6] } },
      { id: 'b-country', type: 'line', source: 'ofm', 'source-layer': 'boundary', filter: ['all', ['==', ['get', 'admin_level'], 2], ['!=', ['get', 'maritime'], 1]],
        paint: { 'line-color': 'rgba(236,241,246,0.30)', 'line-width': 0.7, 'line-dasharray': [2, 3] } },
      { id: 'place-town', type: 'symbol', source: 'ofm', 'source-layer': 'place', minzoom: 5, filter: ['match', ['get', 'class'], ['city', 'town'], true, false],
        layout: { ...lay, 'text-field': NAME, 'text-size': ['interpolate', ['linear'], ['zoom'], 5, 9.5, 12, 12] }, paint: txt() },
      { id: 'place-country', type: 'symbol', source: 'ofm', 'source-layer': 'place', minzoom: 2.5, maxzoom: 6, filter: ['==', ['get', 'class'], 'country'],
        layout: { ...lay, 'text-field': NAME, 'text-size': 10, 'text-letter-spacing': 0.32 }, paint: txt({ 'text-color': 'rgba(236,241,246,0.6)' }) },
      ...soundLayers(c, 'observatory'),
    ],
  };
}

export function createMap(el, { onSelect, onSpot, onMoveEnd, start }) {
  let base = lookBase(), selMarker = null, data = { type: 'FeatureCollection', features: [] }, selected = null, picking = null;
  // The flat map. Zoomed out as far as it goes, the whole world fits on screen from pole to pole and side to side
  // (below the bar), with parchment around it; zoomed in, it can be dragged no further than its edges.
  // A phone opens with the world filling the height (swipe sideways); a wider screen opens with all of it in view.
  const BAR = 60;
  const atlasFit = () => Math.log2(Math.max(128, Math.min(el.clientWidth - 16, el.clientHeight - BAR - 16)) / 512);
  const atlasZoom = () => el.clientWidth < el.clientHeight ? Math.log2(Math.max(256, el.clientHeight) / 512) : atlasFit();
  const atlasConstrain = (lngLat, zoom) => {
    const z = Math.min(22, Math.max(atlasFit(), zoom)), ws = 512 * 2 ** z, w = el.clientWidth, h = el.clientHeight;
    let x = (lngLat.lng + 180) / 360 * ws;
    const lat = Math.max(-85.05, Math.min(85.05, lngLat.lat)) * Math.PI / 180;
    let y = (1 - Math.log(Math.tan(Math.PI / 4 + lat / 2)) / Math.PI) / 2 * ws;
    x = ws <= w ? ws / 2 : Math.min(ws - w / 2, Math.max(w / 2, x));
    y = ws <= h - BAR ? ws / 2 - BAR / 2 : Math.min(ws - h / 2, Math.max(h / 2 - BAR, y));
    const lng = x / ws * 360 - 180, la = Math.atan(Math.sinh(Math.PI * (1 - 2 * y / ws))) * 180 / Math.PI;
    return { center: new maplibregl.LngLat(lng, la), zoom: z };
  };
  const map = new maplibregl.Map({
    container: el,
    style: buildStyle(base),
    center: start ? [start.lng, start.lat] : base === 'atlas' ? [10, 15] : [11.35, 30],
    zoom: start ? start.zoom : base === 'atlas' ? atlasZoom() : (innerWidth < 700 ? 1.1 : 2.15),
    attributionControl: { compact: true },
    maxPitch: 0, dragRotate: false, pitchWithRotate: false, touchPitch: false,
    renderWorldCopies: false,
    transformConstrain: base === 'atlas' ? (c, z) => atlasConstrain(c, z) : null,
  });
  map.touchZoomRotate.disableRotation();
  const addDot = () => { try { if (!map.hasImage('ps-dot')) map.addImage('ps-dot', dotImage(), { pixelRatio: 2 }); } catch {} };
  const addAtlas = () => { try { if (!map.hasImage('ps-paper')) map.addImage('ps-paper', paperImage(), { pixelRatio: 2 }); if (!map.hasImage('ps-hatch')) map.addImage('ps-hatch', hatchImage(), { pixelRatio: 2 }); } catch {} };
  map.on('styleimagemissing', e => { if (e.id === 'ps-dot') addDot(); if (e.id === 'ps-paper' || e.id === 'ps-hatch') addAtlas(); });
  map.on('style.load', addAtlas); map.on('styledata', addAtlas);
  map.on('style.load', addDot); map.on('styledata', addDot);
  /* The selected recording: a few rings that slowly widen, and in the Observatory a leader line with its number,
     place and length. A DOM marker, so it follows the globe and hides behind it. */
  function selElement(f) {
    const p = f.properties, e = document.createElement('div');
    e.className = 'ps-sel';
    e.innerHTML = `<i class="r"></i><i class="r"></i><i class="r"></i><i class="c"></i>
      <div class="ps-tag" aria-hidden="true"><svg viewBox="0 0 150 64" preserveAspectRatio="none"><polyline points="0,64 40,22 150,22" pathLength="1"/></svg>
      <span class="t1"></span><span class="t2"></span></div>`;
    e.querySelector('.t1').textContent = accession(p.no);
    e.querySelector('.t2').textContent = `${String(p.place || '').split(',')[0].trim().toUpperCase() || 'UNNAMED PLACE'} · ${hms(p.dur)}`;
    return e;
  }
  function placeTag() {
    if (!selMarker) return;
    const pt = map.project(selMarker.getLngLat()), w = el.clientWidth;
    selMarker.getElement().classList.toggle('flip', pt.x > w - 230);
  }
  map.on('move', placeTag);
  map.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'bottom-right');
  const hoverPopup = new maplibregl.Popup({ closeButton: false, closeOnClick: false, offset: 12, className: 'ps-pop' });

  function applyData() {
    const s = map.getSource('sounds');
    if (s) s.setData(data);
    if (selected) map.setFeatureState({ source: 'sounds', id: selected }, { selected: true });
  }
  map.on('load', () => {
    applyData();
    if (innerWidth < 700) { const a = el.querySelector('.maplibregl-ctrl-attrib'); if (a) a.classList.remove('maplibregl-compact-show'); }
  });
  map.on('styledata', () => { if (map.getSource('sounds')) applyData(); });

  map.on('click', 'ps-points', e => {
    if (picking) return;
    const f = e.features && e.features[0]; if (f) onSelect && onSelect(f.properties.id);
  });
  map.on('click', 'ps-clusters', async e => {
    if (picking) return;
    const f = e.features[0], src = map.getSource('sounds');
    const id = f.properties.cluster_id, n = f.properties.point_count;
    if (map.getZoom() >= 13) {
      const leaves = await src.getClusterLeaves(id, Math.min(n, 200), 0);
      onSpot && onSpot(leaves.map(l => l.properties.id));
      return;
    }
    const z = await src.getClusterExpansionZoom(id);
    map.easeTo({ center: f.geometry.coordinates, zoom: Math.min(z + 0.3, 16), duration: 600 });
  });
  for (const l of ['ps-points', 'ps-clusters']) {
    map.on('mouseenter', l, () => { if (!picking) map.getCanvas().style.cursor = 'pointer'; });
    map.on('mouseleave', l, () => { map.getCanvas().style.cursor = ''; hoverPopup.remove(); });
  }
  map.on('mousemove', 'ps-points', e => {
    if (picking || matchMedia('(pointer: coarse)').matches) return;
    const f = e.features[0];
    const p = f.properties;
    const div = document.createElement('div');
    div.textContent = p.title; const sm = document.createElement('small'); sm.textContent = p.place || ''; div.append(sm);
    hoverPopup.setLngLat(f.geometry.coordinates).setDOMContent(div).addTo(map);
  });
  map.on('moveend', () => { onMoveEnd && onMoveEnd(); if (picking) picking.update(); });
  map.on('move', () => { if (picking) picking.update(); });

  return {
    map,
    setData(sounds) {
      data = {
        type: 'FeatureCollection',
        features: sounds.filter(s => typeof s.lat === 'number' && typeof s.lng === 'number').map(s => ({
          type: 'Feature', id: s.id, geometry: { type: 'Point', coordinates: [s.lng, s.lat] },
          properties: { id: s.id, title: s.title, place: s.place || '', private: s.visibility === 'private' ? 1 : 0, no: s.no,
            dur: s.trim && s.trim.end > s.trim.start ? s.trim.end - s.trim.start : s.duration || 0 },
        })),
      };
      if (map.getSource('sounds')) applyData();
      else map.once('styledata', applyData);
    },
    select(id) {
      if (selected && map.getSource('sounds')) map.setFeatureState({ source: 'sounds', id: selected }, { selected: false });
      selected = id || null;
      if (selected && map.getSource('sounds')) map.setFeatureState({ source: 'sounds', id: selected }, { selected: true });
      if (selMarker) { selMarker.remove(); selMarker = null; }
      const f = selected && data.features.find(x => x.id === selected);
      if (f) { selMarker = new maplibregl.Marker({ element: selElement(f), anchor: 'center' }).setLngLat(f.geometry.coordinates).addTo(map); placeTag(); }
    },
    flyTo(lat, lng, zoom) {
      const z = zoom ?? Math.max(map.getZoom(), 9);
      const offsetX = innerWidth > 860 && !document.getElementById('card').hidden ? -230 : 0;
      const offsetY = innerWidth <= 860 && !document.getElementById('card').hidden ? -innerHeight * 0.22 : 0;
      map.flyTo({ center: [lng, lat], zoom: z, offset: [offsetX, offsetY], speed: 1.4, curve: 1.5, essential: true });
    },
    retheme() {
      const was = base; base = lookBase(); map.setStyle(buildStyle(base), { diff: false });
      // the flat map shows the whole world at once: going to it from the globe, open it at that size
      map.setTransformConstrain(base === 'atlas' ? atlasConstrain : null);
      if (base === 'atlas' && was !== 'atlas' && map.getZoom() < 3) map.jumpTo({ center: [10, 15], zoom: atlasZoom() });
    },
    resize() { map.resize(); },
    center() { const c = map.getCenter(); return { lat: c.lat, lng: c.lng, zoom: map.getZoom() }; },
    /** Crosshair placement. Resolves with {lat,lng} or null if cancelled. */
    pick(from, ui) {
      if (from) map.jumpTo({ center: [from.lng, from.lat], zoom: Math.max(map.getZoom(), from.zoom || 14) });
      return new Promise(res => {
        picking = {
          update() { const c = map.getCenter(); ui.coords(c.lat, ((c.lng + 540) % 360) - 180); },
          done(ok) { picking = null; const c = map.getCenter(); res(ok ? { lat: c.lat, lng: ((c.lng + 540) % 360) - 180 } : null); },
        };
        picking.update();
        ui.bind(picking.done);
      });
    },
  };
}
