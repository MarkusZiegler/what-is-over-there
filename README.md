# What is over there?

Eine Web-App fürs iPhone: Kamera auf etwas in der Ferne richten, zum Beispiel eine Ortschaft am anderen Seeufer, eine Ruine oder eine Burg, und **Peilen** tippen. Die App zeichnet deine Blickrichtung als Linie mit Unsicherheitskegel auf die Karte und listet auf, was in dieser Richtung liegt.

**App öffnen:** https://markusziegler.github.io/what-is-over-there/
(Auf dem iPhone in Safari öffnen. Über *Teilen → Zum Home-Bildschirm* lässt sie sich wie eine App starten.)

## Bedienung

1. **Starten** tippen und Kamera, Standort und Bewegungssensoren erlauben.
2. Das Handy im Hochformat halten und das Ziel ins Fadenkreuz nehmen.
3. **Peilen** tippen und ruhig halten. 1,5 Sekunden lang werden Kompasswerte gemittelt.
4. Auf der Karte erscheinen Standort, Peillinie und Sichtkegel. Darunter steht die Liste der Treffer aus OpenStreetMap (Orte, Burgen, Ruinen, Kirchen, Türme, Gipfel, Inseln), jeweils mit Entfernung und Abweichung von der Linie. Treffer nahe der Linie sind mit ◎ markiert.
5. Pro Treffer gibt es Links zu Google Maps, einer Route mit Apple Karten, Wikipedia und OpenStreetMap.

**Einstellbar:** Länge der Linie (5/15/30/60 km), Toleranz (Breite des Kegels), Filter (Orte/Bauwerke/Natur), Sortierung nach Entfernung oder nach Nähe zur Linie, Kartenstil (Karte/Topo/Satellit).

**Kreuzpeilung:** Peilst du dasselbe Ziel von zwei Standorten an und schaltest *Frühere Peilungen* ein, liegt das Ziel dort, wo sich die Linien kreuzen.

## Genauigkeit und Kalibrierung

Der Handy-Kompass liegt oft **5–15°** daneben. Bei 10 km Entfernung sind 5° schon fast 900 m seitlich. Deshalb zeigt die App einen Kegel statt einer Linie.

So wird die Peilung genauer:
- **Kalibrieren:** Ein bekanntes Ziel in mindestens 1 km Entfernung anpeilen (Kirchturm, Funkmast). Dann *🎯 Kalibrieren* und das Ziel auf der Karte antippen, oder in der Liste *🎯 War mein Ziel* wählen. Die App merkt sich die Korrektur.
- **Magnete meiden:** MagSafe-Hüllen, Halterungen, Autos und Stahlgeländer verfälschen den Kompass.
- Wenn die App meldet, dass der Kompass ungenau ist, das Handy ein paarmal in einer liegenden Acht bewegen.

Unter *Einstellungen → Sensoren (live)* siehst du die Rohwerte: Richtung, Streuung, iOS-Kompassgenauigkeit, GPS-Genauigkeit.

## Technik

- Reines HTML, CSS und JavaScript ohne Build-Schritt. Gehostet auf GitHub Pages; HTTPS ist dort automatisch dabei, und das ist Voraussetzung für Kamera und Sensoren.
- Richtung: auf iOS über `webkitCompassHeading`, auf Android aus `deviceorientationabsolute` (W3C-Formel für die Blickrichtung der Rückkamera).
- Karte: [Leaflet](https://leafletjs.com/) mit OpenStreetMap, OpenTopoMap und Esri-Satellitenbild.
- Treffer: [Overpass API](https://wiki.openstreetmap.org/wiki/Overpass_API). Kostenlos, kein API-Key nötig. Die öffentlichen Server sind manchmal ausgelastet; die App versucht es dann automatisch erneut.
- Gespeichert wird nur lokal im Browser (`localStorage`): Einstellungen, Kompass-Korrektur, die letzten 30 Peilungen.

| Datei | Inhalt |
|---|---|
| `index.html` | Oberfläche (Start, Kamera, Karte, Einstellungen) |
| `app.js` | Sensoren, Peilen, Karte, Ergebnisliste |
| `geo.js` | Geometrie: Zielpunkt, Entfernung, Peilwinkel, zirkulärer Mittelwert |
| `overpass.js` | OSM-Abfrage und Einordnung der Treffer |
| `style.css` | Gestaltung |

**Am Rechner testen:** `index.html?demo` öffnen. Simuliert wird ein Standort in Meersburg mit Blick über den Bodensee; die Pfeiltasten ← / → drehen die Richtung.

## Ideen für später

- Sichtlinie gegen das Gelände berechnen (Neigung + Höhenmodell), um auszublenden, was hinter Hügeln verborgen ist
- Kreuzpeilung automatisch auswerten (Schnittpunkt berechnen)
- Namen direkt ins Kamerabild einblenden
- Eventuell eine native iPhone-App (genauerer Kompass über CoreLocation/ARKit)
