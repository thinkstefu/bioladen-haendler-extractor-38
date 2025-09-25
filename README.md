# Bioladen.de Händlersuche – stabiler Actor (ALL-DE-PLZ)

**Ziel:** Für jede deutsche PLZ das Eingabefeld auf https://www.bioladen.de/bio-haendler-suche befüllen, Suche starten, und die Ergebnisse **inkl. Detailinfos** extrahieren.

## PLZ-Quellen
- `postalCodesMode = "input"` → nimmt `postalCodes` aus dem Input.
- `postalCodesMode = "kv"` → lädt KeyValueStore-Datei **de_plz.txt** (eine PLZ pro Zeile).
- `postalCodesMode = "range"` (Default) → generiert 5-stellige PLZ. Über `rangePrefixes` steuerbar (Standard: repräsentative Spanne). Für Full-Run: `["all"]`.

## Beispiel-Input (Sanity 20095 / 25 km)
```json
{
  "postalCodes": ["20095"],
  "postalCodesMode": "input",
  "radiusKm": 25,
  "deduplicateBy": "detailUrl",
  "maxConcurrency": 1
}
```

## Beispiel-Input (ALLE deutschen PLZ mit Generator – vorsichtig!)
```json
{
  "postalCodesMode": "range",
  "rangePrefixes": ["all"],
  "radiusKm": 25,
  "deduplicateBy": "detailUrl",
  "maxConcurrency": 1
}
```

## Output-Schema
```
name, street, zip, city, country, lat, lng, phone, email, website,
openingHours, detailUrl, source, scrapedAt, distanceKm, category
```
