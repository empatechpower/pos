export interface LatLng { latitude: number; longitude: number }

/** Great-circle distance in kilometres (haversine). Good to a few metres, which is plenty for "how far is the shop". */
export function distanceKm(a: LatLng, b: LatLng): number {
  const rad = (d: number) => (d * Math.PI) / 180;
  const dLat = rad(b.latitude - a.latitude);
  const dLon = rad(b.longitude - a.longitude);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.latitude)) * Math.cos(rad(b.latitude)) * Math.sin(dLon / 2) ** 2;
  return 2 * 6371.0088 * Math.asin(Math.min(1, Math.sqrt(h)));
}

export const validCoordinates = (lat: unknown, lng: unknown): boolean =>
  typeof lat === "number" && typeof lng === "number" && Number.isFinite(lat) && Number.isFinite(lng) && Math.abs(lat) <= 90 && Math.abs(lng) <= 180;

/** "450 m" under a kilometre, "3.2 km" under ten, "12 km" beyond. */
export function formatDistance(km: number): string {
  if (km < 1) return `${Math.round(km * 10) * 100} m`;
  return km < 10 ? `${km.toFixed(1)} km` : `${Math.round(km)} km`;
}

/** The stores with their distance from a point, nearest first. Stores without coordinates keep their order and go last. */
export function sortByDistance<T extends { latitude?: number | null; longitude?: number | null }>(stores: readonly T[], from: LatLng): Array<T & { distanceKm: number | null }> {
  const withD = stores.map((s) => ({ ...s, distanceKm: validCoordinates(s.latitude, s.longitude) ? distanceKm(from, { latitude: s.latitude as number, longitude: s.longitude as number }) : null }));
  return [...withD.filter((s) => s.distanceKm !== null).sort((a, b) => (a.distanceKm as number) - (b.distanceKm as number)), ...withD.filter((s) => s.distanceKm === null)];
}
