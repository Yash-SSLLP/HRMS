import { useEffect, useMemo, useRef, useState } from 'react';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import api from '../api/client';
import PageHeader from '../components/PageHeader';

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December'];

const fmtTime = (d) =>
  d ? new Date(d).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', hour12: true }) : '—';
const fmtDist = (m) => (m == null ? '' : m < 1000 ? `${m} m` : `${(m / 1000).toFixed(2)} km`);

// Dot colour by punch nature. Outside-the-geofence wins (that's what HR is
// hunting for), then WFH, then plain check-in / check-out.
function pointColor(p) {
  if (p.outside) return '#dc2626'; // red — punched outside their work area
  if (p.wfh) return '#7c3aed';     // violet — work from home
  return p.kind === 'in' ? '#16a34a' : '#2563eb'; // green in / blue out
}

// Days in a given month (handles leap years).
const daysInMonth = (y, m) => new Date(y, m, 0).getDate();

// Tooltip shown on hover — carries the exact punch timing, as requested.
function tooltipHtml(p) {
  const rows = [
    `<div style="font-weight:700">${escapeHtml(p.name)}</div>`,
    `<div style="opacity:.8">${escapeHtml(p.employeeCode)}${p.designation ? ' · ' + escapeHtml(p.designation) : ''}</div>`,
    `<div style="margin-top:3px">${p.kind === 'in' ? '🟢 Check-in' : '🔵 Check-out'}: <b>${fmtTime(p.time)}</b></div>`,
    `<div style="opacity:.85">${escapeHtml(p.date)}</div>`,
    p.distanceM != null ? `<div style="opacity:.85">${fmtDist(p.distanceM)} from ${escapeHtml(p.locationName || 'work area')}</div>` : '',
    p.outside ? '<div style="color:#dc2626;font-weight:600">⚠ Outside work area</div>' : '',
    p.wfh ? '<div style="color:#7c3aed;font-weight:600">WFH</div>' : '',
  ];
  return `<div style="min-width:150px;font-size:12px;line-height:1.35">${rows.filter(Boolean).join('')}</div>`;
}

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// HR/Admin punch-location map: every GPS-tagged check-in / check-out plotted as a
// dot. Pick a month + day (or the whole month), search by name to zoom to a
// person, hover a dot to see its exact timing.
export default function AdminPunchMap() {
  const now = new Date();
  const [year, setYear] = useState(now.getFullYear());
  const [month, setMonth] = useState(now.getMonth() + 1);
  const [day, setDay] = useState(now.getDate()); // 0 = whole month
  const [kind, setKind] = useState('all');       // all | in | out
  const [search, setSearch] = useState('');
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [selected, setSelected] = useState(null); // employeeId focused from the list

  const mapEl = useRef(null);
  const mapRef = useRef(null);
  const markersRef = useRef(null);
  const geoRef = useRef(null);
  const pointMarkers = useRef(new Map()); // point.id -> L.circleMarker

  // ----- data load -----
  const load = async () => {
    setLoading(true); setError('');
    try {
      const params = new URLSearchParams({ year, month });
      if (day) params.set('day', day);
      const { data } = await api.get(`/attendance/punch-map?${params}`);
      setData(data);
    } catch (err) {
      setError(err.response?.data?.message || 'Failed to load punch locations');
      setData(null);
    } finally { setLoading(false); }
  };
  useEffect(() => { load(); /* eslint-disable-next-line */ }, [year, month, day]);

  // Points after the in/out + name filters.
  const filtered = useMemo(() => {
    if (!data?.points) return [];
    const q = search.trim().toLowerCase();
    return data.points.filter((p) => {
      if (kind !== 'all' && p.kind !== kind) return false;
      if (q && !(`${p.name} ${p.employeeCode}`.toLowerCase().includes(q))) return false;
      return true;
    });
  }, [data, kind, search]);

  // People list (grouped) for the side panel.
  const people = useMemo(() => {
    const by = new Map();
    for (const p of filtered) {
      const g = by.get(p.employeeId) || { employeeId: p.employeeId, name: p.name, employeeCode: p.employeeCode, designation: p.designation, punches: [] };
      g.punches.push(p);
      by.set(p.employeeId, g);
    }
    return [...by.values()].sort((a, b) => a.name.localeCompare(b.name));
  }, [filtered]);

  // ----- init map once -----
  useEffect(() => {
    if (mapRef.current || !mapEl.current) return;
    const map = L.map(mapEl.current, { zoomControl: true, scrollWheelZoom: true }).setView([20.5937, 78.9629], 5);
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 19,
      attribution: '&copy; OpenStreetMap contributors',
    }).addTo(map);
    geoRef.current = L.layerGroup().addTo(map);
    markersRef.current = L.layerGroup().addTo(map);
    mapRef.current = map;
    // Leaflet can render grey if the container sized after init.
    setTimeout(() => map.invalidateSize(), 0);
    return () => { map.remove(); mapRef.current = null; };
  }, []);

  // ----- draw geofence circles when data changes -----
  useEffect(() => {
    const layer = geoRef.current;
    if (!layer) return;
    layer.clearLayers();
    for (const g of data?.geofences || []) {
      if (g.lat == null || g.lng == null) continue;
      if (g.radiusM) {
        L.circle([g.lat, g.lng], { radius: g.radiusM, color: '#6366f1', weight: 1, fillColor: '#6366f1', fillOpacity: 0.06 }).addTo(layer);
      }
      L.marker([g.lat, g.lng], {
        icon: L.divIcon({
          className: 'punch-office-icon',
          html: `<div style="background:#4338ca;color:#fff;font-size:10px;font-weight:700;padding:2px 6px;border-radius:6px;white-space:nowrap;box-shadow:0 1px 3px rgba(0,0,0,.3)">🏢 ${escapeHtml(g.label || 'Office')}</div>`,
          iconSize: null,
        }),
      }).addTo(layer);
    }
  }, [data]);

  // ----- draw punch dots when the filtered set changes -----
  useEffect(() => {
    const map = mapRef.current;
    const layer = markersRef.current;
    if (!map || !layer) return;
    layer.clearLayers();
    pointMarkers.current.clear();

    const latlngs = [];
    for (const p of filtered) {
      if (p.lat == null || p.lng == null) continue;
      const color = pointColor(p);
      // Soft coloured glow behind the dot so it stands out from the map — bigger
      // and stronger for out-of-area punches (what HR is scanning for).
      const halo = L.circleMarker([p.lat, p.lng], {
        radius: p.outside ? 18 : 13,
        stroke: false,
        fillColor: color,
        fillOpacity: p.outside ? 0.32 : 0.22,
        interactive: false,
      });
      // A pin-style icon: a bold ring + direction glyph reads far clearer than a
      // flat dot. Casing (dark outer + white inner ring) makes it pop on any tile.
      const glyph = p.kind === 'in' ? '▾' : '▴';
      const icon = L.divIcon({
        className: p.outside ? 'punch-dot out' : 'punch-dot',
        html:
          `<div style="width:26px;height:26px;border-radius:50%;background:${color};` +
          `border:3px solid #fff;box-shadow:0 0 0 1.5px ${color},0 2px 5px rgba(0,0,0,.45);` +
          `display:flex;align-items:center;justify-content:center;` +
          `color:#fff;font-size:14px;line-height:1;font-weight:900">${glyph}</div>`,
        iconSize: [26, 26],
        iconAnchor: [13, 13],
      });
      const m = L.marker([p.lat, p.lng], { icon, riseOnHover: true, zIndexOffset: p.outside ? 1000 : 0 });
      m.bindTooltip(tooltipHtml(p), { direction: 'top', offset: [0, -14], sticky: false });
      halo.addTo(layer);
      m.addTo(layer);
      pointMarkers.current.set(p.id, m);
      latlngs.push([p.lat, p.lng]);
    }

    // Include geofence centers in the initial framing.
    for (const g of data?.geofences || []) if (g.lat != null) latlngs.push([g.lat, g.lng]);

    if (latlngs.length && !selected) {
      map.fitBounds(L.latLngBounds(latlngs).pad(0.15), { maxZoom: 17 });
    }
  }, [filtered, data]); // eslint-disable-line react-hooks/exhaustive-deps

  // Focus a person's punches: fit to their dots and open the first tooltip.
  const focusPerson = (person) => {
    setSelected(person.employeeId);
    const map = mapRef.current;
    if (!map) return;
    const pts = person.punches.filter((p) => p.lat != null).map((p) => [p.lat, p.lng]);
    if (!pts.length) return;
    if (pts.length === 1) map.setView(pts[0], 17);
    else map.fitBounds(L.latLngBounds(pts).pad(0.3), { maxZoom: 18 });
    const first = pointMarkers.current.get(person.punches[0].id);
    if (first) first.openTooltip();
  };

  const totalWithGps = data?.count || 0;
  const outsideCount = filtered.filter((p) => p.outside).length;

  return (
    <div>
      {/* Marker styling: kill Leaflet's default div-icon white box; pulse out-of-area dots. */}
      <style>{`
        .punch-dot { background: transparent; border: 0; }
        .punch-dot.out > div { animation: punchPulse 1.6s ease-in-out infinite; }
        @keyframes punchPulse {
          0%, 100% { box-shadow: 0 0 0 1.5px #dc2626, 0 2px 5px rgba(0,0,0,.45); }
          50% { box-shadow: 0 0 0 6px rgba(220,38,38,.35), 0 2px 5px rgba(0,0,0,.45); }
        }
      `}</style>
      <PageHeader title="Punch Location Map" subtitle="Where every check-in / check-out happened · pick a day, search a name, hover a dot for its exact time" />

      {/* Filters */}
      <div className="flex flex-wrap items-end gap-2 mb-3">
        <div>
          <label className="block text-xs text-gray-600 mb-0.5">Year</label>
          <select value={year} onChange={(e) => { setYear(Number(e.target.value)); setSelected(null); }} className="border rounded-lg px-3 py-2 text-sm bg-white">
            {Array.from({ length: 4 }, (_, i) => now.getFullYear() - i).map((y) => <option key={y}>{y}</option>)}
          </select>
        </div>
        <div>
          <label className="block text-xs text-gray-600 mb-0.5">Month</label>
          <select value={month} onChange={(e) => { setMonth(Number(e.target.value)); setSelected(null); }} className="border rounded-lg px-3 py-2 text-sm bg-white">
            {MONTHS.map((m, i) => <option key={m} value={i + 1}>{m}</option>)}
          </select>
        </div>
        <div>
          <label className="block text-xs text-gray-600 mb-0.5">Day</label>
          <select value={day} onChange={(e) => { setDay(Number(e.target.value)); setSelected(null); }} className="border rounded-lg px-3 py-2 text-sm bg-white">
            <option value={0}>Whole month</option>
            {Array.from({ length: daysInMonth(year, month) }, (_, i) => i + 1).map((d) => <option key={d} value={d}>{d}</option>)}
          </select>
        </div>
        <div>
          <label className="block text-xs text-gray-600 mb-0.5">Punch</label>
          <select value={kind} onChange={(e) => setKind(e.target.value)} className="border rounded-lg px-3 py-2 text-sm bg-white">
            <option value="all">In &amp; Out</option>
            <option value="in">Check-in only</option>
            <option value="out">Check-out only</option>
          </select>
        </div>
        <div className="flex-1 min-w-[200px]">
          <label className="block text-xs text-gray-600 mb-0.5">Search employee</label>
          <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Name or code…"
            className="w-full border rounded-lg px-3 py-2 text-sm" />
        </div>
      </div>

      {/* Legend + counts */}
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 mb-3 text-xs text-gray-600">
        <span className="flex items-center gap-1.5"><i className="w-3 h-3 rounded-full inline-block" style={{ background: '#16a34a' }} /> Check-in</span>
        <span className="flex items-center gap-1.5"><i className="w-3 h-3 rounded-full inline-block" style={{ background: '#2563eb' }} /> Check-out</span>
        <span className="flex items-center gap-1.5"><i className="w-3 h-3 rounded-full inline-block" style={{ background: '#dc2626' }} /> Outside work area</span>
        <span className="flex items-center gap-1.5"><i className="w-3 h-3 rounded-full inline-block" style={{ background: '#7c3aed' }} /> WFH</span>
        <span className="ml-auto text-gray-500">
          {loading ? 'Loading…' : `${filtered.length} punch${filtered.length === 1 ? '' : 'es'} shown`}
          {totalWithGps > filtered.length ? ` of ${totalWithGps}` : ''}
          {outsideCount > 0 ? ` · ${outsideCount} outside` : ''}
        </span>
      </div>

      {error && <div className="mb-3 text-sm text-red-700 bg-red-50 border border-red-200 px-3 py-2 rounded-lg">{error}</div>}

      <div className="grid grid-cols-1 lg:grid-cols-[1fr_320px] gap-3">
        {/* Map */}
        <div className="bg-white rounded-xl shadow overflow-hidden" style={{ minHeight: 480 }}>
          <div ref={mapEl} style={{ height: '70vh', minHeight: 480, width: '100%' }} />
        </div>

        {/* People list */}
        <div className="bg-white rounded-xl shadow p-3 flex flex-col" style={{ maxHeight: '70vh' }}>
          <div className="text-sm font-semibold text-gray-800 mb-2">
            {people.length} {people.length === 1 ? 'person' : 'people'}
          </div>
          <div className="overflow-y-auto -mx-1 px-1 divide-y divide-gray-100">
            {people.length === 0 ? (
              <div className="text-sm text-gray-500 py-6 text-center">
                {loading ? 'Loading…' : 'No GPS-tagged punches for this selection.'}
              </div>
            ) : people.map((person) => (
              <button key={person.employeeId} onClick={() => focusPerson(person)}
                className={`w-full text-left py-2.5 px-1 hover:bg-gray-50 rounded-md transition ${selected === person.employeeId ? 'bg-indigo-50' : ''}`}>
                <div className="flex items-center justify-between gap-2">
                  <span className="text-sm font-medium text-gray-900 truncate">{person.name}</span>
                  <span className="text-[10px] font-mono text-gray-400 shrink-0">{person.employeeCode}</span>
                </div>
                {person.designation && <div className="text-[11px] text-gray-500 truncate">{person.designation}</div>}
                <div className="flex flex-wrap gap-1.5 mt-1">
                  {person.punches.map((p) => (
                    <span key={p.id}
                      title={`${p.kind === 'in' ? 'Check-in' : 'Check-out'} ${fmtTime(p.time)}${p.distanceM != null ? ` · ${fmtDist(p.distanceM)}` : ''}${p.outside ? ' · outside' : ''}`}
                      className="inline-flex items-center gap-1 text-[10.5px] px-1.5 py-0.5 rounded"
                      style={{ background: pointColor(p) + '1a', color: pointColor(p) }}>
                      {p.kind === 'in' ? '→' : '←'} {fmtTime(p.time)}
                    </span>
                  ))}
                </div>
              </button>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
