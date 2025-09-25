# Bioladen.de Händlersuche – stabiler Actor

**Ziel:** Exakte Extraktion der Händlerliste von  
https://www.bioladen.de/bio-haendler-suche (PLZ + Radius).

## Features
- Steuert die Webseite per **Playwright (Crawlee)** – kein OSM.
- Unterstützt Filter **Bioläden**, **Marktstände**, **Lieferservice**.
- **Dedup nach `detailUrl`** (Fallback: `name+address`).
- Stabil: Cookie-Banner-Handling (inkl. Iframe), JS-Fallback zum Befüllen der PLZ,
  Auto-Scroll, Warte-Strategien.

## Input (Sanity 20095 / 25 km)
```json
{
  "postalCodes": ["20095"],
  "radiusKm": 25,
  "filters": { "biolaeden": true, "marktstaende": true, "lieferservice": true },
  "deduplicateBy": "detailUrl",
  "maxConcurrency": 1
}
```

## Output-Schema
```text
name, street, zip, city, country, lat, lng, phone, email, website,
openingHours, detailUrl, source, scrapedAt, distanceKm, category
```
