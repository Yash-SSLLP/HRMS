// Geospatial helper. Used to measure how far an attendance punch is from the
// office/work-location pin for geofence enforcement.

/**
 * Great-circle distance between two coordinates via the Haversine formula.
 * @param {{lat:number, lng:number}} a - First point.
 * @param {{lat:number, lng:number}} b - Second point.
 * @returns {number|null} Distance in whole metres, or null if either point is missing lat/lng.
 */
// Great-circle distance between two {lat, lng} points, in metres (Haversine).
function haversineMeters(a, b) {
  if (!a || !b || a.lat == null || a.lng == null || b.lat == null || b.lng == null) return null;
  const R = 6371000; // Earth radius in metres
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  return Math.round(2 * R * Math.asin(Math.sqrt(h)));
}

module.exports = { haversineMeters };
