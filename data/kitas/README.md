# Kitas in Fürth

103 Krippen, Kindergärten und Großtagespflegen im Stadtgebiet Fürth, eine Datei
pro Einrichtung in `listings/`. Zusammengestellt am 17.10.2026.

## Quellen

- **Adressen, Telefon, E-Mail:** die beiden Listen der Stadt Fürth auf
  familieninfo-fuerth.de,
  [Kindergärten (Stand 01/2022)](https://www.familieninfo-fuerth.de/wp-content/uploads/2024/07/Kindergaerten-im-Stadtgebiet-Fuerth.pdf)
  und
  [Krippen und Großtagespflege (Stand 07/2023)](https://www.familieninfo-fuerth.de/wp-content/uploads/2024/07/Krippen-und-Grosstagespflege-im-Stadtgebiet-Fuerth.pdf).
  Jede Einrichtung nennt in `Quelle`, aus welcher Liste sie stammt.
- **Stadtteil, Träger, Website:** die Übersichtsseiten
  [Kindergärten](https://www.familieninfo-fuerth.de/betreuung-und-bildung/kindergaerten/)
  und [Kinderkrippen](https://www.familieninfo-fuerth.de/betreuung-und-bildung/kinderkrippen/)
  (zuletzt geändert 03/2025).
- **Koordinaten:** Nominatim (OpenStreetMap) aus der Adresse. Wo nur die Straße
  gefunden wurde, steht ein `Hinweis` am Eintrag.
- **Fußweg, Rad, Auto:** OSRM-Routing von FOSSGIS (routing.openstreetmap.de)
  zur Waldstraße 48, 90763 Fürth. Die Luftlinie rechnet der Viewer selbst
  (`home` in `collection.json`).

fuerth.de selbst sitzt hinter einer Cloudflare-Abfrage und wurde nicht gelesen.

## Bekannte Grenzen

- Die Kindergartenliste ist von 2022. Neue Einrichtungen fehlen dort, und
  einzelne Angaben können veraltet sein. Vor einer Anmeldung zählt, was
  [Little Bird](https://portal.little-bird.de/Suche-Vorausgefuellt/F%C3%BCrth),
  das Anmeldeportal der Stadt, anzeigt.
- Horte (Schulkinder) sind bewusst nicht enthalten.
- Gleiche Adresse heißt eine Einrichtung: Krippe und Kindergarten unter einem
  Dach sind ein Eintrag mit `Art: Krippe + Kindergarten`.
- Moggerla: Der Waldkindergarten steht laut moggerla.de in der Sperberstraße 68,
  die Krippe in der Oberfürberger Straße 46.
