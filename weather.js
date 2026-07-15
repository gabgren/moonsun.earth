/* MoonSun.Earth — Weather layer: 3D clouds, haze/fog, sun dimming.
 * Reuses the globals `viewer`, `scene`, `selected` from app.js (classic scripts
 * share the global scope). Live/forecast + climatology via Open-Meteo (no key). */
(() => {
  const $ = (id) => document.getElementById(id);
  const veil = $("wxVeil");
  const els = {
    low: $("wxLow"), mid: $("wxMid"), high: $("wxHigh"), vis: $("wxVis"), haze: $("wxHaze"),
    lowV: $("wxLowV"), midV: $("wxMidV"), highV: $("wxHighV"), visV: $("wxVisV"), hazeV: $("wxHazeV"),
    msg: $("wxMsg"),
  };
  const WX_KEY = "moonsun.earth.weather.v1";
  const msg = (t) => { els.msg.textContent = t; };

  // Procedural cumulus clouds. One layer per cloud level, scattered on a jittered
  // grid around the location; the fraction of filled cells = coverage.
  const clouds = scene.primitives.add(new Cesium.CloudCollection({ noiseDetail: 16 }));
  const LAYERS = [
    { key: "low",  alt: 1200, spread: 14000, size: 1100, grid: 9 },
    { key: "mid",  alt: 4200, spread: 24000, size: 2000, grid: 9 },
    { key: "high", alt: 8500, spread: 36000, size: 3200, grid: 7 },
  ];

  const state = () => ({
    low: +els.low.value, mid: +els.mid.value, high: +els.high.value,
    vis: +els.vis.value, haze: +els.haze.value,
  });

  function rebuildClouds() {
    clouds.removeAll();
    if (!selected) return;
    const { lon, lat } = selected;
    const st = state();
    const mLat = 111320, mLon = 111320 * Math.cos(lat * Math.PI / 180);
    for (const L of LAYERS) {
      const cov = st[L.key] / 100;
      if (cov <= 0) continue;
      const n = L.grid;
      for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) {
        if (Math.random() > cov) continue;
        const fx = (i / (n - 1) - 0.5) * 2, fy = (j / (n - 1) - 0.5) * 2;
        const jx = (Math.random() - 0.5) / n, jy = (Math.random() - 0.5) / n;
        const dx = (fx + jx) * L.spread, dy = (fy + jy) * L.spread;
        const s = L.size * (0.6 + Math.random() * 0.8);
        clouds.add({
          position: Cesium.Cartesian3.fromDegrees(lon + dx / mLon, lat + dy / mLat, L.alt),
          scale: new Cesium.Cartesian2(s, s * 0.55),
          maximumSize: new Cesium.Cartesian3(s * 0.5, s * 0.3, s * 0.5),
          slice: 0.36, brightness: 1.0,
        });
      }
    }
  }

  // Atmospheric effects. Values shared with app.js's update() via window globals
  // so they combine with the eclipse dimming rather than fight it.
  function applyEffects() {
    const st = state();
    const overcast = Math.max(st.low, st.mid * 0.9, st.high * 0.7) / 100;  // low clouds block most
    const hz = st.haze / 100;
    const alpha = Math.min(0.9, overcast * 0.8 + hz * 0.35);
    const r = 205 - hz * 45, g = 208 - hz * 30, b = 215 - hz * 8;          // haze → duller/warmer
    veil.style.background = `rgba(${r | 0},${g | 0},${b | 0},${alpha.toFixed(3)})`;

    scene.fog.enabled = true;
    scene.fog.density = Cesium.Math.clamp(0.0004 * (30 / st.vis), 5e-5, 0.02);
    scene.skyAtmosphere.saturationShift = -hz * 0.5;

    window.wxGlowMul = Math.max(0, 1 - overcast * 0.95);   // clouds hide the sun's glow
    window.wxSkyDim = -0.5 * overcast;                     // darken sky under thick cloud
    scene.light = new Cesium.SunLight({ intensity: 2.0 * (1 - overcast * 0.7) });
  }

  function syncLabels() {
    els.lowV.textContent = els.low.value + "%";
    els.midV.textContent = els.mid.value + "%";
    els.highV.textContent = els.high.value + "%";
    els.visV.textContent = els.vis.value + " km";
    els.hazeV.textContent = els.haze.value;
  }

  function apply(rebuild = true) {
    syncLabels();
    if (rebuild) rebuildClouds();
    applyEffects();
    save();
  }
  window.applyWeather = () => apply(true);   // called by app.js on location change

  [els.low, els.mid, els.high].forEach((e) => e.addEventListener("input", () => apply(true)));
  [els.vis, els.haze].forEach((e) => e.addEventListener("input", () => apply(false)));

  // ---- Data: Open-Meteo (no key) --------------------------------------------
  const isoDate = (d) => d.toISOString().slice(0, 10);
  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
  function hourIndex(times, date) {              // nearest hour on the target UTC day
    const target = date.getUTCHours() + date.getUTCMinutes() / 60;
    let best = 0, bd = Infinity;
    for (let i = 0; i < times.length; i++) {
      const dd = Math.abs(+times[i].slice(11, 13) - target);
      if (dd < bd) { bd = dd; best = i; }
    }
    return best;
  }

  async function fetchLive() {
    if (!selected) { msg("Pick a location first."); return; }
    const { lat, lon } = selected;
    const now = Cesium.JulianDate.toDate(viewer.clock.currentTime);
    const ymd = isoDate(now);
    msg("Fetching forecast…");
    try {
      const u = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}` +
        `&hourly=cloud_cover_low,cloud_cover_mid,cloud_cover_high,visibility&start_date=${ymd}&end_date=${ymd}&timezone=UTC`;
      const d = await (await fetch(u)).json();
      if (!d.hourly) { msg("No forecast for that date (only ~16 days out). Use Manual/Climatology."); return; }
      const i = hourIndex(d.hourly.time, now);
      els.low.value = Math.round(d.hourly.cloud_cover_low[i] ?? 0);
      els.mid.value = Math.round(d.hourly.cloud_cover_mid[i] ?? 0);
      els.high.value = Math.round(d.hourly.cloud_cover_high[i] ?? 0);
      els.vis.value = clamp(Math.round((d.hourly.visibility[i] ?? 40000) / 1000), 1, 60);
      try {
        const au = `https://air-quality-api.open-meteo.com/v1/air-quality?latitude=${lat}&longitude=${lon}` +
          `&hourly=aerosol_optical_depth&start_date=${ymd}&end_date=${ymd}&timezone=UTC`;
        const ad = await (await fetch(au)).json();
        if (ad.hourly) {
          const aod = ad.hourly.aerosol_optical_depth[hourIndex(ad.hourly.time, now)] || 0;
          els.haze.value = clamp(Math.round(aod * 120), 0, 100);
        }
      } catch (e) { /* aerosols optional */ }
      apply(true);
      msg(`Forecast for ${ymd} ${String(now.getUTCHours()).padStart(2, "0")}:00 UTC loaded.`);
    } catch (e) { msg("Fetch failed (offline?)."); }
  }

  async function fetchClimatology() {
    if (!selected) { msg("Pick a location first."); return; }
    const { lat, lon } = selected;
    const now = Cesium.JulianDate.toDate(viewer.clock.currentTime);
    const mm = String(now.getUTCMonth() + 1).padStart(2, "0");
    const dd = String(now.getUTCDate()).padStart(2, "0");
    const hr = now.getUTCHours();
    const lastYear = new Date().getUTCFullYear() - 1;
    const years = [];
    for (let y = lastYear - 9; y <= lastYear; y++) years.push(y);
    msg("Fetching 10-year climatology…");
    try {
      const results = await Promise.all(years.map(async (y) => {
        const u = `https://archive-api.open-meteo.com/v1/archive?latitude=${lat}&longitude=${lon}` +
          `&start_date=${y}-${mm}-${dd}&end_date=${y}-${mm}-${dd}&hourly=cloud_cover&timezone=UTC`;
        try {
          const d = await (await fetch(u)).json();
          const arr = d.hourly && d.hourly.cloud_cover;
          if (!arr) return null;
          return arr[Math.min(hr, arr.length - 1)];
        } catch (e) { return null; }
      }));
      const cov = results.filter((v) => v != null);
      if (!cov.length) { msg("No historical data available here."); return; }
      const avg = Math.round(cov.reduce((a, b) => a + b, 0) / cov.length);
      const clear = cov.filter((c) => c < 25).length;
      els.low.value = Math.round(avg * 0.6);
      els.mid.value = Math.round(avg * 0.3);
      els.high.value = Math.round(avg * 0.4);
      apply(true);
      msg(`~${avg}% avg cloud on ${mm}/${dd} @${String(hr).padStart(2, "0")}h · ${clear}/${cov.length} yrs mostly clear.`);
    } catch (e) { msg("Climatology fetch failed."); }
  }

  $("wxLive").addEventListener("click", fetchLive);
  $("wxClim").addEventListener("click", fetchClimatology);

  // ---- Persistence -----------------------------------------------------------
  function save() { try { localStorage.setItem(WX_KEY, JSON.stringify(state())); } catch (e) {} }
  function restore() {
    try {
      const s = JSON.parse(localStorage.getItem(WX_KEY));
      if (!s) return;
      els.low.value = s.low; els.mid.value = s.mid; els.high.value = s.high;
      els.vis.value = s.vis; els.haze.value = s.haze;
    } catch (e) {}
  }
  restore();
  apply(true);
})();
