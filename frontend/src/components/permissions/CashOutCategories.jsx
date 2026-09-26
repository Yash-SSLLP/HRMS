/**
 * CashOutCategories — the Category dropdown an employee picks from when they
 * record an expense in My Cashbook (Cash Out → Record an expense), and the ORDER
 * it is offered in. Position 1 is the top of the dropdown; that order is what
 * this tab calls "priority".
 *
 * Lives on the Permissions page (AdminPermissions → "Cash Out categories")
 * because the user put it there (2026-09-26): it is a company rule about what
 * spending may be filed under, kept by the Backend, the CEO, the MD and whoever
 * manages the cashbook — the same set the server's requireCashOutCategoryEditor
 * lets save (services/cashOutCategories.js). Anybody else never sees the tab.
 *
 * Saving changes what NEW expenses offer. An expense already filed keeps the
 * category it was filed under, whatever is renamed or removed here.
 *
 * GET /khata/categories · PUT /khata/categories { categories }.
 */
import { useEffect, useState } from 'react';
import { toast } from 'react-toastify';
import api from '../../api/client';
import ListEditor, { rowsOf } from '../ListEditor';

// What the server tidies a category to (services/cashOutCategories.js), so the
// count, the repeat warning and "anything changed?" all agree with what a save
// would actually store.
const tidy = (text) => String(text || '').replace(/\s+/g, ' ').trim();

export default function CashOutCategories() {
  // GET /khata/categories: the list, who last saved it, and the save's limits.
  const [config, setConfig] = useState(null);
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const load = async () => {
    setLoading(true);
    setError('');
    try {
      const { data } = await api.get('/khata/categories');
      setConfig(data);
      setRows(rowsOf(data.categories));
    } catch (err) {
      setError(err.response?.data?.message || 'Could not load the Cash Out categories');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); }, []);

  const filled = rows.map((r) => tidy(r.text)).filter(Boolean);
  const saved = config?.categories || [];
  const dirty = JSON.stringify(filled) !== JSON.stringify(saved);

  // The server keeps the FIRST of two spellings of one category and drops the
  // rest — say so before the save does it silently.
  const seen = new Set();
  const repeats = filled.filter((c) => {
    const key = c.toLowerCase();
    const again = seen.has(key);
    seen.add(key);
    return again;
  });

  const save = async () => {
    setSaving(true);
    setError('');
    try {
      const { data } = await api.put('/khata/categories', { categories: filled });
      setConfig(data);
      setRows(rowsOf(data.categories));
      toast.success(data.message || 'Cash Out categories saved');
    } catch (err) {
      setError(err.response?.data?.message || 'Could not save the categories');
    } finally {
      setSaving(false);
    }
  };

  const updated = config?.updatedAt
    ? `Last changed${config.updatedByName ? ` by ${config.updatedByName}` : ''} on ${new Date(config.updatedAt).toLocaleString('en-IN', {
      day: '2-digit', month: 'short', year: 'numeric', hour: 'numeric', minute: '2-digit', hour12: true,
    }).replace(/\b(am|pm)\b/i, (p) => p.toUpperCase())}.`
    : '';

  return (
    <div>
      <p className="text-sm text-gray-500 max-w-4xl mb-4">
        The <strong>Category</strong> list an employee chooses from when they record an expense in My Cashbook
        (<strong>Cash Out → Record an expense</strong>). The order here is the order of the dropdown:
        <strong> priority 1</strong> is at the top — use the arrows to move a category up or down.
      </p>

      <div className="bg-white shadow rounded-lg p-4 sm:p-5 max-w-3xl">
        <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1 mb-3">
          {/* What a save would keep — a repeat is dropped, so it is not counted. */}
          <h2 className="card-title">
            Cash Out categories <span className="text-gray-400 font-normal">({filled.length - repeats.length})</span>
          </h2>
          <span className="text-xs text-gray-500">Priority order · first is shown first</span>
        </div>

        {loading ? (
          <div className="space-y-2">
            {[0, 1, 2].map((i) => <div key={i} className="skeleton h-9 rounded-lg" />)}
          </div>
        ) : (
          <ListEditor
            rows={rows}
            onChange={setRows}
            numbered
            maxLength={config?.maxLength || 60}
            maxItems={config?.maxCategories || 40}
            placeholder="e.g. Fuel"
            itemName="category"
            fullText={`That is the most the dropdown takes (${config?.maxCategories || 40}).`}
            empty={(
              <p className="text-sm text-amber-800 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2">
                No categories yet. Until you add one, employees are not asked for a category and every expense
                is recorded as &quot;Expense&quot;.
              </p>
            )}
          />
        )}

        {repeats.length > 0 && (
          <p className="text-xs text-amber-800 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2 mt-3">
            {repeats.map((r) => `"${r}"`).join(', ')} {repeats.length === 1 ? 'is' : 'are'} already on the
            list higher up. Only the first one is kept when you save.
          </p>
        )}

        <ul className="text-xs text-gray-500 mt-4 space-y-1 list-disc pl-4">
          <li>Once there is at least one category, every new expense must pick one.</li>
          <li>
            Renaming or removing a category changes what is offered from now on. An expense already filed keeps
            the category it was filed under.
          </li>
        </ul>

        {updated && <p className="text-xs text-gray-400 mt-4">{updated}</p>}
        {error && (
          <div className="mt-3 text-sm text-red-700 bg-red-50 border border-red-200 px-3 py-2 rounded-lg">{error}</div>
        )}

        <div className="flex flex-wrap justify-end gap-2 pt-4">
          <button type="button" onClick={() => setRows(rowsOf(saved))} disabled={!dirty || saving || loading}
            className="px-4 py-2 text-sm border rounded-lg hover:bg-gray-50 disabled:opacity-50">
            Discard changes
          </button>
          <button type="button" onClick={save} disabled={!dirty || saving || loading}
            className="px-4 py-2 text-sm bg-gray-900 text-white rounded-lg hover:bg-gray-700 disabled:opacity-50">
            {saving ? 'Saving…' : 'Save categories'}
          </button>
        </div>
      </div>
    </div>
  );
}
