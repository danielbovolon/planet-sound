/* The map: a globe that flattens as you zoom in, drawn in the same ink and
 * board colours as the rest of the archive. Vector data from OpenFreeMap
 * (no key, no quota), optional Esri imagery. */
import * as maplibregl from '../../vendor/maplibre/maplibre-gl.mjs';

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

export function createMap(el, { onSelect, onSpot, onMoveEnd, start }) {
  let base = 'atlas', data = { type: 'FeatureCollection', features: [] }, selected = null, picking = null;
  const map = new maplibregl.Map({
    container: el,
    style: buildStyle(base),
    center: start ? [start.lng, start.lat] : [11.35, 30],
    zoom: start ? start.zoom : (innerWidth < 700 ? 1.1 : 2.15),
    attributionControl: { compact: true },
    maxPitch: 0, dragRotate: false, pitchWithRotate: false, touchPitch: false,
    renderWorldCopies: false,
  });
  map.touchZoomRotate.disableRotation();
  map.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'bottom-right');
  const hoverPopup = new maplibregl.Popup({ closeButton: false, closeOnClick: false, offset: 12, className: 'ps-pop' });
  let loadedTiles = false, failTimer = null;

  map.on('sourcedata', e => { if (e.sourceId === 'ofm' && e.isSourceLoaded) loadedTiles = true; });
  map.on('error', e => {
    // If the vector service can't be reached at all, fall back to imagery so
    // there is still a world to look at.
    if (base === 'atlas' && !loadedTiles && e && e.sourceId === 'ofm' && !failTimer) {
      failTimer = setTimeout(() => { if (!loadedTiles) setBase('imagery', true); }, 2500);
    }
  });

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

  function setBase(b, auto) {
    if (b === base && !auto) return;
    base = b;
    map.setStyle(buildStyle(base), { diff: false });
    document.querySelectorAll('[data-base]').forEach(x => x.setAttribute('aria-pressed', String(x.dataset.base === base)));
  }

  return {
    map,
    setData(sounds) {
      data = {
        type: 'FeatureCollection',
        features: sounds.filter(s => typeof s.lat === 'number' && typeof s.lng === 'number').map(s => ({
          type: 'Feature', id: s.id, geometry: { type: 'Point', coordinates: [s.lng, s.lat] },
          properties: { id: s.id, title: s.title, place: s.place || '', private: s.visibility === 'private' ? 1 : 0 },
        })),
      };
      if (map.getSource('sounds')) applyData();
      else map.once('styledata', applyData);
    },
    select(id) {
      if (selected && map.getSource('sounds')) map.setFeatureState({ source: 'sounds', id: selected }, { selected: false });
      selected = id || null;
      if (selected && map.getSource('sounds')) map.setFeatureState({ source: 'sounds', id: selected }, { selected: true });
    },
    flyTo(lat, lng, zoom) {
      const z = zoom ?? Math.max(map.getZoom(), 9);
      const offsetX = innerWidth > 860 && !document.getElementById('card').hidden ? -230 : 0;
      const offsetY = innerWidth <= 860 && !document.getElementById('card').hidden ? -innerHeight * 0.22 : 0;
      map.flyTo({ center: [lng, lat], zoom: z, offset: [offsetX, offsetY], speed: 1.4, curve: 1.5, essential: true });
    },
    setBase,
    retheme() { map.setStyle(buildStyle(base), { diff: false }); },
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
