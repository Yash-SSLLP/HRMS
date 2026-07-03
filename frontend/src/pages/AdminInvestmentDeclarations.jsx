import { useEffect, useMemo, useState } from 'react';
import api from '../api/client';
import PageHeader from '../components/PageHeader';

const inr = new Intl.NumberFormat('en-IN', {
  style: 'currency',
  currency: 'INR',
  maximumFractionDigits: 0,
});

const STATUSES = ['Draft', 'Submitted', 'Verified', 'Rejected'];
const STATUS_STYLES = {
  Draft: 'bg-gray-200 text-gray-700',
  Submitted: 'bg-amber-100 text-amber-800',
  Verified: 'bg-green-100 text-green-800',
  Rejected: 'bg-red-100 text-red-800',
};

const SECTION_FIELDS = [
  { key: 'section80C', label: '80C · PF / ELSS / LIC / PPF' },
  { key: 'section80CCD1B', label: '80CCD(1B) · NPS' },
  { key: 'section80D', label: '80D · Medical Insurance' },
  { key: 'section24B', label: '24B · Home Loan Interest' },
  { key: 'section80E', label: '80E · Education Loan Interest' },
  { key: 'section80G', label: '80G · Donations' },
  { key: 'hraAnnualRent', label: 'HRA · Annual Rent Paid' },
  { key: 'ltaClaimed', label: 'LTA · Claimed' },
  { key: 'otherDeductions', label: 'Other Deductions' },
];

function totalOf(d) {
  const s = d?.sections || {};
  return SECTION_FIELDS.reduce((sum, f) => sum + (Number(s[f.key]) || 0), 0);
}

function employeeName(d) {
  const e = d.employee;
  if (!e) return '-';
  return `${e.firstName || ''} ${e.lastName || ''}`.trim() || e.email || '-';
}

export default function AdminInvestmentDeclarations() {
  const [declarations, setDeclarations] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [statusFilter, setStatusFilter] = useState('');
  const [fyFilter, setFyFilter] = useState('');
  const [viewing, setViewing] = useState(null);
  const [actingId, setActingId] = useState('');

  const load = async () => {
    setLoading(true);
    setError('');
    try {
      const params = new URLSearchParams();
      if (statusFilter) params.set('status', statusFilter);
      if (fyFilter) params.set('financialYear', fyFilter);
      const qs = params.toString();
      const { data } = await api.get(`/declarations${qs ? `?${qs}` : ''}`);
      setDeclarations(data.declarations);
    } catch (err) {
      setError(err.response?.data?.message || 'Failed to load declarations');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [statusFilter, fyFilter]);

  const review = async (d, status) => {
    let reviewNote = '';
    if (status === 'Rejected') {
      const note = window.prompt('Reason for rejection (optional):', '');
      if (note === null) return; // cancelled
      reviewNote = note;
    }
    setActingId(d._id);
    setError('');
    try {
      await api.patch(`/declarations/${d._id}/status`, { status, reviewNote });
      if (viewing && viewing._id === d._id) setViewing(null);
      await load();
    } catch (err) {
      setError(err.response?.data?.message || 'Action failed');
    } finally {
      setActingId('');
    }
  };

  const viewingTotal = useMemo(() => (viewing ? totalOf(viewing) : 0), [viewing]);

  return (
    <div>
      <PageHeader title="Investment Declarations" subtitle="Form 12BB submissions">
        <select
          value={statusFilter}
          onChange={(e) => setStatusFilter(e.target.value)}
          className="border rounded-lg px-3 py-2 text-sm"
        >
          <option value="">All statuses</option>
          {STATUSES.map((s) => (
            <option key={s} value={s}>{s}</option>
          ))}
        </select>
        <input
          type="text"
          value={fyFilter}
          onChange={(e) => setFyFilter(e.target.value)}
          placeholder="FY e.g. 2025-26"
          className="border rounded-lg px-3 py-2 text-sm w-40"
        />
      </PageHeader>

      {error && (
        <div className="mb-4 text-sm text-red-700 bg-red-50 border border-red-200 px-3 py-2 rounded-lg">{error}</div>
      )}

      <div className="bg-white shadow rounded-lg overflow-hidden">
        <table className="min-w-full divide-y divide-gray-200 text-sm">
          <thead className="bg-gray-50">
            <tr>
              <th className="px-4 py-3 text-left font-medium text-gray-700">Employee</th>
              <th className="px-4 py-3 text-left font-medium text-gray-700">Financial Year</th>
              <th className="px-4 py-3 text-left font-medium text-gray-700">Regime</th>
              <th className="px-4 py-3 text-right font-medium text-gray-700">Total Declared</th>
              <th className="px-4 py-3 text-left font-medium text-gray-700">Status</th>
              <th className="px-4 py-3 text-right font-medium text-gray-700">Actions</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100">
            {loading ? (
              <tr><td colSpan={6} className="px-4 py-4"><div className="space-y-2.5"><div className="skeleton h-4 rounded" /><div className="skeleton h-4 rounded w-5/6" /><div className="skeleton h-4 rounded w-2/3" /></div></td></tr>
            ) : declarations.length === 0 ? (
              <tr><td colSpan={6} className="px-4 py-6 text-center text-gray-500">No declarations found</td></tr>
            ) : declarations.map((d) => (
              <tr key={d._id}>
                <td className="px-4 py-3">
                  {employeeName(d)}
                  <div className="text-xs text-gray-500">{d.employee?.email}</div>
                </td>
                <td className="px-4 py-3">{d.financialYear}</td>
                <td className="px-4 py-3">{d.regime}</td>
                <td className="px-4 py-3 text-right">{inr.format(totalOf(d))}</td>
                <td className="px-4 py-3">
                  <span className={`inline-block px-2 py-0.5 text-xs rounded-lg ${STATUS_STYLES[d.status] || 'bg-gray-200 text-gray-700'}`}>
                    {d.status}
                  </span>
                </td>
                <td className="px-4 py-3 text-right whitespace-nowrap">
                  <button onClick={() => setViewing(d)} className="text-blue-600 hover:underline">View</button>
                  <button
                    onClick={() => review(d, 'Verified')}
                    disabled={actingId === d._id}
                    className="ml-3 text-green-600 hover:underline disabled:opacity-50"
                  >
                    Verify
                  </button>
                  <button
                    onClick={() => review(d, 'Rejected')}
                    disabled={actingId === d._id}
                    className="ml-3 text-red-600 hover:underline disabled:opacity-50"
                  >
                    Reject
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {viewing && (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center px-4 z-50 overflow-y-auto py-8">
          <div className="bg-white rounded-xl shadow-lg w-full max-w-lg p-6">
            <div className="flex items-start justify-between mb-1">
              <h2 className="card-title">{employeeName(viewing)}</h2>
              <span className={`inline-block px-2 py-0.5 text-xs rounded-lg ${STATUS_STYLES[viewing.status] || 'bg-gray-200 text-gray-700'}`}>
                {viewing.status}
              </span>
            </div>
            <p className="text-xs text-gray-500 mb-4">
              {viewing.financialYear} · {viewing.regime} Regime
            </p>

            <div className="divide-y divide-gray-100 border rounded-lg">
              {SECTION_FIELDS.map((f) => (
                <div key={f.key} className="flex items-center justify-between px-3 py-2 text-sm">
                  <span className="text-gray-700">{f.label}</span>
                  <span className="text-gray-900">{inr.format(Number(viewing.sections?.[f.key]) || 0)}</span>
                </div>
              ))}
              <div className="flex items-center justify-between px-3 py-2 text-sm font-semibold bg-gray-50">
                <span>Total declared</span>
                <span>{inr.format(viewingTotal)}</span>
              </div>
            </div>

            {Array.isArray(viewing.proofs) && viewing.proofs.length > 0 && (
              <div className="mt-4">
                <h3 className="text-sm font-medium text-gray-700 mb-2">Proofs</h3>
                <ul className="space-y-1 text-sm">
                  {viewing.proofs.map((p, i) => (
                    <li key={i}>
                      <span className="text-gray-700">{p.label || 'Proof'}: </span>
                      {p.url ? (
                        <a href={p.url} target="_blank" rel="noreferrer" className="text-blue-600 hover:underline break-all">
                          {p.url}
                        </a>
                      ) : (
                        <span className="text-gray-400">-</span>
                      )}
                    </li>
                  ))}
                </ul>
              </div>
            )}

            {viewing.reviewNote && (
              <div className="mt-4 text-sm text-gray-600">
                Reviewer note: <span className="text-gray-800">{viewing.reviewNote}</span>
              </div>
            )}

            <div className="flex justify-end gap-2 pt-5">
              <button
                type="button"
                onClick={() => setViewing(null)}
                className="px-4 py-2 text-sm border rounded-lg hover:bg-gray-50"
              >
                Close
              </button>
              <button
                type="button"
                onClick={() => review(viewing, 'Rejected')}
                disabled={actingId === viewing._id}
                className="px-4 py-2 text-sm border border-red-300 text-red-700 rounded-lg hover:bg-red-50 disabled:opacity-60"
              >
                Reject
              </button>
              <button
                type="button"
                onClick={() => review(viewing, 'Verified')}
                disabled={actingId === viewing._id}
                className="px-4 py-2 text-sm bg-gray-900 text-white rounded-lg hover:bg-gray-700 disabled:opacity-60"
              >
                Verify
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
