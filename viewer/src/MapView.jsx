import { useEffect, useMemo, useRef, useState } from 'react';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
// Extends the global L that leaflet sets on window, i.e. the same object as
// the import above. Only the structural CSS: the cluster looks like our pins.
import 'leaflet.markercluster';
import 'leaflet.markercluster/dist/MarkerCluster.css';
import { carLabel, carRef, isSold, photo } from './rows.js';

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
 * `pins` is 'photo' (a thumbnail, so the map reads at a glance) or 'number'
 * (the round #ref pin). A shared pin shows its first car with the count as the
 * label; a car without photos always gets the round pin.
 */
function pinIcon(group, favourites, pins) {
  const label =
    group.cars.length === 1 ? carRef(group.cars[0]) || '·' : String(group.cars.length);
  return carPin(group.cars, label, favourites, pins);
}

/**
 * Zoomed out, nearby pins merge into one: the first car's photo with the car
 * count, so the map shows "7 around Stuttgart" rather than a pile of
 * thumbnails. A click zooms in until they separate.
 */
function clusterIcon(cluster, favourites, pins) {
  const cars = cluster.getAllChildMarkers().flatMap((marker) => marker.options.cars ?? []);
  return carPin(cars, String(cars.length), favourites, pins, ' cluster');
}

function carPin(cars, label, favourites, pins, extra = '') {
  const fav = cars.some((car) => favourites.includes(car.id));
  const sold = cars.every(isSold);
  const cover = pins === 'photo' && cars.find((car) => car.images?.[0]);
  const className = `map-pin${fav ? ' fav' : ''}${sold ? ' sold' : ''}${extra}`;
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

/**
 * A click on a pin hands its cars to `onSelect` -- App opens them as a table
 * in a drawer -- instead of a popup, which could only ever show a summary.
 */
export default function MapView({ cars, favourites = [], pins = 'photo', onPinsChange, onSelect }) {
  const host = useRef(null);
  const mapRef = useRef(null);
  const layerRef = useRef(null);
  // Bumped after the map exists so the marker effect re-runs after React
  // StrictMode's mount/unmount/remount (the map ref is new; groups are not).
  const [mapReady, setMapReady] = useState(0);
  // Refit only when the set of cars changes, not when favourites or the pin
  // style do -- otherwise every ★ click would throw away the current zoom.
  const fittedFor = useRef(null);
  const selectRef = useRef(onSelect);
  selectRef.current = onSelect;

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
    fittedFor.current = null;
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
    // Rebuilt rather than cleared, so iconCreateFunction sees the current
    // favourites.
    const clusters = L.markerClusterGroup({
      maxClusterRadius: 60,
      showCoverageOnHover: false,
      spiderfyOnMaxZoom: true,
      iconCreateFunction: (cluster) => clusterIcon(cluster, favourites, pins),
    });
    clusters.addTo(layer);

    L.marker([HOME.lat, HOME.lon], { icon: homeIcon(), zIndexOffset: -200, keyboard: false })
      .bindPopup(
        `<strong>${HOME.label}</strong><br><span class="muted">Startpunkt der Luftlinie</span>`,
      )
      .addTo(layer);

    const bounds = L.latLngBounds([[HOME.lat, HOME.lon]]);
    for (const group of groups) {
      bounds.extend([group.lat, group.lon]);
      L.marker([group.lat, group.lon], {
        icon: pinIcon(group, favourites, pins),
        cars: group.cars,
        title: group.cars.map((car) => `${carRef(car)} ${car.shortTitle ?? carLabel(car)}`.trim()).join(', '),
      })
        .on('click', () => selectRef.current?.(group.cars))
        .addTo(clusters);
    }

    if (bounds.isValid() && fittedFor.current !== groups) {
      map.fitBounds(bounds.pad(0.16), { maxZoom: 11, animate: false });
      fittedFor.current = groups;
    }
    map.invalidateSize();
  }, [mapReady, groups, favourites, pins]);

  return (
    <div className="map-view">
      <div className="map-host" ref={host} />
      <p className="map-legend muted">
        <span className="sort map-pins" role="group" aria-label="Pins">
          <button className={pins === 'photo' ? 'on' : ''} onClick={() => onPinsChange?.('photo')}>
            Bilder
          </button>
          <button className={pins === 'number' ? 'on' : ''} onClick={() => onPinsChange?.('number')}>
            Nummern
          </button>
        </span>
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
