// scripts/generate-states-map.mjs
// Generates optimized SVG paths for Nigeria 36 states + FCT from GeoJSON.
import { readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

async function main() {
  const geojsonPath = join(process.cwd(), 'data', 'nigeria-states.geojson');
  let raw;
  if (existsSync(geojsonPath)) {
    raw = await readFile(geojsonPath, 'utf8');
  } else {
    console.log('Fetching nigeria-states.geojson...');
    const res = await fetch('https://raw.githubusercontent.com/qedsoftware/geojson_data/master/nigeria-states.geojson');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    raw = await res.text();
    await writeFile(geojsonPath, raw, 'utf8');
  }

  const geojson = JSON.parse(raw);
  console.log(`Loaded ${geojson.features.length} features.`);

  // Nigeria bounds
  // Lon: 2.67 to 14.68
  // Lat: 4.27 to 13.89
  const lonMin = 2.67, lonMax = 14.68;
  const latMin = 4.27, latMax = 13.89;

  // ViewBox: 0 0 800 680
  const width = 800, height = 680;
  const padX = 20, padY = 20;
  const usableW = width - 2 * padX;
  const usableH = height - 2 * padY;

  // Mercator projection formula
  function project(lon, lat) {
    const x = padX + ((lon - lonMin) / (lonMax - lonMin)) * usableW;
    const latRad = (lat * Math.PI) / 180;
    const latMinRad = (latMin * Math.PI) / 180;
    const latMaxRad = (latMax * Math.PI) / 180;
    const mercN = Math.log(Math.tan(Math.PI / 4 + latRad / 2));
    const mercMin = Math.log(Math.tan(Math.PI / 4 + latMinRad / 2));
    const mercMax = Math.log(Math.tan(Math.PI / 4 + latMaxRad / 2));
    const y = padY + (1 - (mercN - mercMin) / (mercMax - mercMin)) * usableH;
    return [Math.round(x * 10) / 10, Math.round(y * 10) / 10];
  }

  // Ramer-Douglas-Peucker line simplification
  function perpendicularDistanceSq(p, a, b) {
    const dx = b[0] - a[0], dy = b[1] - a[1];
    const lenSq = dx * dx + dy * dy;
    if (lenSq === 0) {
      const px = p[0] - a[0], py = p[1] - a[1];
      return px * px + py * py;
    }
    const t = Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / lenSq));
    const projX = a[0] + t * dx, projY = a[1] + t * dy;
    const px = p[0] - projX, py = p[1] - projY;
    return px * px + py * py;
  }

  function simplifyRDP(points, epsilonSq) {
    if (points.length <= 2) return points;
    let maxDistSq = 0, index = 0;
    const end = points.length - 1;
    for (let i = 1; i < end; i++) {
      const dSq = perpendicularDistanceSq(points[i], points[0], points[end]);
      if (dSq > maxDistSq) {
        maxDistSq = dSq;
        index = i;
      }
    }
    if (maxDistSq > epsilonSq) {
      const left = simplifyRDP(points.slice(0, index + 1), epsilonSq);
      const right = simplifyRDP(points.slice(index), epsilonSq);
      return left.slice(0, left.length - 1).concat(right);
    }
    return [points[0], points[end]];
  }

  function coordsToPath(rings) {
    return rings.map(ring => {
      const projected = ring.map(pt => project(pt[0], pt[1]));
      // Simplify with epsilon = 1.0 pixel (epsilonSq = 1.0)
      const simplified = simplifyRDP(projected, 1.0);
      return simplified.map((pt, idx) => `${idx === 0 ? 'M' : 'L'}${pt[0]},${pt[1]}`).join(' ') + ' Z';
    }).join(' ');
  }

  function geometryToPath(geom) {
    if (geom.type === 'Polygon') {
      return coordsToPath(geom.coordinates);
    } else if (geom.type === 'MultiPolygon') {
      return geom.coordinates.map(poly => coordsToPath(poly)).join(' ');
    }
    return '';
  }

  function computeCentroid(rings) {
    let totalArea = 0, cx = 0, cy = 0;
    const ring = rings[0] || [];
    const n = ring.length;
    if (n < 3) return [0, 0];
    const pts = ring.map(pt => project(pt[0], pt[1]));
    for (let i = 0; i < n - 1; i++) {
      const [x0, y0] = pts[i];
      const [x1, y1] = pts[i + 1];
      const cross = x0 * y1 - x1 * y0;
      totalArea += cross;
      cx += (x0 + x1) * cross;
      cy += (y0 + y1) * cross;
    }
    const area = totalArea / 2;
    if (Math.abs(area) < 0.001) {
      // Fallback to bounding box midpoint
      const xs = pts.map(p => p[0]), ys = pts.map(p => p[1]);
      return [Math.round((Math.min(...xs) + Math.max(...xs)) / 2), Math.round((Math.min(...ys) + Math.max(...ys)) / 2)];
    }
    return [Math.round((cx / (6 * area)) * 10) / 10, Math.round((cy / (6 * area)) * 10) / 10];
  }

  const states = {};

  for (const f of geojson.features) {
    let name = f.properties.NAME_1;
    // Standardize naming
    if (name === 'Nassarawa') name = 'Nasarawa';
    const isFCT = name === 'Federal Capital Territory';
    const d = geometryToPath(f.geometry);
    const rings = f.geometry.type === 'Polygon' ? f.geometry.coordinates : f.geometry.coordinates[0];
    const center = computeCentroid(rings);
    states[name] = {
      name,
      shortName: isFCT ? 'FCT' : name,
      isFCT,
      type: isFCT ? 'Federal Capital Territory' : 'State',
      path: d,
      center
    };
  }

  const outputJs = `// Generated Nigeria States SVG Map Data
// 36 States + Federal Capital Territory (FCT)
(function (root, factory) {
  const mod = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = mod;
  if (typeof root !== 'undefined') {
    root.NIGERIA_MAP_VIEWBOX = mod.NIGERIA_MAP_VIEWBOX;
    root.NIGERIA_STATES_MAP = mod.NIGERIA_STATES_MAP;
  }
})(typeof self !== 'undefined' ? self : globalThis, function () {
  'use strict';
  const NIGERIA_MAP_VIEWBOX = '0 0 ${width} ${height}';
  const NIGERIA_STATES_MAP = ${JSON.stringify(states, null, 2)};
  return { NIGERIA_MAP_VIEWBOX, NIGERIA_STATES_MAP };
});
`;

  const outputPath = join(process.cwd(), 'data', 'nigeria-states-paths.js');
  await writeFile(outputPath, outputJs, 'utf8');
  console.log(`Generated ${Object.keys(states).length} states in ${outputPath}`);
}

main().catch(console.error);
