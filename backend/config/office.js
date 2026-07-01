// Office location used as the reference point for attendance punch distances.
// Resolved from the shared Google Maps pin:
//   Sequence Surfaces LLP, 1st Main Rd, KHB Colony, Kamakshipalya, Bengaluru 560079
//   plus code XGQJ+93F  ->  12.988422, 77.530238
// Override per-deployment with OFFICE_LAT / OFFICE_LNG env vars if needed.
const OFFICE = {
  lat: Number(process.env.OFFICE_LAT) || 12.988422,
  lng: Number(process.env.OFFICE_LNG) || 77.530238,
  label: process.env.OFFICE_LABEL || 'Sequence Surfaces LLP, Kamakshipalya, Bengaluru',
};

module.exports = OFFICE;
