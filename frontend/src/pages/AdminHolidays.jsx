/**
 * AdminHolidays — holiday calendar management (admin portal). Lists holidays for
 * a year from GET /holidays and creates/edits/deletes via POST/PUT/DELETE
 * /holidays. Holidays feed the shared calendar and attendance status.
 *
 * A whole year can also be loaded in one go: Template downloads the three-sheet
 * workbook (Holidays / Comp Offs / Celebrations) and Import posts it back to
 * POST /holidays/import, which creates the holidays and comp-off days here and
 * the celebrations as company events.
 *
 * "Comp Off" is an org-wide compensatory day off. It behaves like any other
 * holiday, with one difference: an employee who actually works it can be paid
 * double for that day once HR or their manager approves it (Attendance →
 * Sunday & comp-off duty).
 */
import { useEffect, useRef, useState } from 'react';
import { toast } from 'react-toastify';
import api from '../api/client';
import { downloadFile } from '../api/download';
import PageHeader from '../components/PageHeader';
import { confirmDialog } from '../components/dialogs';

const COMP_OFF = 'Comp Off';
const TYPES = ['Public', 'Restricted', 'Company', COMP_OFF];
const blank = { name: '', date: '', type: 'Public', description: '' };

// Type badge colours — Comp Off stands apart because it carries the double-pay rule.
const TYPE_TONE = {
  Public: 'bg-rose-50 text-rose-700 border-rose-200',
  Restricted: 'bg-amber-50 text-amber-700 border-amber-200',
  Company: 'bg-blue-50 text-blue-700 border-blue-200',
  [COMP_OFF]: 'bg-violet-50 text-violet-700 border-violet-200',
};

export default function AdminHolidays() {
  const thisYear = new Date().getFullYear();
  const [year, setYear] = useState(thisYear);
  const [holidays, setHolidays] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [showModal, setShowModal] = useState(false);
  const [editingId, setEditingId] = useState(null);
  const [form, setForm] = useState(blank);
  const [saving, setSaving] = useState(false);
  const [showImport, setShowImport] = useState(false);
  const [importing, setImporting] = useState(false);
  const [importResult, setImportResult] = useState(null);
  const importFileRef = useRef(null);

  const load = async () => {
    setLoading(true);
    setError('');
    try {
      const { data } = await api.get(`/holidays?year=${year}`);
      setHolidays(data.holidays);
    } catch (err) {
      setError(err.response?.data?.message || 'Failed to load');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); }, [year]);

  const openCreate = () => {
    setEditingId(null);
    setForm(blank);
    setShowModal(true);
  };

  const openEdit = (h) => {
    setEditingId(h._id);
    setForm({
      name: h.name,
      date: h.date ? h.date.slice(0, 10) : '',
      type: h.type,
      description: h.description || '',
    });
    setShowModal(true);
  };

  const save = async (e) => {
    e.preventDefault();
    setSaving(true);
    setError('');
    try {
      if (editingId) {
        await api.put(`/holidays/${editingId}`, form);
      } else {
        await api.post('/holidays', form);
      }
      setShowModal(false);
      await load();
    } catch (err) {
      setError(err.response?.data?.message || 'Save failed');
    } finally {
      setSaving(false);
    }
  };

  const closeImport = () => {
    setShowImport(false);
    setImportResult(null);
    if (importFileRef.current) importFileRef.current.value = '';
  };

  const runImport = async (e) => {
    e.preventDefault();
    const file = importFileRef.current?.files?.[0];
    if (!file) return;
    setImporting(true);
    setImportResult(null);
    try {
      const fd = new FormData();
      fd.append('file', file);
      const { data } = await api.post('/holidays/import', fd, {
        headers: { 'Content-Type': 'multipart/form-data' },
      });
      setImportResult(data);
      // The upload can carry entries for any year; reload so this year's show.
      await load();
    } catch (err) {
      setImportResult({ errorBanner: err.response?.data?.message || 'Import failed' });
    } finally {
      setImporting(false);
    }
  };

  const remove = async (h) => {
    if (!(await confirmDialog({ message: `Delete "${h.name}"?`, tone: 'danger', confirmText: 'Delete' }))) return;
    try {
      await api.delete(`/holidays/${h._id}`);
      await load();
    } catch (err) {
      toast.error(err.response?.data?.message || 'Delete failed');
    }
  };

  return (
    <div>
      <PageHeader title="Holidays">
        <select value={year} onChange={(e) => setYear(Number(e.target.value))}
          className="border rounded-lg px-3 py-2 text-sm">
          {[thisYear - 1, thisYear, thisYear + 1].map((y) => <option key={y} value={y}>{y}</option>)}
        </select>
        <button
          onClick={() => downloadFile('/holidays/template.xlsx', 'calendar-import-template.xlsx')}
          className="px-3 py-2 border rounded-lg hover:bg-gray-50 text-sm"
          title="Download the blank workbook: holidays, comp-off days and celebrations">
          Template
        </button>
        <button onClick={() => setShowImport(true)}
          className="px-3 py-2 border rounded-lg hover:bg-gray-50 text-sm"
          title="Upload holidays, comp-off days and celebrations in bulk">
          Import Excel
        </button>
        <button onClick={openCreate}
          className="px-4 py-2 bg-gray-900 text-white rounded-lg hover:bg-gray-700 text-sm">
          + Add Holiday
        </button>
      </PageHeader>

      {error && (
        <div className="mb-4 text-sm text-red-700 bg-red-50 border border-red-200 px-3 py-2 rounded-lg">{error}</div>
      )}

      <div className="mb-4 rounded-xl border border-violet-100 bg-violet-50 px-4 py-3 text-sm">
        <span className="font-medium text-gray-800">Comp Off days are the company-wide days off.</span>
        <span className="text-gray-600">
          {' '}They are non-working like any holiday — and an employee who actually works one (or a Sunday)
          is paid double for that day once it is approved under Attendance → Sunday &amp; comp-off duty.
        </span>
      </div>

      <div className="bg-white shadow rounded-lg overflow-hidden">
        <table className="min-w-full divide-y divide-gray-200 text-sm">
          <thead className="bg-gray-50">
            <tr>
              <th className="px-4 py-3 text-left font-medium text-gray-700">Date</th>
              <th className="px-4 py-3 text-left font-medium text-gray-700">Name</th>
              <th className="px-4 py-3 text-left font-medium text-gray-700">Type</th>
              <th className="px-4 py-3 text-right font-medium text-gray-700">Actions</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100">
            {loading ? (
              <tr><td colSpan={4} className="px-4 py-4"><div className="space-y-2.5"><div className="skeleton h-4 rounded" /><div className="skeleton h-4 rounded w-5/6" /><div className="skeleton h-4 rounded w-2/3" /></div></td></tr>
            ) : holidays.length === 0 ? (
              <tr><td colSpan={4} className="px-4 py-6 text-center text-gray-500">No holidays for {year}</td></tr>
            ) : holidays.map((h) => (
              <tr key={h._id}>
                <td className="px-4 py-3 whitespace-nowrap">
                  {new Date(h.date).toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' })}
                </td>
                <td className="px-4 py-3">
                  {h.name}
                  {h.description && <div className="text-xs text-gray-500">{h.description}</div>}
                </td>
                <td className="px-4 py-3">
                  <span className={`inline-block px-2 py-0.5 rounded-full border text-xs font-medium ${TYPE_TONE[h.type] || 'bg-gray-50 text-gray-600 border-gray-200'}`}>
                    {h.type}
                  </span>
                </td>
                <td className="px-4 py-3 text-right space-x-2">
                  <button onClick={() => openEdit(h)} className="text-blue-600 hover:underline">Edit</button>
                  <button onClick={() => remove(h)} className="text-red-600 hover:underline">Delete</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {showModal && (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center px-4 z-50 overflow-y-auto py-8">
          <div className="bg-white rounded-xl shadow-lg w-full max-w-md p-6">
            <h2 className="card-title mb-4">{editingId ? 'Edit Holiday' : 'Add Holiday'}</h2>
            <form onSubmit={save} className="space-y-3">
              <div>
                <label className="block text-sm text-gray-700">Name *</label>
                <input required value={form.name}
                  onChange={(e) => setForm({ ...form, name: e.target.value })}
                  className="mt-1 block w-full border rounded-lg px-3 py-2" />
              </div>
              <div>
                <label className="block text-sm text-gray-700">Date *</label>
                <input type="date" required value={form.date}
                  onChange={(e) => setForm({ ...form, date: e.target.value })}
                  className="mt-1 block w-full border rounded-lg px-3 py-2" />
              </div>
              <div>
                <label className="block text-sm text-gray-700">Type</label>
                <select value={form.type}
                  onChange={(e) => setForm({ ...form, type: e.target.value })}
                  className="mt-1 block w-full border rounded-lg px-3 py-2">
                  {TYPES.map((t) => <option key={t}>{t}</option>)}
                </select>
                {form.type === COMP_OFF && (
                  <p className="mt-1 text-xs text-violet-700">
                    Working this day is eligible for double pay, once approved.
                  </p>
                )}
              </div>
              <div>
                <label className="block text-sm text-gray-700">Description</label>
                <input value={form.description}
                  onChange={(e) => setForm({ ...form, description: e.target.value })}
                  className="mt-1 block w-full border rounded-lg px-3 py-2" />
              </div>
              {error && (
                <div className="text-sm text-red-700 bg-red-50 border border-red-200 px-3 py-2 rounded-lg">{error}</div>
              )}
              <div className="flex justify-end gap-2 pt-2">
                <button type="button" onClick={() => setShowModal(false)}
                  className="px-4 py-2 text-sm border rounded-lg hover:bg-gray-50">Cancel</button>
                <button type="submit" disabled={saving}
                  className="px-4 py-2 text-sm bg-gray-900 text-white rounded-lg hover:bg-gray-700 disabled:opacity-60">
                  {saving ? 'Saving…' : 'Save'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {showImport && (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center px-4 z-50 overflow-y-auto py-8">
          <div className="bg-white rounded-xl shadow-lg w-full max-w-xl p-6">
            <h2 className="card-title mb-1">Import calendar from Excel</h2>
            <p className="text-sm text-gray-500 mb-4">
              One workbook, three sheets — <strong>Holidays</strong>, <strong>Comp Offs</strong> and{' '}
              <strong>Celebrations</strong>. Fill in only the sheets you need; the example row in each is ignored.
              Entries already on the calendar (same name, same day) are skipped, so a corrected file can be re-uploaded.
            </p>

            <form onSubmit={runImport} className="space-y-3">
              <input ref={importFileRef} type="file" accept=".xlsx"
                className="block w-full text-sm border rounded-lg px-3 py-2" />

              {importResult?.errorBanner && (
                <div className="text-sm text-red-700 bg-red-50 border border-red-200 px-3 py-2 rounded-lg">
                  {importResult.errorBanner}
                </div>
              )}

              {importResult?.created && (
                <div className="space-y-2">
                  <div className="grid grid-cols-3 gap-2 text-center">
                    {[
                      ['Holidays', importResult.created.holidays],
                      ['Comp off days', importResult.created.compOffs],
                      ['Celebrations', importResult.created.celebrations],
                    ].map(([label, n]) => (
                      <div key={label} className="rounded-lg border border-green-200 bg-green-50 px-3 py-2">
                        <div className="text-lg font-semibold text-green-800">{n}</div>
                        <div className="text-xs text-green-700">{label} added</div>
                      </div>
                    ))}
                  </div>

                  {importResult.skipped?.length > 0 && (
                    <details className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm">
                      <summary className="cursor-pointer text-amber-800">
                        {importResult.skipped.length} row(s) skipped
                      </summary>
                      <ul className="mt-1 space-y-0.5 text-xs text-amber-900">
                        {importResult.skipped.map((s, i) => (
                          <li key={i}>{s.sheet} row {s.row}: {s.message}</li>
                        ))}
                      </ul>
                    </details>
                  )}

                  {importResult.errors?.length > 0 && (
                    <details open className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm">
                      <summary className="cursor-pointer text-red-800">
                        {importResult.errors.length} row(s) could not be imported
                      </summary>
                      <ul className="mt-1 space-y-0.5 text-xs text-red-900">
                        {importResult.errors.map((s, i) => (
                          <li key={i}>{s.sheet} row {s.row}: {s.message}</li>
                        ))}
                      </ul>
                    </details>
                  )}
                </div>
              )}

              <div className="flex justify-between items-center gap-2 pt-2">
                <button type="button"
                  onClick={() => downloadFile('/holidays/template.xlsx', 'calendar-import-template.xlsx')}
                  className="text-sm text-blue-600 hover:underline">
                  Download the template
                </button>
                <span className="flex gap-2">
                  <button type="button" onClick={closeImport}
                    className="px-4 py-2 text-sm border rounded-lg hover:bg-gray-50">
                    {importResult?.created ? 'Done' : 'Cancel'}
                  </button>
                  <button type="submit" disabled={importing}
                    className="px-4 py-2 text-sm bg-gray-900 text-white rounded-lg hover:bg-gray-700 disabled:opacity-60">
                    {importing ? 'Importing…' : 'Upload'}
                  </button>
                </span>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
