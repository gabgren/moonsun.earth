/* MoonSun.Earth — Eclipse path of totality.
 * Traces the Moon's umbral shadow across the Earth from Cesium's own Sun/Moon
 * ephemeris: shadow axis ∩ ellipsoid = centre line; shadow-cone geometry = band
 * width; plus a live shadow spot that follows the clock. Reuses app.js globals. */
(() => {
  const ds = new Cesium.CustomDataSource("eclipsePath");
  viewer.dataSources.add(ds);
  const chk = document.getElementById("eclipsePath");
  const ell = scene.globe.ellipsoid;
  const R2D = Cesium.Math.toDegrees, D2R = Cesium.Math.toRadians;
  const R_SUN = 6.96e8, R_MOON = 1.7374e6;   // metres

  // ICRF→fixed (fall back to the pseudo-fixed approximation if EOP data absent).
  const toFixed = (jd) =>
    Cesium.Transforms.computeIcrfToFixedMatrix(jd) ||
    Cesium.Transforms.computeTemeToPseudoFixedMatrix(jd);

  // Sun & Moon in Earth-fixed (ECEF) metres at a Julian date.
  function bodies(jd) {
    const m = toFixed(jd);
    if (!m) return null;
    const sunI = Cesium.Simon1994PlanetaryPositions.computeSunPositionInEarthInertialFrame(jd);
    const moonI = Cesium.Simon1994PlanetaryPositions.computeMoonPositionInEarthInertialFrame(jd);
    return {
      sun: Cesium.Matrix3.multiplyByVector(m, sunI, new Cesium.Cartesian3()),
      moon: Cesium.Matrix3.multiplyByVector(m, moonI, new Cesium.Cartesian3()),
    };
  }

  // Where the shadow axis (Sun→Moon, continued) meets the Earth, + band geometry.
  function shadowCenter(jd) {
    const b = bodies(jd);
    if (!b) return null;
    const dir = Cesium.Cartesian3.normalize(
      Cesium.Cartesian3.subtract(b.moon, b.sun, new Cesium.Cartesian3()), new Cesium.Cartesian3());
    const iv = Cesium.IntersectionTests.rayEllipsoid(new Cesium.Ray(b.moon, dir), ell);
    if (!iv) return null;                                  // axis misses Earth → partial only
    const hit = Cesium.Ray.getPoint(new Cesium.Ray(b.moon, dir), iv.start, new Cesium.Cartesian3());
    const carto = ell.cartesianToCartographic(hit);
    if (!carto) return null;

    const Dm = Cesium.Cartesian3.distance(b.moon, hit);
    const Dsm = Cesium.Cartesian3.distance(b.sun, b.moon);
    const L = R_MOON * Dsm / (R_SUN - R_MOON);             // umbra cone length from Moon
    const rUmbra = R_MOON * (1 - Dm / L);                  // perp. shadow radius (<0 = annular)

    // Sun altitude at the centre point (grazing sun widens the ground band).
    const up = ell.geodeticSurfaceNormal(hit, new Cesium.Cartesian3());
    const toSun = Cesium.Cartesian3.normalize(
      Cesium.Cartesian3.subtract(b.sun, hit, new Cesium.Cartesian3()), new Cesium.Cartesian3());
    const alt = Math.asin(Cesium.Math.clamp(Cesium.Cartesian3.dot(up, toSun), -1, 1));

    return {
      lon: R2D(carto.longitude), lat: R2D(carto.latitude),
      rUmbra, alt, hit,
      halfW: Math.min(400000, Math.abs(rUmbra) / Math.max(0.03, Math.sin(alt))),  // metres
    };
  }

  // Geodesic helpers (spherical) for offsetting the limits perpendicular to track.
  const bearing = (a, b) => {
    const φ1 = D2R(a.lat), φ2 = D2R(b.lat), Δλ = D2R(b.lon - a.lon);
    return Math.atan2(Math.sin(Δλ) * Math.cos(φ2),
      Math.cos(φ1) * Math.sin(φ2) - Math.sin(φ1) * Math.cos(φ2) * Math.cos(Δλ));
  };
  const dest = (lat, lon, brg, d) => {
    const R = 6371000, δ = d / R, φ1 = D2R(lat), λ1 = D2R(lon);
    const φ2 = Math.asin(Math.sin(φ1) * Math.cos(δ) + Math.cos(φ1) * Math.sin(δ) * Math.cos(brg));
    const λ2 = λ1 + Math.atan2(Math.sin(brg) * Math.sin(δ) * Math.cos(φ1),
      Math.cos(δ) - Math.sin(φ1) * Math.sin(φ2));
    return { lat: R2D(φ2), lon: R2D(λ2) };
  };

  let umbraEntity = null;

  async function drawPath(centerJD) {
    // Load precise Earth-orientation (ICRF↔fixed) data for the eclipse window so
    // the shadow geometry uses the real rotation, not the coarse fallback.
    try {
      await Cesium.Transforms.preloadIcrfFixed(new Cesium.TimeInterval({
        start: Cesium.JulianDate.addDays(centerJD, -1, new Cesium.JulianDate()),
        stop: Cesium.JulianDate.addDays(centerJD, 1, new Cesium.JulianDate()),
      }));
    } catch (e) { /* falls back to the approximate frame */ }

    ds.entities.removeAll();
    umbraEntity = null;

    const pts = [];
    for (let dm = -210; dm <= 210; dm += 1) {              // march ±3.5 h at 1-min steps
      const c = shadowCenter(Cesium.JulianDate.addMinutes(centerJD, dm, new Cesium.JulianDate()));
      if (c && c.alt > D2R(1)) pts.push(c);
    }
    if (pts.length < 2) {
      chk.checked = false;
      alert("No total/annular eclipse track near this date & time.\n" +
            "Tip: use “Jump to max eclipse”, then enable this.");
      return;
    }

    const center = [], north = [], south = [];
    for (let i = 0; i < pts.length; i++) {
      const brg = bearing(pts[Math.max(0, i - 1)], pts[Math.min(pts.length - 1, i + 1)]);
      const p = pts[i];
      center.push(p.lon, p.lat);
      const n = dest(p.lat, p.lon, brg - Math.PI / 2, p.halfW);
      const s = dest(p.lat, p.lon, brg + Math.PI / 2, p.halfW);
      north.push(n.lon, n.lat); south.push(s.lon, s.lat);
    }

    // Shaded band (northern edge → southern edge reversed).
    const ring = north.slice();
    for (let i = south.length - 2; i >= 0; i -= 2) ring.push(south[i], south[i + 1]);
    ds.entities.add({ polygon: {
      hierarchy: Cesium.Cartesian3.fromDegreesArray(ring),
      material: Cesium.Color.BLACK.withAlpha(0.35), classificationType: Cesium.ClassificationType.BOTH,
    } });
    const line = (arr, color, w) => ds.entities.add({ polyline: {
      positions: Cesium.Cartesian3.fromDegreesArray(arr), width: w, material: color, clampToGround: true,
    } });
    line(south, Cesium.Color.ORANGERED, 2);
    line(north, Cesium.Color.ORANGERED, 2);
    line(center, Cesium.Color.YELLOW, 2);

    // Live shadow spot (updated each tick to follow the clock).
    umbraEntity = ds.entities.add({
      position: Cesium.Cartesian3.fromDegrees(pts[0].lon, pts[0].lat),
      ellipse: {
        semiMinorAxis: 1, semiMajorAxis: 1, material: Cesium.Color.BLACK.withAlpha(0.55),
        classificationType: Cesium.ClassificationType.BOTH,
      },
    });
    updateUmbra();
  }

  function updateUmbra() {
    if (!umbraEntity) return;
    const c = shadowCenter(viewer.clock.currentTime);
    if (!c || c.alt < D2R(1)) { umbraEntity.show = false; return; }
    umbraEntity.show = true;
    umbraEntity.position = Cesium.Cartesian3.fromDegrees(c.lon, c.lat);
    umbraEntity.ellipse.semiMinorAxis = Math.max(3000, Math.abs(c.rUmbra));
    umbraEntity.ellipse.semiMajorAxis = Math.max(3000, c.halfW);
  }

  chk.addEventListener("change", () => {
    if (chk.checked) drawPath(viewer.clock.currentTime);
    else { ds.entities.removeAll(); umbraEntity = null; }
  });
  viewer.clock.onTick.addEventListener(() => { if (chk.checked) updateUmbra(); });

  // Let app.js re-trace when it jumps to a new eclipse.
  window.recomputeEclipsePath = () => { if (chk.checked) drawPath(viewer.clock.currentTime); };
})();
