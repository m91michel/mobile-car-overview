// Distance from home to the seller.
//
// mobile.de gives every listing the seller's coordinates, so a comparison can
// answer "how far do I have to drive?" without any geocoding service.
//
// This is straight-line distance, deliberately: it needs no API key and no
// network call, and for triaging 24 cars across Germany the ranking it produces
// is the same one a routing service would give. Do not present it as a driving
// distance -- real routes run 20-30% longer.

// Override with e.g. HOME_LOCATION="49.4772,10.9887"
const DEFAULT_HOME = { lat: 49.4772, lon: 10.9887, label: 'Fürth' };

export const HOME = (() => {
  const raw = process.env.HOME_LOCATION;
  if (!raw) return DEFAULT_HOME;
  const [lat, lon] = raw.split(',').map((part) => Number(part.trim()));
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
    throw new Error(`HOME_LOCATION must look like "49.4772,10.9887", got "${raw}"`);
  }
  return { lat, lon, label: process.env.HOME_LABEL ?? `${lat},${lon}` };
})();

const EARTH_RADIUS_KM = 6371;
const toRadians = (degrees) => (degrees * Math.PI) / 180;

/** Great-circle distance in km, rounded to whole km. */
export function straightLineKm(from, to) {
  if (!from || !to) return null;
  const { lat: lat1, lon: lon1 } = from;
  const { lat: lat2, lon: lon2 } = to;
  if (![lat1, lon1, lat2, lon2].every(Number.isFinite)) return null;

  const dLat = toRadians(lat2 - lat1);
  const dLon = toRadians(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRadians(lat1)) * Math.cos(toRadians(lat2)) * Math.sin(dLon / 2) ** 2;
  return Math.round(EARTH_RADIUS_KM * 2 * Math.asin(Math.sqrt(a)));
}

/** Distance from HOME to a mobile.de latLong ({lat, lon}). */
export const distanceFromHomeKm = (latLong) => straightLineKm(HOME, latLong);
