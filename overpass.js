// Abfrage von OpenStreetMap-Daten über die Overpass-API (kostenlos, kein API-Key nötig)

const ENDPOINTS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.private.coffee/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
];

/** Gruppen für die Filter-Chips in der Ergebnisliste. */
export const GROUPS = {
  ort: { label: 'Orte', color: '#4da3ff' },
  bau: { label: 'Bauwerke', color: '#ffb020' },
  natur: { label: 'Natur', color: '#5fd38d' },
};

function buildQuery(polyStr) {
  const P = `(poly:"${polyStr}")`;
  return `[out:json][timeout:25];
(
  nwr["place"~"^(city|town|village|hamlet|suburb|island|islet)$"]${P};
  nwr["historic"~"^(castle|ruins|fort|manor|palace|monastery|tower|city_gate|church)$"]${P};
  nwr["building"~"^(church|cathedral|chapel)$"]["name"]${P};
  nwr["amenity"="place_of_worship"]["name"]${P};
  nwr["man_made"~"^(tower|lighthouse|windmill|watermill|water_tower)$"]["name"]${P};
  nwr["tourism"="attraction"]["name"]${P};
  nwr["natural"~"^(peak|volcano)$"]["name"]${P};
);
out center tags qt;`;
}

const wait = (ms, signal) =>
  new Promise((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => {
      clearTimeout(t);
      reject(new DOMException('Abgebrochen', 'AbortError'));
    }, { once: true });
  });

/**
 * Sucht alle interessanten Objekte innerhalb des Polygons [[lat, lon], …].
 * Die öffentlichen Server sind oft ausgelastet (429/502/503/504): dann reihum
 * den nächsten Server probieren und zwischen den Runden immer länger warten.
 * onRetry(info) wird vor jeder Wartepause aufgerufen (für die Statusanzeige).
 */
export async function queryCone(poly, signal, onRetry) {
  const polyStr = poly.map(([la, lo]) => `${la.toFixed(5)} ${lo.toFixed(5)}`).join(' ');
  const body = 'data=' + encodeURIComponent(buildQuery(polyStr));
  const ROUNDS = 4;
  let lastErr;
  for (let round = 0; round < ROUNDS; round++) {
    for (const url of ENDPOINTS) {
      try {
        const res = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body,
          signal,
        });
        if (!res.ok) throw new Error(`${new URL(url).host} antwortet mit ${res.status}`);
        const json = await res.json();
        return json.elements || [];
      } catch (e) {
        if (e.name === 'AbortError') throw e;
        lastErr = e;
      }
    }
    if (round < ROUNDS - 1) {
      const ms = 2000 * 2 ** round; // 2 s, 4 s, 8 s
      onRetry?.({ round: round + 1, waitMs: ms, error: lastErr });
      await wait(ms, signal);
    }
  }
  throw lastErr || new Error('Overpass nicht erreichbar');
}

/**
 * Ordnet ein OSM-Objekt einer Kategorie zu.
 * prio: kleiner = wichtiger (bei Duplikaten gewinnt die kleinere Zahl).
 * Gibt null zurück, wenn das Objekt uninteressant ist.
 */
export function classify(t) {
  const name = t['name:de'] || t.name || null;
  const mk = (group, icon, label, prio, allowUnnamed = false) => {
    if (!name && !allowUnnamed) return null;
    return { group, icon, label, prio, name: name || `${label} (ohne Namen)`, unnamed: !name };
  };

  // 1) Historisches – darf auch ohne Namen auftauchen (gerade Ruinen sind oft unbenannt)
  switch (t.historic) {
    case 'castle': {
      const ruin = t.ruins === 'yes' || t.castle_type === 'ruins';
      const types = {
        palace: 'Schloss',
        stately: 'Schloss',
        defensive: 'Burg',
        fortress: 'Festung',
        castrum: 'Kastell',
        manor: 'Herrenhaus',
      };
      return mk('bau', '🏰', ruin ? 'Burgruine' : types[t.castle_type] || 'Burg/Schloss', 1, true);
    }
    case 'ruins':
      return mk('bau', '🧱', 'Ruine', 1, true);
    case 'fort':
      return mk('bau', '🏰', 'Festung', 1, true);
    case 'palace':
      return mk('bau', '🏰', 'Palast/Schloss', 1);
    case 'manor':
      return mk('bau', '🏛️', 'Herrenhaus', 1);
    case 'monastery':
      return mk('bau', '⛪', 'Kloster', 1);
    case 'tower':
      return mk('bau', '🗼', 'Historischer Turm', 1, true);
    case 'city_gate':
      return mk('bau', '🏛️', 'Stadttor', 1);
    case 'church':
      return mk('bau', '⛪', 'Historische Kirche', 1);
  }

  // 2) Kirchen und Gotteshäuser
  if (/^(church|cathedral|chapel)$/.test(t.building || '') || t.amenity === 'place_of_worship') {
    const christian = !t.religion || t.religion === 'christian';
    let label = christian ? 'Kirche' : 'Gotteshaus';
    if (t.building === 'cathedral') label = 'Dom/Kathedrale';
    else if (t.building === 'chapel') label = 'Kapelle';
    return mk('bau', '⛪', label, 2);
  }

  // 3) Türme, Leuchttürme, Mühlen
  if (t.man_made) {
    const tt = t['tower:type'];
    const labels = {
      tower: tt === 'observation' ? 'Aussichtsturm' : tt === 'communication' ? 'Funkturm' : 'Turm',
      lighthouse: 'Leuchtturm',
      windmill: 'Windmühle',
      watermill: 'Wassermühle',
      water_tower: 'Wasserturm',
    };
    if (labels[t.man_made]) return mk('bau', t.man_made === 'lighthouse' ? '🗼' : t.man_made.endsWith('mill') ? '🌬️' : '🗼', labels[t.man_made], 2);
  }

  // 4) Gipfel
  if (t.natural === 'peak' || t.natural === 'volcano') {
    return mk('natur', '⛰️', t.natural === 'volcano' ? 'Vulkan' : 'Gipfel', 3);
  }

  // 5) Orte und Inseln
  const places = {
    city: ['ort', '🏙️', 'Stadt'],
    town: ['ort', '🏘️', 'Stadt'],
    village: ['ort', '🏘️', 'Dorf'],
    hamlet: ['ort', '🏡', 'Weiler'],
    suburb: ['ort', '🏘️', 'Ortsteil'],
    island: ['natur', '🏝️', 'Insel'],
    islet: ['natur', '🏝️', 'Insel'],
  };
  if (places[t.place]) {
    const [g, i, l] = places[t.place];
    return mk(g, i, l, 3);
  }

  // 6) Sonstige Sehenswürdigkeiten
  if (t.tourism === 'attraction') return mk('bau', '✨', 'Sehenswürdigkeit', 4);

  return null;
}

/** Wikipedia-Link aus dem OSM-Tag "wikipedia" (Format "de:Titel"), sonst Wikidata. */
export function wikiUrl(t) {
  if (t.wikipedia) {
    const m = t.wikipedia.match(/^([a-z-]+):(.+)$/);
    if (m) return `https://${m[1]}.wikipedia.org/wiki/${encodeURIComponent(m[2].replace(/ /g, '_'))}`;
  }
  if (t.wikidata) return `https://www.wikidata.org/wiki/${encodeURIComponent(t.wikidata)}`;
  return null;
}
