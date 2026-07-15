/* MoonSun.Earth — Sun & Moon in the sky from anywhere on Earth (CesiumJS + SunCalc)
 *
 * SETUP: put your free Cesium ion token below (https://ion.cesium.com/tokens)
 * for terrain elevation + place search. Imagery is Esri (no key needed). */
const CESIUM_ION_TOKEN = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJqdGkiOiJjMTU1NzY5My0zOTU4LTQ5YTAtYWY4NS1hMzJjYTNmYjc4N2IiLCJpZCI6NDU2NDY5LCJzdWIiOiJnYWJncmVuIiwiaXNzIjoiaHR0cHM6Ly9hcGkuY2VzaXVtLmNvbSIsImF1ZCI6ImdhYmdyZW5fZGVmYXVsdCIsImlhdCI6MTc4NDA3OTMzMH0.GXflc6xKThcDBUUvkVA4O5tVQeJEtKpxaeUDW607xVY";  // domain-restricted (moonsun.earth + localhost)

const hasIonToken = CESIUM_ION_TOKEN && CESIUM_ION_TOKEN !== "YOUR_CESIUM_ION_TOKEN";
if (hasIonToken) Cesium.Ion.defaultAccessToken = CESIUM_ION_TOKEN;

// ---- Viewer ---------------------------------------------------------------
// Default imagery = Esri World Imagery (satellite), which needs no token so the
// globe always renders. If an ion token is present we upgrade to World Terrain.
const viewer = new Cesium.Viewer("cesiumContainer", {
  baseLayer: Cesium.ImageryLayer.fromProviderAsync(
    Cesium.ArcGisMapServerImageryProvider.fromUrl(
      "https://services.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer"
    ), {}),
  baseLayerPicker: false,
  geocoder: hasIonToken,     // the built-in geocoder (place search) needs an ion token
  animation: true,           // clock dial
  timeline: true,            // scrub-able timeline
  sceneModePicker: false,
  navigationHelpButton: false,
  homeButton: false,
  fullscreenButton: false,
  infoBox: false,
  selectionIndicator: false,
});

if (hasIonToken) {
  Cesium.createWorldTerrainAsync().then((t) => { viewer.terrainProvider = t; })
    .catch((e) => console.warn("World Terrain unavailable:", e));
}

// Animated moon-phase logo icon + favicon (cycles waxing → waning).
(() => {
  const el = document.getElementById("phaseIcon");
  const link = document.getElementById("favicon");
  const phases = ["🌑", "🌒", "🌓", "🌔", "🌕", "🌖", "🌗", "🌘"];

  // Pre-render each phase to a data URL once; swapping href per tick is then cheap.
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = 64;
  const ctx = canvas.getContext("2d");
  ctx.font = "52px -apple-system, 'Apple Color Emoji', 'Segoe UI Emoji', 'Noto Color Emoji', sans-serif";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  const icons = phases.map((p) => {
    ctx.clearRect(0, 0, 64, 64);
    ctx.fillText(p, 32, 34);
    return canvas.toDataURL("image/png");
  });

  let i = 0;
  setInterval(() => {
    i = (i + 1) % phases.length;
    el.textContent = phases[i];
    link.href = icons[i];
  }, 400);
})();

const scene = viewer.scene;
scene.globe.enableLighting = true;      // real sun-driven day/night terrain shading
scene.globe.depthTestAgainstTerrain = true;  // terrain occludes clouds/markers behind hills
scene.sun.show = true;
scene.moon.show = true;
scene.skyAtmosphere.show = true;
scene.globe.dynamicAtmosphereLighting = true;

// Start "live"
viewer.clock.shouldAnimate = true;
viewer.clock.multiplier = 1;

// Nice starting view
viewer.camera.flyTo({
  destination: Cesium.Cartesian3.fromDegrees(2.2945, 48.8584, 3_000_000),
  duration: 0,
});

// ---- Location marker + sun/moon arrows -------------------------------------
let selected = null;   // { lon, lat, height }
const marker = viewer.entities.add({
  position: new Cesium.CallbackProperty(() =>
    selected ? Cesium.Cartesian3.fromDegrees(selected.lon, selected.lat, selected.height) : undefined, false),
  point: { pixelSize: 12, color: Cesium.Color.WHITE, outlineColor: Cesium.Color.BLACK, outlineWidth: 2,
           disableDepthTestDistance: Number.POSITIVE_INFINITY },
  show: new Cesium.CallbackProperty(() => !!selected && !groundMode, false),
});

// Endpoints for the two direction arrows, recomputed each tick.
let sunTip = null, moonTip = null;
function arrow(color, tipGetter) {
  return viewer.entities.add({
    polyline: {
      positions: new Cesium.CallbackProperty(() => {
        if (!selected || fpsEnabled) return [];   // hidden in FPV mode
        const tip = tipGetter();
        if (!tip) return [];
        return [Cesium.Cartesian3.fromDegrees(selected.lon, selected.lat, selected.height), tip];
      }, false),
      width: 4, material: color, arcType: Cesium.ArcType.NONE,
    },
  });
}
arrow(Cesium.Color.fromCssColorString("#ffd166"), () => sunTip);
arrow(Cesium.Color.fromCssColorString("#a8c7ff"), () => moonTip);

// Given az (from north, rad) + alt (rad), return an ECEF point `dist` metres out.
function skyPoint(lon, lat, height, azFromNorth, alt, dist) {
  const east = Math.sin(azFromNorth) * Math.cos(alt);
  const north = Math.cos(azFromNorth) * Math.cos(alt);
  const up = Math.sin(alt);
  const origin = Cesium.Cartesian3.fromDegrees(lon, lat, height);
  const enu = Cesium.Transforms.eastNorthUpToFixedFrame(origin);
  const localDir = new Cesium.Cartesian3(east * dist, north * dist, up * dist);
  return Cesium.Matrix4.multiplyByPoint(enu, localDir, new Cesium.Cartesian3());
}

// ---- Click to place location ----------------------------------------------
const handler = new Cesium.ScreenSpaceEventHandler(scene.canvas);

function pickLonLat(windowPos) {
  const cartesian = scene.pickPosition(windowPos) ||
    viewer.camera.pickEllipsoid(windowPos, scene.globe.ellipsoid);
  if (!cartesian) return null;
  const c = Cesium.Cartographic.fromCartesian(cartesian);
  return { lon: Cesium.Math.toDegrees(c.longitude), lat: Cesium.Math.toDegrees(c.latitude), height: c.height || 0 };
}

// Single click places the location — except in FPV, where it does nothing.
handler.setInputAction((click) => {
  if (fpsEnabled) return;
  const p = pickLonLat(click.position);
  if (!p) return;
  selected = p;
  update();
  if (window.applyWeather) window.applyWeather();
}, Cesium.ScreenSpaceEventType.LEFT_CLICK);

// ---- Search: place name / address / coordinates ---------------------------
const searchInput = document.getElementById("search");
const searchBtn = document.getElementById("searchBtn");
const searchMsg = document.getElementById("searchMsg");

// Fly to a lon/lat, drop the pin, refresh the readout.
function goTo(lon, lat, label, height = 150000) {
  selected = { lon, lat, height: 0 };
  viewer.camera.flyTo({
    destination: Cesium.Cartesian3.fromDegrees(lon, lat, height),
    duration: 1.2,
  });
  if (label) searchMsg.textContent = label;
  update();
  if (window.applyWeather) window.applyWeather();
}

// Accept "48.85, 2.29" / "48.85 2.29" / "48.85N, 2.29E" → [lat, lon] or null.
function parseCoords(text) {
  const m = text.trim().match(
    /^\s*(-?\d+(?:\.\d+)?)\s*°?\s*([NSns])?\s*[, ]\s*(-?\d+(?:\.\d+)?)\s*°?\s*([EWew])?\s*$/
  );
  if (!m) return null;
  let lat = parseFloat(m[1]);
  let lon = parseFloat(m[3]);
  if (m[2] && /[Ss]/.test(m[2])) lat = -Math.abs(lat);
  if (m[4] && /[Ww]/.test(m[4])) lon = -Math.abs(lon);
  if (Math.abs(lat) > 90 || Math.abs(lon) > 180) return null;
  return [lat, lon];
}

async function doSearch() {
  const q = searchInput.value.trim();
  if (!q) return;

  const coords = parseCoords(q);
  if (coords) {
    goTo(coords[1], coords[0], `📍 ${coords[0].toFixed(4)}, ${coords[1].toFixed(4)}`);
    return;
  }

  searchMsg.textContent = "Searching…";
  try {
    // Try the full address, then drop the most-specific leading parts one at a
    // time (building/number → street → postcode → town) until something matches.
    const parts = q.split(",").map((s) => s.trim()).filter(Boolean);
    let hit = null;
    for (let start = 0; start < parts.length && !hit; start++) {
      hit = await geocode(parts.slice(start).join(", "));
    }
    if (!hit) { searchMsg.textContent = "No match found."; return; }
    goTo(parseFloat(hit.lon), parseFloat(hit.lat), "📍 " + hit.display_name);
  } catch (e) {
    searchMsg.textContent = "Search failed (offline?).";
  }
}

async function geocode(query) {
  const url = "https://nominatim.openstreetmap.org/search?format=json&limit=1&q=" +
    encodeURIComponent(query);
  const res = await fetch(url, { headers: { "Accept-Language": "en" } });
  const data = await res.json();
  return data[0] || null;
}
searchBtn.addEventListener("click", doSearch);
searchInput.addEventListener("keydown", (e) => { if (e.key === "Enter") doSearch(); });

// ---- Time controls ---------------------------------------------------------
const dtInput = document.getElementById("dt");
const liveBtn = document.getElementById("liveBtn");
const applyBtn = document.getElementById("applyBtn");
let liveMode = true;

// --- Timezone helpers: entered time = LOCAL time at the placed location ------
// IANA zone of the current pin (falls back to the browser's zone if no pin).
function currentTz() {
  if (selected) {
    try { return tzlookup(selected.lat, selected.lon); } catch (e) { /* ocean/poles */ }
  }
  return Intl.DateTimeFormat().resolvedOptions().timeZone;
}
// Offset (ms) of `tz` at the given UTC instant, DST-aware. local = utc + offset.
function tzOffsetMs(tz, utcMs) {
  const dtf = new Intl.DateTimeFormat("en-US", {
    timeZone: tz, hour12: false, year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit",
  });
  const p = {}; dtf.formatToParts(new Date(utcMs)).forEach((x) => (p[x.type] = x.value));
  const h = p.hour === "24" ? 0 : +p.hour;
  return Date.UTC(+p.year, p.month - 1, +p.day, h, +p.minute, +p.second) - utcMs;
}
// Wall-clock {y,mo,d,h,mi} in `tz` → absolute UTC Date.
function zonedToUtc(c, tz) {
  const guess = Date.UTC(c.y, c.mo - 1, c.d, c.h, c.mi);
  return new Date(guess - tzOffsetMs(tz, guess));
}
// Format a Date as an <input type=datetime-local> value in `tz`.
function toInputValue(date, tz) {
  const dtf = new Intl.DateTimeFormat("en-CA", {
    timeZone: tz, hour12: false, year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit",
  });
  const p = {}; dtf.formatToParts(date).forEach((x) => (p[x.type] = x.value));
  const h = p.hour === "24" ? "00" : p.hour;
  return `${p.year}-${p.month}-${p.day}T${h}:${p.minute}`;
}
function tzOffsetLabel(tz, date) {
  const min = Math.round(tzOffsetMs(tz, date.getTime()) / 60000);
  const sign = min >= 0 ? "+" : "−";
  const a = Math.abs(min);
  const hh = Math.floor(a / 60), mm = a % 60;
  return `UTC${sign}${hh}${mm ? ":" + String(mm).padStart(2, "0") : ""}`;
}

function setLive(on) {
  liveMode = on;
  liveBtn.textContent = on ? "● Live" : "○ Live";
  liveBtn.style.background = on ? "#dc2626" : "#2a3040";
  if (on) {
    // Track the real system clock.
    viewer.clock.clockStep = Cesium.ClockStep.SYSTEM_CLOCK;
    viewer.clock.shouldAnimate = true;
    viewer.clock.currentTime = Cesium.JulianDate.fromDate(new Date());
    speedSel.value = "1";
  } else {
    // Detach from the system clock — otherwise the next frame snaps the time
    // back to "now" and a set/Applied time won't stick.
    viewer.clock.clockStep = Cesium.ClockStep.SYSTEM_CLOCK_MULTIPLIER;
  }
}
liveBtn.addEventListener("click", () => setLive(!liveMode));

// Touching the date field means you're composing a time — leave Live and freeze
// so nothing overwrites what you type before you hit Apply.
dtInput.addEventListener("input", () => {
  if (liveMode) setLive(false);
  viewer.clock.shouldAnimate = false;
  speedSel.value = "0";
});

applyBtn.addEventListener("click", () => {
  if (!dtInput.value) return;
  const m = dtInput.value.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/);
  if (!m) return;
  setLive(false);
  // Interpret the entered wall-clock time in the PLACED LOCATION's timezone.
  const c = { y: +m[1], mo: +m[2], d: +m[3], h: +m[4], mi: +m[5] };
  // Freeze at that instant so it's a static preview (use Speed to play forward).
  viewer.clock.shouldAnimate = false;
  viewer.clock.currentTime = Cesium.JulianDate.fromDate(zonedToUtc(c, currentTz()));
  speedSel.value = "0";
  update();
  saveState();
  // The clock jumped, so the eclipse band must be redrawn for the new instant.
  if (window.recomputeEclipsePath) window.recomputeEclipsePath();
});

document.getElementById("speed").addEventListener("change", (e) => {
  const v = Number(e.target.value);
  viewer.clock.multiplier = v || 1;
  viewer.clock.shouldAnimate = v !== 0;
  // Any non-live playback must stay detached from the system clock.
  if (!liveMode) viewer.clock.clockStep = Cesium.ClockStep.SYSTEM_CLOCK_MULTIPLIER;
});

// If the user scrubs the Cesium timeline, drop out of live mode.
viewer.timeline.addEventListener("settime", () => setLive(false), false);

// ---- First-person "stand here" view ---------------------------------------
let groundMode = false;

// Free-look toggle: remap LEFT_DRAG to "look" (rotate camera in place) instead
// of the default orbit-the-globe behaviour — Street-View style.
const ssc = scene.screenSpaceCameraController;
const DEFAULT_ROTATE = ssc.rotateEventTypes;
const DEFAULT_TILT = ssc.tiltEventTypes;
const DEFAULT_LOOK = ssc.lookEventTypes;
const lookCheckbox = document.getElementById("lookmode");
const fpsHint = document.getElementById("fpsHint");
let fpsEnabled = false;
let eyeHeight = 1.8;   // metres above ground while walking

function setLookMode(on) {
  fpsEnabled = on;
  if (on) {
    ssc.lookEventTypes = Cesium.CameraEventType.LEFT_DRAG;      // drag = look around
    ssc.rotateEventTypes = [Cesium.CameraEventType.MIDDLE_DRAG]; // pan/orbit on middle
    ssc.tiltEventTypes = [Cesium.CameraEventType.RIGHT_DRAG];    // tilt on right
  } else {
    ssc.lookEventTypes = DEFAULT_LOOK;
    ssc.rotateEventTypes = DEFAULT_ROTATE;
    ssc.tiltEventTypes = DEFAULT_TILT;
  }
  fpsHint.style.display = on ? "block" : "none";
  if (lookCheckbox.checked !== on) lookCheckbox.checked = on;
}
lookCheckbox.addEventListener("change", (e) => setLookMode(e.target.checked));

// --- WASD walk/fly movement (active only in FPS mode) -----------------------
const keys = Object.create(null);
const MOVE_KEYS = new Set(["w","a","s","d","c"," ","shift"]);
window.addEventListener("keydown", (e) => {
  const k = e.key.toLowerCase();
  if (!fpsEnabled || !MOVE_KEYS.has(k)) return;
  if (e.target.tagName === "INPUT" || e.target.tagName === "SELECT") return;
  keys[k] = true;
  e.preventDefault();   // stop Space from scrolling the page
});
window.addEventListener("keyup", (e) => { keys[e.key.toLowerCase()] = false; });
// Drop all keys if the window loses focus (avoids "stuck" movement).
window.addEventListener("blur", () => { for (const k in keys) keys[k] = false; });

const _n = new Cesium.Cartesian3(), _fwd = new Cesium.Cartesian3(),
      _right = new Cesium.Cartesian3(), _tmp = new Cesium.Cartesian3();
let _lastMs = null;

function fpsTick() {
  if (!fpsEnabled) { _lastMs = null; return; }
  const nowMs = performance.now();
  if (_lastMs === null) { _lastMs = nowMs; return; }
  const dt = Math.min(0.1, (nowMs - _lastMs) / 1000);   // clamp to avoid big jumps
  _lastMs = nowMs;

  const cam = viewer.camera;
  const fwdIn = keys["w"] ? 1 : 0, backIn = keys["s"] ? 1 : 0;
  const leftIn = keys["a"] ? 1 : 0, rightIn = keys["d"] ? 1 : 0;
  const upIn = keys[" "] ? 1 : 0, downIn = keys["c"] ? 1 : 0;
  if (!(fwdIn || backIn || leftIn || rightIn || upIn || downIn)) return;

  const speed = (keys["shift"] ? 120 : 22) * dt;         // m/s (sprint ~5×)
  const up = scene.globe.ellipsoid.geodeticSurfaceNormal(cam.position, _n);

  // Horizontal forward = view direction with the vertical component removed.
  Cesium.Cartesian3.clone(cam.direction, _fwd);
  Cesium.Cartesian3.subtract(_fwd,
    Cesium.Cartesian3.multiplyByScalar(up, Cesium.Cartesian3.dot(_fwd, up), _tmp), _fwd);
  if (Cesium.Cartesian3.magnitude(_fwd) < 1e-6) Cesium.Cartesian3.clone(cam.right, _fwd);
  Cesium.Cartesian3.normalize(_fwd, _fwd);
  Cesium.Cartesian3.normalize(Cesium.Cartesian3.cross(_fwd, up, _right), _right);

  const move = new Cesium.Cartesian3();
  Cesium.Cartesian3.multiplyByScalar(_fwd, (fwdIn - backIn) * speed, _tmp);
  Cesium.Cartesian3.add(move, _tmp, move);
  Cesium.Cartesian3.multiplyByScalar(_right, (rightIn - leftIn) * speed, _tmp);
  Cesium.Cartesian3.add(move, _tmp, move);
  Cesium.Cartesian3.multiplyByScalar(up, (upIn - downIn) * speed, _tmp);
  Cesium.Cartesian3.add(move, _tmp, move);
  Cesium.Cartesian3.add(cam.position, move, cam.position);

  // Keep eye height above the ground unless flying vertically.
  if (!upIn && !downIn) {
    const carto = Cesium.Cartographic.fromCartesian(cam.position);
    const gh = scene.globe.getHeight(carto);
    if (Cesium.defined(gh)) {
      carto.height = gh + eyeHeight;
      Cesium.Cartographic.toCartesian(carto, scene.globe.ellipsoid, cam.position);
    }
  }
}
scene.preUpdate.addEventListener(fpsTick);

async function terrainHeightAt(lon, lat) {
  try {
    const s = await Cesium.sampleTerrainMostDetailed(
      viewer.terrainProvider, [Cesium.Cartographic.fromDegrees(lon, lat)]);
    return s[0].height || 0;
  } catch (e) { return 0; }
}

async function standHere() {
  if (!selected) { alert("Pick a location first (search or click the globe)."); return; }
  const { lon, lat } = selected;
  const ground = await terrainHeightAt(lon, lat);
  const eyeH = ground + 1.8;                      // ~human eye height above ground

  // Look toward whichever body is higher (sun by default), so it's framed in the sky.
  const now = Cesium.JulianDate.toDate(viewer.clock.currentTime);
  const sun = SunCalc.getPosition(now, lat, lon);
  const moon = SunCalc.getMoonPosition(now, lat, lon);
  const body = sun.altitude >= moon.altitude ? sun : moon;
  const heading = body.azimuth + Math.PI;         // from-north, clockwise (Cesium heading)
  const pitch = Cesium.Math.clamp(body.altitude, -0.25, 1.3);  // look up at it

  groundMode = true;
  setLookMode(true);                                // Street-View style look-around
  viewer.camera.flyTo({
    destination: Cesium.Cartesian3.fromDegrees(lon, lat, eyeH),
    orientation: { heading, pitch, roll: 0 },
    duration: 1.5,
  });
}

function orbitView() {
  groundMode = false;
  setLookMode(false);                               // back to orbit-the-globe controls
  if (!selected) return;
  viewer.camera.flyTo({
    destination: Cesium.Cartesian3.fromDegrees(selected.lon, selected.lat, 12000),
    orientation: { heading: 0, pitch: Cesium.Math.toRadians(-45), roll: 0 },
    duration: 1.5,
  });
}

// Reset to a straight-down, north-up map view over the location.
function topView() {
  groundMode = false;
  setLookMode(false);
  followChk.checked = false;
  const lon = selected ? selected.lon : Cesium.Math.toDegrees(viewer.camera.positionCartographic.longitude);
  const lat = selected ? selected.lat : Cesium.Math.toDegrees(viewer.camera.positionCartographic.latitude);
  viewer.camera.flyTo({
    destination: Cesium.Cartesian3.fromDegrees(lon, lat, 2_000_000),
    orientation: { heading: 0, pitch: Cesium.Math.toRadians(-90), roll: 0 },
    duration: 1.2,
  });
  saveState();
}

document.getElementById("standBtn").addEventListener("click", standHere);
document.getElementById("orbitBtn").addEventListener("click", orbitView);
document.getElementById("topBtn").addEventListener("click", topView);

// Double-click teleports (moves the location + camera to the clicked spot).
// In FPV we keep the current look direction; otherwise we just re-place the pin.
async function teleportTo(lon, lat) {
  selected = { lon, lat, height: 0 };
  if (fpsEnabled) {
    const ground = await terrainHeightAt(lon, lat);
    const cam = viewer.camera;
    cam.setView({
      destination: Cesium.Cartesian3.fromDegrees(lon, lat, ground + eyeHeight),
      orientation: { heading: cam.heading, pitch: cam.pitch, roll: cam.roll },
    });
  }
  update();
  saveState();
  if (window.applyWeather) window.applyWeather();
}
// Suppress Cesium's built-in double-click (entity tracking) so ours is clean.
viewer.screenSpaceEventHandler.removeInputAction(Cesium.ScreenSpaceEventType.LEFT_DOUBLE_CLICK);
handler.setInputAction((click) => {
  const p = pickLonLat(click.position);
  if (p) teleportTo(p.lon, p.lat);
}, Cesium.ScreenSpaceEventType.LEFT_DOUBLE_CLICK);

// ---- 3D buildings (Cesium OSM Buildings — needs the ion token) -------------
let osmBuildings = null;
document.getElementById("buildings").addEventListener("change", async (e) => {
  if (e.target.checked) {
    if (!hasIonToken) {
      alert("3D buildings need a Cesium ion token (already set) — reload if you just added it.");
      e.target.checked = false; return;
    }
    if (!osmBuildings) {
      try { osmBuildings = await Cesium.createOsmBuildingsAsync(); scene.primitives.add(osmBuildings); }
      catch (err) { alert("Could not load 3D buildings: " + err); e.target.checked = false; return; }
    }
    osmBuildings.show = true;
  } else if (osmBuildings) {
    osmBuildings.show = false;
  }
});

// ---- Readout ---------------------------------------------------------------
const $ = (id) => document.getElementById(id);
const R2D = 180 / Math.PI;
const PHASES = ["New moon","Waxing crescent","First quarter","Waxing gibbous",
                "Full moon","Waning gibbous","Last quarter","Waning crescent"];
function phaseName(p) { // p in [0,1)
  return PHASES[Math.round(p * 8) % 8];
}
function fmtDeg(rad) { return (rad * R2D).toFixed(1) + "°"; }
function fmtAz(azFromNorth) {
  const d = ((azFromNorth * R2D) % 360 + 360) % 360;
  const dirs = ["N","NE","E","SE","S","SW","W","NW"];
  return d.toFixed(0) + "° " + dirs[Math.round(d / 45) % 8];
}
function fmtTime(date, tz) {
  if (!date || isNaN(date)) return "—";
  return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", timeZone: tz });
}

function update() {
  const now = Cesium.JulianDate.toDate(viewer.clock.currentTime);
  const tz = currentTz();

  // Reflect the sim time in the input (in the location's zone) only while the
  // clock is actually running — never clobber a value the user is entering.
  if (!dtInput.matches(":focus") && (liveMode || viewer.clock.shouldAnimate))
    dtInput.value = toInputValue(now, tz);

  if (!selected) { sunTip = moonTip = null; return; }
  const { lon, lat, height } = selected;

  const sun = SunCalc.getPosition(now, lat, lon);       // az from south, alt
  const moon = SunCalc.getMoonPosition(now, lat, lon);
  const sunAzN = sun.azimuth + Math.PI;                 // convert to from-north
  const moonAzN = moon.azimuth + Math.PI;

  // Arrow tips (length scales with view so they stay visible)
  const dist = Math.max(200_000, viewer.camera.positionCartographic.height * 0.25);
  sunTip = skyPoint(lon, lat, height, sunAzN, sun.altitude, dist);
  moonTip = skyPoint(lon, lat, height, moonAzN, moon.altitude, dist);

  // Panel
  $("loc").textContent = `${lat.toFixed(4)}, ${lon.toFixed(4)}`;
  $("localtime").textContent =
    now.toLocaleString([], { timeZone: tz, dateStyle: "medium", timeStyle: "short" }) +
    "  " + tzOffsetLabel(tz, now);

  $("sunAz").textContent = fmtAz(sunAzN);
  $("sunEl").textContent = fmtDeg(sun.altitude);
  $("sunUp").textContent = sun.altitude > 0 ? "up" : "down";
  const st = SunCalc.getTimes(now, lat, lon);
  $("sunrise").textContent = fmtTime(st.sunrise, tz);
  $("sunset").textContent = fmtTime(st.sunset, tz);

  $("moonAz").textContent = fmtAz(moonAzN);
  $("moonEl").textContent = fmtDeg(moon.altitude);
  $("moonUp").textContent = moon.altitude > 0 ? "up" : "down";
  const illum = SunCalc.getMoonIllumination(now);
  $("moonPhase").textContent = phaseName(illum.phase);
  $("moonIllum").textContent = (illum.fraction * 100).toFixed(0) + "%";

  // Eclipse realism: normally the sun is a big glare, but as the moon closes in
  // on it, shrink the sun's glow so the (true-size) moon disc can cover it, and
  // darken the sky near totality — mimicking the real experience.
  const sep = Math.acos(Cesium.Math.clamp(
    Math.sin(sun.altitude) * Math.sin(moon.altitude) +
    Math.cos(sun.altitude) * Math.cos(moon.altitude) * Math.cos(sunAzN - moonAzN),
    -1, 1)) * R2D;                                    // sun–moon angular separation (°)
  const t = Cesium.Math.clamp((sep - 0.6) / (2.5 - 0.6), 0, 1);  // 0 = eclipse, 1 = far apart
  // Combine eclipse dimming with weather (clouds) dimming from weather.js.
  const wxGlow = window.wxGlowMul ?? 1, wxDim = window.wxSkyDim ?? 0;
  scene.sun.glowFactor = (0.02 + t * (1 - 0.02)) * wxGlow;       // ~0 during totality / overcast
  scene.skyAtmosphere.brightnessShift = Math.min(-0.85 * (1 - t), wxDim);  // dusk near totality
  $("sunMoonSep").textContent = sep.toFixed(2) + "°" +
    (sep < 0.55 ? " — eclipse!" : sep < 1.5 ? " — near" : "");

  // Camera follow: lock the view onto the chosen body each frame.
  const fm = followMode();
  if (fm !== "off") {
    const cam = viewer.camera;
    cam.setView({
      destination: Cesium.Cartesian3.clone(cam.position, new Cesium.Cartesian3()),
      orientation: {
        heading: fm === "moon" ? moonAzN : sunAzN,
        pitch: Cesium.Math.clamp(fm === "moon" ? moon.altitude : sun.altitude, -1.5, 1.5),
        roll: 0,
      },
    });
  }
}

// Drive everything off the clock so sky + numbers stay in sync.
viewer.clock.onTick.addEventListener(update);

// ---- Camera follow controls ------------------------------------------------
const followChk = document.getElementById("follow");
const followSel = document.getElementById("followBody");
function followMode() { return followChk.checked ? followSel.value : "off"; }
followChk.addEventListener("change", () => { saveState(); update(); });
followSel.addEventListener("change", () => { saveState(); update(); });

// ---- Persistence (localStorage) -------------------------------------------
const STORE_KEY = "moonsun.earth.state.v1";
const speedSel = document.getElementById("speed");
const buildingsChk = document.getElementById("buildings");
const eclipsePathChk = document.getElementById("eclipsePath");
const readoutEl = document.getElementById("readout");

// The complete snapshot of "where/when/how you're looking" — shared by the
// autosave above and by named bookmarks below, so the two can never drift.
function captureState() {
  const c = viewer.camera;
  const carto = c.positionCartographic;
  return {
    selected, groundMode,
    live: liveMode,
    timeISO: Cesium.JulianDate.toDate(viewer.clock.currentTime).toISOString(),
    dt: dtInput.value,
    speed: speedSel.value,
    buildings: buildingsChk.checked,
    eclipsePath: eclipsePathChk.checked,
    fps: fpsEnabled,
    follow: followChk.checked,
    followBody: followSel.value,
    search: searchInput.value,
    searchMsg: searchMsg.textContent,
    detailsOpen: readoutEl.open,
    cam: {
      lon: Cesium.Math.toDegrees(carto.longitude),
      lat: Cesium.Math.toDegrees(carto.latitude),
      height: carto.height,
      heading: c.heading, pitch: c.pitch, roll: c.roll,
    },
  };
}

function saveState() {
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify(captureState()));
  } catch (e) { /* storage unavailable / private mode */ }
}

function applyState(s) {
  if (!s) return false;

  selected = s.selected || null;
  groundMode = !!s.groundMode;
  if (s.search) searchInput.value = s.search;
  if (s.searchMsg) searchMsg.textContent = s.searchMsg;
  if (typeof s.detailsOpen === "boolean") readoutEl.open = s.detailsOpen;

  // Params — set value then fire change so side effects (multiplier) run.
  if (s.speed !== undefined) { speedSel.value = s.speed; speedSel.dispatchEvent(new Event("change")); }
  if (s.buildings && hasIonToken) { buildingsChk.checked = true; buildingsChk.dispatchEvent(new Event("change")); }
  if (eclipsePathChk.checked !== !!s.eclipsePath) {
    eclipsePathChk.checked = !!s.eclipsePath;
    eclipsePathChk.dispatchEvent(new Event("change"));   // draws/clears the band
  }
  if (s.followBody) followSel.value = s.followBody;
  followChk.checked = !!s.follow;
  setLookMode(!!s.fps);

  // Time
  if (s.live) {
    setLive(true);
  } else {
    setLive(false);
    if (s.timeISO) viewer.clock.currentTime = Cesium.JulianDate.fromDate(new Date(s.timeISO));
    if (s.dt) dtInput.value = s.dt;
  }

  // Camera view
  if (s.cam) {
    viewer.camera.setView({
      destination: Cesium.Cartesian3.fromDegrees(s.cam.lon, s.cam.lat, s.cam.height),
      orientation: { heading: s.cam.heading, pitch: s.cam.pitch, roll: s.cam.roll },
    });
  }
  return true;
}

function restoreState() {
  let s;
  try { s = JSON.parse(localStorage.getItem(STORE_KEY)); } catch (e) { return false; }
  return applyState(s);
}

// Save on control changes, when the camera settles, periodically, and on exit.
[speedSel, buildingsChk, eclipsePathChk, lookCheckbox].forEach((el) =>
  el.addEventListener("change", saveState));
readoutEl.addEventListener("toggle", saveState);
scene.camera.moveEnd.addEventListener(saveState);
setInterval(saveState, 2000);                 // captures ongoing time/FPV movement
window.addEventListener("beforeunload", saveState);

// ---- Bookmarks -------------------------------------------------------------
// Named snapshots of the full app state (location, camera, date/time, settings).
const BOOKMARKS_KEY = "moonsun.earth.bookmarks.v1";
const bmName = document.getElementById("bmName");
const bmSaveBtn = document.getElementById("bmSaveBtn");
const bmList = document.getElementById("bmList");
const bmEmpty = document.getElementById("bmEmpty");

function loadBookmarks() {
  try { return JSON.parse(localStorage.getItem(BOOKMARKS_KEY)) || []; } catch (e) { return []; }
}
function storeBookmarks(list) {
  try {
    localStorage.setItem(BOOKMARKS_KEY, JSON.stringify(list));
    return true;
  } catch (e) {
    searchMsg.textContent = "Couldn't save bookmark (storage full or unavailable).";
    return false;
  }
}

// A default name beats making the user think: the place, else the coordinates.
function suggestName() {
  const s = searchInput.value.trim();
  if (s) return s;
  if (selected) return `${selected.lat.toFixed(3)}, ${selected.lon.toFixed(3)}`;
  return "Untitled view";
}

function describe(bm) {
  const place = bm.state.search || (bm.state.selected
    ? `${bm.state.selected.lat.toFixed(2)}, ${bm.state.selected.lon.toFixed(2)}`
    : "No location");
  if (bm.state.live) return `${place} · live`;
  // dt holds the location's local time — the same convention as the date field.
  if (bm.state.dt) return `${place} · ${bm.state.dt.replace("T", " ")}`;
  const d = new Date(bm.state.timeISO);
  return `${place} · ${isNaN(d) ? "—" : d.toISOString().slice(0, 16).replace("T", " ") + "Z"}`;
}

function renderBookmarks() {
  const list = loadBookmarks();
  bmList.textContent = "";
  bmEmpty.style.display = list.length ? "none" : "block";

  for (const bm of list) {
    const row = document.createElement("div");
    row.className = "bmrow";

    const go = document.createElement("button");
    go.className = "bmgo";
    go.title = "Restore this view";
    go.innerHTML = `<span class="bmlabel"></span><span class="bmmeta"></span>`;
    // textContent, not innerHTML — bookmark names are user input.
    go.querySelector(".bmlabel").textContent = bm.name;
    go.querySelector(".bmmeta").textContent = describe(bm);
    go.addEventListener("click", () => {
      applyState(bm.state);
      update();
      saveState();
      if (window.applyWeather) window.applyWeather();
      if (window.recomputeEclipsePath) window.recomputeEclipsePath();
    });

    const del = document.createElement("button");
    del.className = "bmdel";
    del.title = "Delete bookmark";
    del.textContent = "✕";
    del.addEventListener("click", () => {
      if (!confirm(`Delete bookmark “${bm.name}”?`)) return;
      storeBookmarks(loadBookmarks().filter((b) => b.id !== bm.id));
      renderBookmarks();
    });

    row.append(go, del);
    bmList.append(row);
  }
}

function saveBookmark() {
  const name = (bmName.value.trim() || suggestName()).slice(0, 60);
  const list = loadBookmarks();
  const existing = list.find((b) => b.name.toLowerCase() === name.toLowerCase());
  if (existing && !confirm(`“${name}” already exists. Overwrite it?`)) return;

  const entry = { id: existing ? existing.id : String(Date.now()), name, state: captureState() };
  if (existing) list[list.indexOf(existing)] = entry;
  else list.unshift(entry);

  if (!storeBookmarks(list)) return;
  bmName.value = "";
  renderBookmarks();
}

bmSaveBtn.addEventListener("click", saveBookmark);
bmName.addEventListener("keydown", (e) => { if (e.key === "Enter") saveBookmark(); });
bmName.addEventListener("focus", () => { bmName.placeholder = suggestName(); });
renderBookmarks();

// ---- Initialise ------------------------------------------------------------
if (!restoreState()) setLive(true);
update();
