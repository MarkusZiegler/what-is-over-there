import {
  norm360, angleDiff, destination, distance, bearingTo, circularStats, conePolygon, compassLabel, w3cCompassHeading,
} from './geo.js';
import { queryCone, classify, wikiUrl, GROUPS } from './overpass.js';

/* global L */

const $ = (id) => document.getElementById(id);
const DEMO = new URLSearchParams(location.search).has('demo');
const PEIL_MS = 1500; // so lange wird beim Peilen gemittelt
const DIST_OPTIONS = [5000, 15000, 30000, 60000];
const LS_SETTINGS = 'wiot.settings.v1';
const LS_HISTORY = 'wiot.history.v1';

// ---------------------------------------------------------------- Speicher

function load(key, fallback) {
  try {
    const v = JSON.parse(localStorage.getItem(key));
    return v ?? fallback;
  } catch {
    return fallback;
  }
}
function store(key, val) {
  try {
    localStorage.setItem(key, JSON.stringify(val));
  } catch {
    /* privater Modus o. ä. – App funktioniert trotzdem */
  }
}

const DEFAULTS = {
  offset: 0,
  dist: 15000,
  groups: { ort: true, bau: true, natur: true },
  sort: 'dist',
  showHistory: false,
  layer: 'Karte',
};
const savedSettings = load(LS_SETTINGS, {});
const settings = { ...DEFAULTS, ...savedSettings, groups: { ...DEFAULTS.groups, ...(savedSettings.groups || {}) } };
const saveSettings = () => store(LS_SETTINGS, settings);

let history = load(LS_HISTORY, []);
if (!Array.isArray(history)) history = [];
const saveHistory = () => store(LS_HISTORY, history);

const state = {
  view: 'start',
  startedAt: 0,
  pos: null, // {lat, lon, acc, alt, t}
  geoError: null,
  heading: null, // letzter Rohwert (ohne Korrektur)
  smooth: null, // geglättet, für die Anzeige
  compassAcc: null,
  pitch: null,
  source: null,
  raw: {},
  samples: [], // {t, h} der letzten 3 s
  collecting: null, // Array während des Peilens
  bearing: history[0] || null,
  results: [],
  resultsFor: null,
  calibrating: false,
};

/** Effektive Richtung einer Peilung inkl. Kompass-Korrektur. */
const eff = (b) => norm360(b.measured + settings.offset);

// ---------------------------------------------------------------- Formatierung

const nf1 = new Intl.NumberFormat('de-DE', { maximumFractionDigits: 1, minimumFractionDigits: 1 });
const fmtDist = (m) => (m < 1000 ? `${Math.round(m / 10) * 10} m` : `${nf1.format(m / 1000)} km`);
const fmtSigned = (v) => (v > 0 ? '+' : v < 0 ? '−' : '±') + nf1.format(Math.abs(v));
const fmtOff = (off) => (Math.abs(off) < 0.5 ? 'genau auf der Linie' : `${nf1.format(Math.abs(off))}° ${off > 0 ? 'rechts' : 'links'}`);
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

let toastTimer;
function toast(msg, ms = 3500) {
  const t = $('toast');
  t.textContent = msg;
  t.classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.add('hidden'), ms);
}

// ---------------------------------------------------------------- Ansichten

function show(view) {
  for (const v of ['start', 'camera', 'map']) $('view-' + v).classList.toggle('active', v === view);
  state.view = view;
  if (view === 'camera') startHudLoop();
  if (view === 'map') onShowMap();
}

// ---------------------------------------------------------------- Sensoren

function handleOrientation(e) {
  let h = null;
  let src = null;
  if (typeof e.webkitCompassHeading === 'number' && e.webkitCompassHeading >= 0) {
    // iOS: fertige Kompassrichtung
    h = e.webkitCompassHeading;
    src = 'iOS webkitCompassHeading';
    state.compassAcc = typeof e.webkitCompassAccuracy === 'number' ? e.webkitCompassAccuracy : null;
  } else if ((e.absolute || e.type === 'deviceorientationabsolute') && e.alpha != null) {
    // Android: absolute Orientierung → Blickrichtung der Rückkamera berechnen
    h = w3cCompassHeading(e.alpha, e.beta, e.gamma);
    src = 'deviceorientationabsolute';
  }

  state.raw = {
    type: e.type,
    alpha: e.alpha,
    beta: e.beta,
    gamma: e.gamma,
    absolute: e.absolute,
    webkitCompassHeading: e.webkitCompassHeading,
    webkitCompassAccuracy: e.webkitCompassAccuracy,
  };
  if (typeof e.beta === 'number') state.pitch = e.beta - 90; // Hochformat aufrecht = 0°

  if (h == null || Number.isNaN(h)) return;
  // iOS-Wert bevorzugen, falls beide Quellen feuern
  if (state.source === 'iOS webkitCompassHeading' && src !== state.source) return;
  state.source = src;

  const now = performance.now();
  state.samples.push({ t: now, h });
  while (state.samples.length && now - state.samples[0].t > 3000) state.samples.shift();
  state.heading = h;
  state.smooth = state.smooth == null ? h : norm360(state.smooth + angleDiff(h, state.smooth) * 0.2);
  if (state.collecting) state.collecting.push(h);
}

function recentStats(ms = 1000) {
  const now = performance.now();
  const vals = state.samples.filter((s) => now - s.t <= ms).map((s) => s.h);
  return { ...circularStats(vals), rate: (vals.length * 1000) / ms };
}

function startGeo() {
  if (!('geolocation' in navigator)) {
    state.geoError = 'Kein GPS verfügbar';
    return;
  }
  navigator.geolocation.watchPosition(
    (p) => {
      state.pos = {
        lat: p.coords.latitude,
        lon: p.coords.longitude,
        acc: p.coords.accuracy,
        alt: p.coords.altitude,
        t: Date.now(),
      };
      state.geoError = null;
      updateLivePos();
    },
    (err) => {
      state.geoError = err.code === 1 ? 'Standort nicht freigegeben' : `GPS: ${err.message}`;
    },
    { enableHighAccuracy: true, maximumAge: 2000, timeout: 20000 },
  );
}

async function startCamera() {
  if (!navigator.mediaDevices?.getUserMedia) throw new Error('nicht verfügbar (HTTPS nötig)');
  const stream = await navigator.mediaDevices.getUserMedia({
    video: { facingMode: { ideal: 'environment' }, width: { ideal: 1920 }, height: { ideal: 1080 } },
    audio: false,
  });
  const v = $('video');
  v.srcObject = stream;
  await v.play().catch(() => {});
}

let wakeLock = null;
async function requestWakeLock() {
  try {
    if ('wakeLock' in navigator && document.visibilityState === 'visible') {
      wakeLock = await navigator.wakeLock.request('screen');
    }
  } catch {
    /* nicht schlimm */
  }
}
document.addEventListener('visibilitychange', () => {
  // Die Sperre wird beim Wechsel in den Hintergrund automatisch freigegeben → neu anfordern
  if (document.visibilityState === 'visible' && state.startedAt && (!wakeLock || wakeLock.released)) requestWakeLock();
});

// Demo-Modus für den Desktop: index.html?demo – Meersburg, Blick über den Bodensee
function startDemo() {
  let demoH = 243;
  state.pos = { lat: 47.6929, lon: 9.2712, acc: 6, alt: 400, t: Date.now() };
  setInterval(() => {
    handleOrientation({
      type: 'deviceorientation',
      webkitCompassHeading: norm360(demoH + (Math.random() - 0.5) * 2),
      webkitCompassAccuracy: 5,
      alpha: 0,
      beta: 90 + (Math.random() - 0.5),
      gamma: 0,
    });
  }, 50);
  window.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowLeft') demoH = norm360(demoH - 2);
    if (e.key === 'ArrowRight') demoH = norm360(demoH + 2);
  });
  toast('Demo-Modus: Richtung mit ← / → ändern', 5000);
}

$('btn-start').addEventListener('click', async () => {
  const errs = [];
  state.startedAt = performance.now();
  if (DEMO) {
    startDemo();
  } else {
    // iOS: Freigabe der Bewegungssensoren MUSS direkt im Klick-Handler angefragt werden
    try {
      if (typeof DeviceOrientationEvent !== 'undefined' && typeof DeviceOrientationEvent.requestPermission === 'function') {
        const r = await DeviceOrientationEvent.requestPermission();
        if (r !== 'granted') errs.push('Bewegungssensoren nicht freigegeben');
      }
    } catch (e) {
      errs.push(`Bewegungssensoren: ${e.message}`);
    }
    window.addEventListener('deviceorientation', handleOrientation, true);
    window.addEventListener('deviceorientationabsolute', handleOrientation, true);
    startGeo();
  }
  try {
    await startCamera();
  } catch (e) {
    if (!DEMO) errs.push(`Kamera: ${e.message}`);
  }
  requestWakeLock();
  show('camera');
  if (errs.length) toast(errs.join(' · '), 7000);
});

// ---------------------------------------------------------------- Kamera-HUD

let hudRunning = false;
function startHudLoop() {
  if (hudRunning) return;
  hudRunning = true;
  const tick = () => {
    if (state.view !== 'camera') {
      hudRunning = false;
      return;
    }
    renderHud();
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}

function renderHud() {
  const h = state.smooth == null ? null : norm360(state.smooth + settings.offset);
  $('hud-heading').textContent = h == null ? '–––°' : `${Math.round(h) % 360}°`;
  $('hud-dir').textContent = h == null ? '' : compassLabel(h);
  drawTape(h);

  $('hud-gps').textContent = state.pos ? `GPS ±${Math.round(state.pos.acc)} m` : 'GPS …';
  $('hud-pitch').textContent = state.pitch == null ? 'Neigung –' : `Neigung ${fmtSigned(state.pitch)}°`;
  const st = recentStats(1000);
  $('hud-stab').textContent = st.n > 2 ? `Streuung ±${nf1.format(st.std)}°` : 'Streuung –';

  const warns = [];
  if (state.geoError) warns.push(state.geoError);
  else if (!state.pos) warns.push('Warte auf GPS …');
  else if (state.pos.acc > 50) warns.push(`GPS ungenau (±${Math.round(state.pos.acc)} m)`);
  if (state.heading == null) {
    if (performance.now() - state.startedAt > 2500) warns.push('Keine Kompassdaten. Sind die Bewegungssensoren freigegeben?');
  } else if (state.compassAcc != null && (state.compassAcc < 0 || state.compassAcc > 20)) {
    warns.push('Kompass ungenau: Handy einige Male in einer liegenden Acht bewegen');
  }
  const w = $('hud-warn');
  w.textContent = warns.join(' · ');
  w.classList.toggle('hidden', !warns.length);
}

function drawTape(h) {
  const c = $('tape');
  const dpr = window.devicePixelRatio || 1;
  const w = c.clientWidth;
  const ht = c.clientHeight;
  if (c.width !== Math.round(w * dpr) || c.height !== Math.round(ht * dpr)) {
    c.width = Math.round(w * dpr);
    c.height = Math.round(ht * dpr);
  }
  const ctx = c.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, ht);
  if (h == null) return;
  const span = 60;
  const ppd = w / span;
  ctx.font = '600 12px -apple-system, system-ui, sans-serif';
  ctx.textAlign = 'center';
  ctx.strokeStyle = 'rgba(255,255,255,.85)';
  const start = Math.floor((h - span / 2) / 5) * 5;
  for (let d = start; d <= h + span / 2; d += 5) {
    const x = w / 2 + (d - h) * ppd;
    const nd = norm360(d);
    const major = nd % 15 === 0;
    ctx.lineWidth = major ? 2 : 1;
    ctx.beginPath();
    ctx.moveTo(x, ht);
    ctx.lineTo(x, ht - (major ? 12 : 6));
    ctx.stroke();
    if (major) {
      ctx.fillStyle = nd % 90 === 0 ? '#ffb020' : '#fff';
      ctx.fillText(nd % 45 === 0 ? compassLabel(nd) : String(nd), x, ht - 16);
    }
  }
  ctx.fillStyle = '#ff5a36';
  ctx.beginPath();
  ctx.moveTo(w / 2 - 7, 0);
  ctx.lineTo(w / 2 + 7, 0);
  ctx.lineTo(w / 2, 9);
  ctx.fill();
}

// ---------------------------------------------------------------- Peilen

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

$('btn-peilen').addEventListener('click', async () => {
  if (state.collecting) return;
  if (!state.pos) return toast(state.geoError || 'Noch kein GPS-Standort, bitte kurz warten.');
  if (state.heading == null) return toast('Kein Kompass-Signal.');

  state.collecting = [];
  $('peil-overlay').classList.remove('hidden');
  $('btn-peilen').disabled = true;
  await sleep(PEIL_MS);
  const vals = state.collecting;
  state.collecting = null;
  $('peil-overlay').classList.add('hidden');
  $('btn-peilen').disabled = false;
  if (vals.length < 3) return toast('Zu wenige Kompass-Messwerte, bitte nochmal.');

  const { mean, std } = circularStats(vals);
  const p = state.pos;
  const b = {
    id: Date.now(),
    t: new Date().toISOString(),
    lat: p.lat,
    lon: p.lon,
    acc: p.acc,
    alt: p.alt,
    measured: mean,
    std,
    pitch: state.pitch,
    compassAcc: state.compassAcc,
    tol: clamp(Math.round(3 + 2 * std), 3, 15),
  };
  history.unshift(b);
  history = history.slice(0, 30);
  saveHistory();
  state.bearing = b;
  state.results = [];
  state.resultsFor = null;
  if (p.acc > 50) toast(`Achtung: GPS nur auf ±${Math.round(p.acc)} m genau.`);
  show('map');
});

$('btn-to-map').addEventListener('click', () => show('map'));
$('btn-to-camera').addEventListener('click', () => {
  cancelCalibration();
  show(state.startedAt ? 'camera' : 'start');
});

// ---------------------------------------------------------------- Karte

let map;
const layers = {};

function initMap() {
  if (map) return;
  map = L.map('map', { zoomControl: false });
  L.control.zoom({ position: 'bottomright' }).addTo(map);
  const base = {
    Karte: L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 19,
      attribution: '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
    }),
    Topo: L.tileLayer('https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png', {
      maxZoom: 17,
      attribution: '© OpenStreetMap, SRTM | © <a href="https://opentopomap.org">OpenTopoMap</a> (CC-BY-SA)',
    }),
    Satellit: L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', {
      maxZoom: 19,
      attribution: 'Tiles © Esri, Maxar, Earthstar Geographics',
    }),
  };
  (base[settings.layer] || base.Karte).addTo(map);
  L.control.layers(base, null, { position: 'topright' }).addTo(map);
  map.on('baselayerchange', (e) => {
    settings.layer = e.name;
    saveSettings();
  });
  layers.history = L.layerGroup().addTo(map);
  layers.cone = L.layerGroup().addTo(map);
  layers.results = L.layerGroup().addTo(map);
  layers.live = L.layerGroup().addTo(map);
  map.on('click', (e) => {
    if (state.calibrating) calibrateTo(e.latlng.lat, e.latlng.lng);
  });
  map.setView([51.1, 10.4], 6);
}

function onShowMap() {
  initMap();
  setTimeout(() => {
    map.invalidateSize();
    drawBearing(true);
    updateLivePos();
    if (state.bearing && state.resultsFor !== state.bearing.id) runQuery();
    else renderResults();
  }, 30);
  syncControls();
}

function updateLivePos() {
  if (!map || !state.pos) return;
  layers.live.clearLayers();
  L.circleMarker([state.pos.lat, state.pos.lon], {
    radius: 6, color: '#fff', weight: 2, fillColor: '#2f7bff', fillOpacity: 1,
  }).addTo(layers.live);
}

function drawBearing(fit) {
  if (!map) return;
  layers.cone.clearLayers();
  const b = state.bearing;
  drawHistory();
  if (!b) {
    $('map-title').textContent = 'Noch keine Peilung';
    if (state.pos && fit) map.setView([state.pos.lat, state.pos.lon], 13);
    return;
  }
  const h = eff(b);
  const poly = conePolygon(b.lat, b.lon, h, b.tol, settings.dist, 32);
  L.polygon(poly, { color: '#ffb020', weight: 1, fillColor: '#ffb020', fillOpacity: 0.13, interactive: false }).addTo(layers.cone);
  const end = destination(b.lat, b.lon, h, settings.dist);
  L.polyline([[b.lat, b.lon], [end.lat, end.lon]], { color: '#ff5a36', weight: 3, dashArray: '8 6', interactive: false }).addTo(layers.cone);

  // Entfernungsmarken
  for (const km of [1, 2, 5, 10, 20, 50]) {
    if (km * 1000 >= settings.dist) break;
    const p = destination(b.lat, b.lon, h, km * 1000);
    L.circleMarker([p.lat, p.lon], { radius: 3, color: '#ff5a36', weight: 1, fillOpacity: 1, interactive: false })
      .bindTooltip(`${km} km`, { permanent: true, direction: 'right', className: 'km-tip', offset: [4, 0] })
      .addTo(layers.cone);
  }

  if (b.acc) L.circle([b.lat, b.lon], { radius: b.acc, color: '#2f7bff', weight: 1, fillOpacity: 0.1, interactive: false }).addTo(layers.cone);
  L.circleMarker([b.lat, b.lon], { radius: 7, color: '#fff', weight: 2, fillColor: '#ff5a36', fillOpacity: 1 })
    .bindPopup(`Standort der Peilung<br>${new Date(b.t).toLocaleString('de-DE')}<br>GPS ±${Math.round(b.acc)} m`)
    .addTo(layers.cone);

  $('map-title').textContent = `${Math.round(h) % 360}° ${compassLabel(h)} · ±${b.tol}°`;
  if (fit) map.fitBounds(L.latLngBounds(poly).pad(0.08));
}

function drawHistory() {
  layers.history.clearLayers();
  if (!settings.showHistory) return;
  for (const hb of history) {
    if (state.bearing && hb.id === state.bearing.id) continue;
    const h = eff(hb);
    const end = destination(hb.lat, hb.lon, h, settings.dist);
    L.polyline([[hb.lat, hb.lon], [end.lat, end.lon]], { color: '#9aa7b8', weight: 2, opacity: 0.8 })
      .bindTooltip(`${new Date(hb.t).toLocaleString('de-DE')} · ${Math.round(h)}°<br>Antippen zum Auswählen`)
      .on('click', () => selectBearing(hb))
      .addTo(layers.history);
  }
}

function selectBearing(b) {
  if (state.calibrating) return;
  state.bearing = b;
  state.results = [];
  state.resultsFor = null;
  syncControls();
  drawBearing(true);
  runQuery();
}

// ---------------------------------------------------------------- Bedienelemente der Karte

function syncControls() {
  const b = state.bearing;
  $('tol').value = b ? b.tol : 5;
  $('tol-val').textContent = `±${b ? b.tol : 5}°`;
  $('chk-history').checked = settings.showHistory;

  $('dist-chips').innerHTML = DIST_OPTIONS.map(
    (d) => `<button class="chip ${settings.dist === d ? 'on' : ''}" data-dist="${d}">${d / 1000} km</button>`,
  ).join('');
  $('group-chips').innerHTML = Object.entries(GROUPS)
    .map(([k, g]) => `<button class="chip ${settings.groups[k] ? 'on' : ''}" data-group="${k}" style="--c:${g.color}">${g.label}</button>`)
    .join('');
  $('sort-chips').innerHTML = [
    ['dist', 'Nach Entfernung'],
    ['dir', 'Nach Richtung'],
  ]
    .map(([k, l]) => `<button class="chip ${settings.sort === k ? 'on' : ''}" data-sort="${k}">${l}</button>`)
    .join('');
}

$('dist-chips').addEventListener('click', (e) => {
  const d = e.target.closest('[data-dist]');
  if (!d) return;
  settings.dist = Number(d.dataset.dist);
  saveSettings();
  syncControls();
  drawBearing(true);
  scheduleQuery();
});
$('group-chips').addEventListener('click', (e) => {
  const g = e.target.closest('[data-group]');
  if (!g) return;
  settings.groups[g.dataset.group] = !settings.groups[g.dataset.group];
  saveSettings();
  syncControls();
  renderResults();
});
$('sort-chips').addEventListener('click', (e) => {
  const s = e.target.closest('[data-sort]');
  if (!s) return;
  settings.sort = s.dataset.sort;
  saveSettings();
  syncControls();
  renderResults();
});
$('tol').addEventListener('input', (e) => {
  if (!state.bearing) return;
  state.bearing.tol = Number(e.target.value);
  $('tol-val').textContent = `±${state.bearing.tol}°`;
  saveHistory();
  drawBearing(false);
  scheduleQuery();
});
$('chk-history').addEventListener('change', (e) => {
  settings.showHistory = e.target.checked;
  saveSettings();
  drawHistory();
});

// ---------------------------------------------------------------- Kalibrieren

$('btn-calib').addEventListener('click', () => {
  if (!state.bearing) return toast('Erst eine Peilung machen.');
  state.calibrating = true;
  $('calib-banner').classList.remove('hidden');
  $('map').classList.add('calibrating');
});
$('btn-calib-cancel').addEventListener('click', cancelCalibration);

function cancelCalibration() {
  state.calibrating = false;
  $('calib-banner').classList.add('hidden');
  $('map').classList.remove('calibrating');
}

function calibrateTo(lat, lon) {
  const b = state.bearing;
  if (!b) return;
  const d = distance(b.lat, b.lon, lat, lon);
  if (d < 500 && !confirm(`Das Ziel ist nur ${fmtDist(d)} entfernt. GPS-Ungenauigkeit verfälscht die Kalibrierung dann stark (mind. 1 km empfohlen). Trotzdem übernehmen?`)) {
    return;
  }
  const trueBrg = bearingTo(b.lat, b.lon, lat, lon);
  settings.offset = Math.round(angleDiff(trueBrg, b.measured) * 10) / 10;
  saveSettings();
  cancelCalibration();
  toast(`Kalibriert: Kompass-Korrektur ${fmtSigned(settings.offset)}°`);
  drawBearing(false);
  runQuery();
}

// ---------------------------------------------------------------- Suche

let queryCtl = null;
let queryTimer = null;

function scheduleQuery() {
  clearTimeout(queryTimer);
  queryTimer = setTimeout(runQuery, 700);
}

function setStatus(html) {
  $('status').innerHTML = html;
}

async function runQuery() {
  clearTimeout(queryTimer);
  const b = state.bearing;
  if (!b) {
    setStatus('Peile in der Kamera-Ansicht etwas an. Danach erscheint hier, was in dieser Richtung liegt.');
    return;
  }
  queryCtl?.abort();
  const ctl = new AbortController();
  queryCtl = ctl;
  const h = eff(b);
  const poly = conePolygon(b.lat, b.lon, h, b.tol, settings.dist, 12);
  setStatus('<span class="spinner"></span> Suche in OpenStreetMap …');
  try {
    const els = await queryCone(poly, ctl.signal, ({ waitMs }) => {
      if (ctl === queryCtl) {
        setStatus(`<span class="spinner"></span> OpenStreetMap-Server ausgelastet, neuer Versuch in ${Math.round(waitMs / 1000)} s …`);
      }
    });
    if (ctl !== queryCtl) return;
    state.results = processElements(els, b);
    state.resultsFor = b.id;
    renderResults();
  } catch (e) {
    if (e.name === 'AbortError') return;
    setStatus(`Fehler bei der Suche: ${esc(e.message)} <button class="pill small" id="btn-retry">Erneut versuchen</button>`);
    $('btn-retry')?.addEventListener('click', runQuery);
  }
}

function processElements(els, b) {
  const h = eff(b);
  const out = [];
  for (const el of els) {
    const lat = el.lat ?? el.center?.lat;
    const lon = el.lon ?? el.center?.lon;
    if (lat == null || lon == null) continue;
    const tags = el.tags || {};
    const c = classify(tags);
    if (!c) continue;
    const d = distance(b.lat, b.lon, lat, lon);
    if (d < 30) continue;
    const brg = bearingTo(b.lat, b.lon, lat, lon);
    out.push({ ...c, osm: `${el.type}/${el.id}`, lat, lon, tags, d, brg, off: angleDiff(brg, h) });
  }
  // Duplikate entfernen (z. B. Kirchengebäude + Kirchen-Punkt mit gleichem Namen)
  out.sort((a, z) => a.prio - z.prio);
  const kept = [];
  for (const r of out) {
    if (kept.some((k) => k.name === r.name && distance(k.lat, k.lon, r.lat, r.lon) < 400)) continue;
    kept.push(r);
  }
  return kept;
}

function linksHtml(r) {
  const ll = `${r.lat.toFixed(6)},${r.lon.toFixed(6)}`;
  const links = [
    `<a href="https://www.google.com/maps/search/?api=1&query=${ll}" target="_blank" rel="noopener">Google Maps</a>`,
    `<a href="https://maps.apple.com/?daddr=${ll}&q=${encodeURIComponent(r.name)}" target="_blank" rel="noopener">Route (Apple)</a>`,
  ];
  const wiki = wikiUrl(r.tags);
  if (wiki) links.push(`<a href="${esc(wiki)}" target="_blank" rel="noopener">Wikipedia</a>`);
  if (r.tags.website && /^https?:\/\//.test(r.tags.website)) {
    links.push(`<a href="${esc(r.tags.website)}" target="_blank" rel="noopener">Website</a>`);
  }
  links.push(`<a href="https://www.openstreetmap.org/${r.osm}" target="_blank" rel="noopener">OSM</a>`);
  return links.join('');
}

function subText(r) {
  const parts = [r.label];
  if (r.tags.ele) parts.push(`${esc(r.tags.ele)} m`);
  parts.push(fmtDist(r.d), fmtOff(r.off));
  return parts.join(' · ');
}

function renderResults() {
  if (!map) return;
  layers.results.clearLayers();
  const b = state.bearing;
  if (!b) {
    $('results').innerHTML = '';
    setStatus('Peile in der Kamera-Ansicht etwas an. Danach erscheint hier, was in dieser Richtung liegt.');
    return;
  }
  if (state.resultsFor !== b.id) return;

  const list = state.results.filter((r) => settings.groups[r.group]);
  if (settings.sort === 'dir') list.sort((a, z) => Math.abs(a.off) - Math.abs(z.off));
  else list.sort((a, z) => a.d - z.d);

  const hidden = state.results.length - list.length;
  if (!state.results.length) {
    setStatus('Nichts gefunden. Vergrößere Toleranz oder Entfernung.');
  } else {
    setStatus(`<b>${list.length}</b> Treffer im Sichtkegel${hidden ? ` (${hidden} ausgeblendet)` : ''}`);
  }

  $('results').innerHTML = list
    .map(
      (r, i) => `<li class="res ${Math.abs(r.off) <= b.tol / 3 ? 'near' : ''}" data-i="${i}">
        <button class="res-main" data-act="focus">
          <span class="ico" style="--c:${GROUPS[r.group].color}">${r.icon}</span>
          <span class="res-text">
            <span class="res-name ${r.unnamed ? 'unnamed' : ''}">${esc(r.name)}</span>
            <span class="res-sub">${subText(r)}</span>
          </span>
        </button>
        <div class="res-links">${linksHtml(r)}<button class="linkbtn" data-act="calib" title="Diesen Ort zur Kalibrierung verwenden">🎯 War mein Ziel</button></div>
      </li>`,
    )
    .join('');

  list.forEach((r, i) => {
    r.marker = L.circleMarker([r.lat, r.lon], {
      radius: 7, color: '#0b0f14', weight: 1.5, fillColor: GROUPS[r.group].color, fillOpacity: 0.95,
    })
      .bindPopup(`<b>${r.icon} ${esc(r.name)}</b><br><span class="pop-sub">${subText(r)}</span><div class="pop-links">${linksHtml(r)}</div>`)
      .on('click', () => highlight(i, false))
      .addTo(layers.results);
  });
  renderResults.list = list;
}

function highlight(i, fly) {
  const list = renderResults.list || [];
  const r = list[i];
  if (!r) return;
  document.querySelectorAll('.res.active').forEach((el) => el.classList.remove('active'));
  const li = document.querySelector(`.res[data-i="${i}"]`);
  if (li) {
    li.classList.add('active');
    if (!fly) li.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }
  if (fly) {
    map.flyTo([r.lat, r.lon], Math.max(map.getZoom(), 14), { duration: 0.6 });
    r.marker?.openPopup();
  }
}

$('results').addEventListener('click', (e) => {
  const act = e.target.closest('[data-act]');
  const li = e.target.closest('.res');
  if (!act || !li) return;
  const i = Number(li.dataset.i);
  const r = (renderResults.list || [])[i];
  if (!r) return;
  if (act.dataset.act === 'focus') highlight(i, true);
  if (act.dataset.act === 'calib') calibrateTo(r.lat, r.lon);
});

// ---------------------------------------------------------------- Einstellungen

let debugTimer = null;
function openSettings() {
  $('offset').value = settings.offset;
  $('hist-count').textContent = `${history.length} gespeicherte Peilung${history.length === 1 ? '' : 'en'}`;
  $('settings').classList.remove('hidden');
  renderDebug();
  debugTimer = setInterval(renderDebug, 250);
}
function closeSettings() {
  $('settings').classList.add('hidden');
  clearInterval(debugTimer);
}
function renderDebug() {
  const st = recentStats(1000);
  const r = state.raw;
  const f = (v, d = 1) => (typeof v === 'number' ? v.toFixed(d) : String(v));
  const p = state.pos;
  $('debug').textContent = [
    `Quelle:        ${state.source || '–'}`,
    `Richtung roh:  ${f(state.heading)}°   geglättet: ${f(state.smooth)}°`,
    `iOS-Genauigk.: ${state.compassAcc == null ? '–' : `±${f(state.compassAcc, 0)}°`}`,
    `Streuung 1 s:  ${st.n > 2 ? `±${f(st.std, 2)}°` : '–'}   (${Math.round(st.rate)} Werte/s)`,
    `alpha/beta/gamma: ${f(r.alpha)} / ${f(r.beta)} / ${f(r.gamma)}`,
    `Neigung:       ${f(state.pitch)}°`,
    `GPS:           ${p ? `${p.lat.toFixed(5)}, ${p.lon.toFixed(5)} ±${Math.round(p.acc)} m` : state.geoError || '–'}`,
    `Höhe:          ${p && p.alt != null ? `${Math.round(p.alt)} m` : '–'}`,
    `GPS-Alter:     ${p ? `${Math.round((Date.now() - p.t) / 1000)} s` : '–'}`,
    `Korrektur:     ${fmtSigned(settings.offset)}°`,
  ].join('\n');
}

$('btn-settings').addEventListener('click', openSettings);
$('btn-settings2').addEventListener('click', openSettings);
$('btn-settings-close').addEventListener('click', closeSettings);
$('settings').addEventListener('click', (e) => {
  if (e.target.id === 'settings') closeSettings();
});
$('offset').addEventListener('change', (e) => {
  const v = parseFloat(String(e.target.value).replace(',', '.'));
  settings.offset = Number.isFinite(v) ? clamp(v, -180, 180) : 0;
  saveSettings();
  drawBearing(false);
  if (state.bearing) scheduleQuery();
});
$('btn-offset-reset').addEventListener('click', () => {
  settings.offset = 0;
  $('offset').value = 0;
  saveSettings();
  drawBearing(false);
  if (state.bearing) scheduleQuery();
});
$('btn-hist-clear').addEventListener('click', () => {
  if (!confirm('Alle gespeicherten Peilungen löschen?')) return;
  history = state.bearing ? [state.bearing] : [];
  saveHistory();
  $('hist-count').textContent = `${history.length} gespeicherte Peilung${history.length === 1 ? '' : 'en'}`;
  drawHistory();
});

if (DEMO) $('btn-start').textContent = 'Demo starten';
