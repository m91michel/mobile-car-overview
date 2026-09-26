import { useEffect, useMemo, useRef, useState } from 'react';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import { carLabel, carRef, carSubline, isSold, photo } from './rows.js';

// Same default as scripts/geo.mjs. The viewer never re-runs geo.mjs, and the
// scrape already baked distanceFromHomeKm into each car, so the home pin is
// the documented Fürth fallback rather than an env override.
const HOME = { lat: 49.4772, lon: 10.9887, label: 'Fürth' };

// Raster tiles from FOSSGIS (OSM.de): no API key. Carto's old public CDN
// now watermarks "API KEY REQUIRED"; MapLibre + OpenFreeMap would be the
// next step if we ever want native dark vector tiles.
const OSM_TILES = 'https://tile.openstreetmap.de/{z}/{x}/{y}.png';
const TILE_ATTR =
  '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>';

export function carLocation(car) {
  const loc = car.dealer?.location;
  if (!loc) return null;
  const lat = Number(loc.lat);
  const lon = Number(loc.lon);
  return Number.isFinite(lat) && Number.isFinite(lon) ? { lat, lon } : null;
}

/** Same dealer (or two listings a few metres apart) share one pin. */
function groupByLocation(cars) {
  const groups = new Map();
  for (const car of cars) {
    const loc = carLocation(car);
    if (!loc) continue;
    const key = `${loc.lat.toFixed(4)},${loc.lon.toFixed(4)}`;
    const existing = groups.get(key);
    if (existing) existing.cars.push(car);
    else groups.set(key, { lat: loc.lat, lon: loc.lon, cars: [car] });
  }
  return [...groups.values()];
}

const attr = (text) => String(text).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');

/**
 * A thumbnail of the car instead of a bare number, so the map reads at a
 * glance. A shared pin shows its first car with the count as the badge; a car
 * without photos falls back to the round number pin.
 */
function pinIcon(group, favourites) {
  const fav = group.cars.some((car) => favourites.includes(car.id));
  const sold = group.cars.every(isSold);
  const label =
    group.cars.length === 1 ? carRef(group.cars[0]) || '·' : String(group.cars.length);
  const cover = group.cars.find((car) => car.images?.[0]);
  const className = `map-pin${fav ? ' fav' : ''}${sold ? ' sold' : ''}`;
  if (!cover) {
    return L.divIcon({
      className,
      html: `<span>${label}</span>`,
      iconSize: [34, 34],
      iconAnchor: [17, 17],
      popupAnchor: [0, 14],
    });
  }
  return L.divIcon({
    className: `${className} photo`,
    html:
      `<img src="${attr(photo(cover.images[0], 'mo-240'))}" alt="" referrerpolicy="no-referrer">` +
      `<b>${attr(label)}</b>`,
    iconSize: [60, 42],
    iconAnchor: [30, 21],
    popupAnchor: [0, -18],
  });
}

function homeIcon() {
  return L.divIcon({
    className: 'map-home',
    html: `<span title="${HOME.label}">⌂</span>`,
    iconSize: [28, 28],
    iconAnchor: [14, 14],
    popupAnchor: [0, 14],
  });
}

function popupFor(group) {
  const wrap = document.createElement('div');
  wrap.className = 'map-popup-list';

  const place = document.createElement('p');
  place.className = 'map-popup-place';
  const first = group.cars[0];
  const city = (first.dealer?.city ?? first.dealer?.name ?? '').replace(/\u00a0/g, ' ');
  const km = first.derived?.distanceFromHomeKm;
  place.textContent = [city, km != null ? `${km} km Luftlinie` : null].filter(Boolean).join(' · ');
  wrap.append(place);

  for (const car of group.cars) {
    const card = document.createElement('a');
    card.className = `map-popup-card${isSold(car) ? ' sold' : ''}`;
    card.href = car.url;
    card.target = '_blank';
    card.rel = 'noreferrer';

    if (car.images?.[0]) {
      const img = document.createElement('img');
      img.src = photo(car.images[0], 'mo-240');
      img.alt = '';
      img.referrerPolicy = 'no-referrer';
      card.append(img);
    }

    const text = document.createElement('span');
    text.className = 'map-popup-text';

    const title = document.createElement('span');
    title.className = 'map-popup-title';
    const ref = carRef(car);
    if (ref) {
      const badge = document.createElement('span');
      badge.className = 'ref';
      badge.textContent = ref;
      title.append(badge, '\u00a0');
    }
    title.append(car.shortTitle ?? carLabel(car));
    text.append(title);

    const meta = document.createElement('span');
    meta.className = 'muted';
    meta.textContent = [car.price?.localized ?? '—', carSubline(car)].filter(Boolean).join(' · ');
    if (isSold(car)) {
      const gone = document.createElement('span');
      gone.className = 'gone';
      gone.textContent = 'verkauft';
      meta.append(gone);
    }
    text.append(meta);
    card.append(text);
    wrap.append(card);
  }

  return wrap;
}

export default function MapView({ cars, favourites = [] }) {
  const host = useRef(null);
  const mapRef = useRef(null);
  const layerRef = useRef(null);
  // Bumped after the map exists so the marker effect re-runs after React
  // StrictMode's mount/unmount/remount (the map ref is new; groups are not).
  const [mapReady, setMapReady] = useState(0);

  const groups = useMemo(() => groupByLocation(cars), [cars]);
  const missing = useMemo(() => cars.filter((car) => !carLocation(car)), [cars]);

  useEffect(() => {
    const el = host.current;
    if (!el) return undefined;

    const map = L.map(el, {
      scrollWheelZoom: true,
      attributionControl: true,
    });
    L.tileLayer(OSM_TILES, {
      attribution: TILE_ATTR,
      maxZoom: 19,
    }).addTo(map);
    const layer = L.layerGroup().addTo(map);

    mapRef.current = map;
    layerRef.current = layer;
    setMapReady((n) => n + 1);

    const ro = new ResizeObserver(() => map.invalidateSize());
    ro.observe(el);

    return () => {
      ro.disconnect();
      map.remove();
      mapRef.current = null;
      layerRef.current = null;
    };
  }, []);

  useEffect(() => {
    const map = mapRef.current;
    const layer = layerRef.current;
    if (!map || !layer) return;

    layer.clearLayers();

    L.marker([HOME.lat, HOME.lon], { icon: homeIcon(), zIndexOffset: -200, keyboard: false })
      .bindPopup(
        `<strong>${HOME.label}</strong><br><span class="muted">Startpunkt der Luftlinie</span>`,
      )
      .addTo(layer);

    const bounds = L.latLngBounds([[HOME.lat, HOME.lon]]);
    for (const group of groups) {
      bounds.extend([group.lat, group.lon]);
      L.marker([group.lat, group.lon], {
        icon: pinIcon(group, favourites),
        title: group.cars.map((car) => `${carRef(car)} ${car.shortTitle ?? carLabel(car)}`.trim()).join(', '),
      })
        .bindPopup(popupFor(group), {
          maxWidth: 340,
          className: 'map-popup',
          autoPanPadding: [40, 40],
        })
        .addTo(layer);
    }

    if (bounds.isValid()) {
      map.fitBounds(bounds.pad(0.16), { maxZoom: 11, animate: false });
    }
    map.invalidateSize();
  }, [mapReady, groups, favourites]);

  return (
    <div className="map-view">
      <div className="map-host" ref={host} />
      <p className="map-legend muted">
        {groups.length} {groups.length === 1 ? 'Standort' : 'Standorte'}
        {missing.length > 0 && (
          <>
            {' · '}
            {missing.length} ohne Koordinaten
            {': '}
            {missing.map((car) => carRef(car) || carLabel(car)).join(', ')}
          </>
        )}
      </p>
    </div>
  );
}
