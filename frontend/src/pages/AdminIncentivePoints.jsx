/**
 * AdminIncentivePoints — what a point is worth (Incentive → Point Rate).
 *
 * Every incentive the company runs pays in POINTS, and this is the one page that
 * turns points into money. It is deliberately its own tab rather than a section
 * inside the Boys incentive: the figure is shared, and a setting that lives
 * inside one module reads as belonging to it.
 *
 * ONE number is set here: rupees per point. What a SHEET yields in points is the
 * Boys incentive's own figure and is set inside that module (Incentive → Boys
 * Incentive → Points per sheet); it is shown below only because the worked
 * example needs it, and a second incentive will count something else entirely.
 *
 * The figure never restates history: a day copies it onto itself when it is
 * recorded and keeps it (IncentiveEntry.rupeePerPoint), so re-valuing a point
 * changes what is earned from now on and nothing else.
 *
 * Backend: GET/PUT /incentives/settings — the same `incentive.manage` gate as
 * the rest of the module, which CEO/MD may write through (see
 * backend/routes/incentiveRoutes.js).
 */
import { useEffect, useState } from 'react';
import { toast } from 'react-toastify';
import api from '../api/client';
import { useAuthStore } from '../store/authStore';
import { isViewOnlyAccount } from '../config/permissions';
import PageHeader from '../components/PageHeader';

const inr = new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', maximumFractionDigits: 2 });
const money = (n) => inr.format(Number(n) || 0);
const points = (n) => `${Math.round((Number(n) || 0) * 100) / 100}`;

export default function AdminIncentivePoints() {
  // CEO/MD write in this module — only the God audit login is read-only here.
  // See the note in pages/AdminBoysIncentive.jsx.
  const me = useAuthStore((st) => st.user);
  const viewOnly = isViewOnlyAccount(me);

  const [settings, setSettings] = useState(null);
  const [form, setForm] = useState(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    api.get('/incentives/settings')
      .then(({ data }) => setSettings(data.settings))
      .catch((err) => setError(err.response?.data?.message || 'Could not load the settings'));
  }, []);

  const save = async (ev) => {
    ev.preventDefault();
    setSaving(true);
    try {
      const { data } = await api.put('/incentives/settings', { rupeePerPoint: form.rupeePerPoint });
      setSettings(data.settings);
      setForm(null);
      toast.success('Saved');
    } catch (err) {
      toast.error(err.response?.data?.message || 'Could not save');
    } finally {
      setSaving(false);
    }
  };

  // A worked example, live, from whatever is currently typed. The figures are
  // small and abstract on their own — "what does a day actually pay?" is the
  // question somebody is really asking when they change one.
  // The rate being TYPED, but the per-sheet yield as SAVED — that one is not
  // editable here any more.
  const shown = { ...settings, ...(form || {}) };
  const example = settings
    ? (() => {
      const sheets = 5;
      const heads = 5;
      const teamPoints = Math.round(sheets * (Number(settings.pointsPerSheet) || 0) * 100) / 100;
      const each = Math.round((teamPoints / heads) * 100) / 100;
      return {
        sheets,
        heads,
        teamPoints,
        each,
        eachMoney: Math.round(each * (Number(shown.rupeePerPoint) || 0) * 100) / 100,
        teamMoney: Math.round(teamPoints * (Number(shown.rupeePerPoint) || 0) * 100) / 100,
      };
    })()
    : null;

  return (
    <div>
      <PageHeader
        title="Point Rate"
        subtitle="What a point is worth. Every incentive is paid in points and converted here."
      />

      {error && <div className="mb-4 text-sm text-red-700 bg-red-50 border border-red-200 px-3 py-2 rounded-lg">{error}</div>}

      {!settings ? (
        <p className="text-sm text-gray-500">Loading…</p>
      ) : (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 max-w-4xl">
          <div className="bg-white shadow rounded-xl p-6">
            {!form ? (
              <>
                <h2 className="card-title mb-1">Rupees per point</h2>
                <p className="text-sm text-gray-500 mb-4">
                  Company-wide. Change it and every incentive follows — but only from now on: a day
                  already recorded keeps the value it was saved with, so nothing already earned is
                  restated.
                </p>
                <div className="text-3xl font-semibold text-gray-900">{money(settings.rupeePerPoint)}</div>
                <div className="text-xs text-gray-500 mt-1">per point</div>

                {!viewOnly && (
                  <button
                    onClick={() => setForm({ rupeePerPoint: String(settings.rupeePerPoint) })}
                    className="mt-6 px-4 py-2 bg-gray-900 text-white rounded-lg hover:bg-gray-700 text-sm"
                  >
                    Change
                  </button>
                )}
              </>
            ) : (
              <form onSubmit={save} className="space-y-4">
                <h2 className="card-title">Change the rate</h2>
                <div>
                  <label className="block text-xs font-medium text-gray-600 mb-1">Rupees per point *</label>
                  <input autoFocus required type="number" min="0" step="0.01" value={form.rupeePerPoint}
                    onChange={(e) => setForm({ ...form, rupeePerPoint: e.target.value })}
                    className="block w-full border rounded-lg px-3 py-2" />
                  <p className="text-xs text-gray-400 mt-1">Used by every incentive.</p>
                </div>
                <div className="flex justify-end gap-2 pt-1">
                  <button type="button" onClick={() => setForm(null)}
                    className="px-4 py-2 text-sm border rounded-lg hover:bg-gray-50">Cancel</button>
                  <button type="submit" disabled={saving}
                    className="px-4 py-2 text-sm bg-gray-900 text-white rounded-lg hover:bg-gray-700 disabled:opacity-60">
                    {saving ? 'Saving…' : 'Save'}
                  </button>
                </div>
              </form>
            )}
          </div>

          {example && (
            <div className="bg-white shadow rounded-xl p-6">
              <h2 className="card-title mb-1">What that pays</h2>
              <p className="text-sm text-gray-500 mb-4">
                A worked day at {form ? 'the rate you are typing' : 'the current figures'}. Points per
                sheet is set under <strong>Boys Incentive → Points per sheet</strong>.
              </p>
              <ol className="space-y-3 text-sm">
                <li className="flex justify-between gap-4">
                  <span className="text-gray-500">A team of {example.heads} rolls</span>
                  <span className="font-medium text-gray-900">{example.sheets} sheets</span>
                </li>
                <li className="flex justify-between gap-4">
                  <span className="text-gray-500">× {points(settings.pointsPerSheet)} points a sheet</span>
                  <span className="font-medium text-gray-900">{points(example.teamPoints)} team points</span>
                </li>
                <li className="flex justify-between gap-4">
                  <span className="text-gray-500">÷ {example.heads} people</span>
                  <span className="font-medium text-gray-900">{points(example.each)} points each</span>
                </li>
                <li className="flex justify-between gap-4 pt-3 border-t border-gray-100">
                  <span className="text-gray-500">× {money(shown.rupeePerPoint)} a point</span>
                  <span className="font-semibold text-gray-900">{money(example.eachMoney)} each</span>
                </li>
                <li className="flex justify-between gap-4">
                  <span className="text-gray-500">The day costs</span>
                  <span className="font-medium text-gray-900">{money(example.teamMoney)}</span>
                </li>
              </ol>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
