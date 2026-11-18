// Geometrie-Hilfsfunktionen (Kugelmodell der Erde, für Peilungen bis ~100 km völlig ausreichend)

export const EARTH_R = 6371008.8; // mittlerer Erdradius in m

const toRad = (d) => (d * Math.PI) / 180;
const toDeg = (r) => (r * 180) / Math.PI;

/** Winkel auf 0…360° normieren. */
export const norm360 = (a) => ((a % 360) + 360) % 360;

/** Vorzeichenbehaftete Differenz a − b in (−180°, 180°]. Positiv = a liegt rechts (im Uhrzeigersinn) von b. */
export function angleDiff(a, b) {
  const d = norm360(a - b);
  return d > 180 ? d - 360 : d;
}

/** Zielpunkt, wenn man von (lat, lon) aus `dist` Meter in Richtung `brg` (Grad) geht. */
export function destination(lat, lon, brg, dist) {
  const delta = dist / EARTH_R;
  const theta = toRad(brg);
  const phi1 = toRad(lat);
  const lambda1 = toRad(lon);
  const sinPhi2 = Math.sin(phi1) * Math.cos(delta) + Math.cos(phi1) * Math.sin(delta) * Math.cos(theta);
  const phi2 = Math.asin(sinPhi2);
  const lambda2 =
    lambda1 +
    Math.atan2(Math.sin(theta) * Math.sin(delta) * Math.cos(phi1), Math.cos(delta) - Math.sin(phi1) * sinPhi2);
  return { lat: toDeg(phi2), lon: ((toDeg(lambda2) + 540) % 360) - 180 };
}

/** Entfernung in Metern (Haversine). */
export function distance(lat1, lon1, lat2, lon2) {
  const phi1 = toRad(lat1);
  const phi2 = toRad(lat2);
  const dPhi = phi2 - phi1;
  const dLambda = toRad(lon2 - lon1);
  const a = Math.sin(dPhi / 2) ** 2 + Math.cos(phi1) * Math.cos(phi2) * Math.sin(dLambda / 2) ** 2;
  return 2 * EARTH_R * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

/** Anfangs-Peilung (0° = Nord, im Uhrzeigersinn) von Punkt 1 zu Punkt 2. */
export function bearingTo(lat1, lon1, lat2, lon2) {
  const phi1 = toRad(lat1);
  const phi2 = toRad(lat2);
  const dLambda = toRad(lon2 - lon1);
  const y = Math.sin(dLambda) * Math.cos(phi2);
  const x = Math.cos(phi1) * Math.sin(phi2) - Math.sin(phi1) * Math.cos(phi2) * Math.cos(dLambda);
  return norm360(toDeg(Math.atan2(y, x)));
}

/**
 * Mittelwert und Streuung von Winkeln (zirkuläre Statistik).
 * Der normale Mittelwert von 359° und 1° wäre 180° – hier kommt korrekt 0° heraus.
 */
export function circularStats(angles) {
  const n = angles.length;
  if (!n) return { mean: NaN, std: NaN, n: 0 };
  let s = 0;
  let c = 0;
  for (const a of angles) {
    s += Math.sin(toRad(a));
    c += Math.cos(toRad(a));
  }
  s /= n;
  c /= n;
  const R = Math.min(1, Math.hypot(s, c));
  return {
    mean: norm360(toDeg(Math.atan2(s, c))),
    std: R > 0 ? toDeg(Math.sqrt(-2 * Math.log(R))) : 180,
    n,
  };
}

/** Sichtkegel als Polygon [[lat, lon], …]: Standort + Bogen von heading−tol bis heading+tol. */
export function conePolygon(lat, lon, heading, tol, dist, steps = 16) {
  const pts = [[lat, lon]];
  for (let i = 0; i <= steps; i++) {
    const b = heading - tol + (2 * tol * i) / steps;
    const p = destination(lat, lon, b, dist);
    pts.push([p.lat, p.lon]);
  }
  return pts;
}

const DIRS = ['N', 'NNO', 'NO', 'ONO', 'O', 'OSO', 'SO', 'SSO', 'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'];

/** Himmelsrichtung als Text (16-teilig, deutsch). */
export const compassLabel = (h) => DIRS[Math.round(norm360(h) / 22.5) % 16];

/**
 * Blickrichtung der Rückkamera aus absoluten alpha/beta/gamma-Werten
 * (Formel aus der W3C-Spezifikation „DeviceOrientation Event“). Wird für Android genutzt;
 * iOS liefert stattdessen direkt webkitCompassHeading.
 */
export function w3cCompassHeading(alpha, beta, gamma) {
  const x = toRad(beta || 0);
  const y = toRad(gamma || 0);
  const z = toRad(alpha || 0);
  const cX = Math.cos(x);
  const cY = Math.cos(y);
  const cZ = Math.cos(z);
  const sX = Math.sin(x);
  const sY = Math.sin(y);
  const sZ = Math.sin(z);
  const Vx = -cZ * sY - sZ * sX * cY;
  const Vy = -sZ * sY + cZ * sX * cY;
  return norm360(toDeg(Math.atan2(Vx, Vy)));
}
