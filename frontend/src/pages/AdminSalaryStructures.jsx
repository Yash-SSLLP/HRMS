/**
 * AdminSalaryStructures — reusable CTC templates (admin portal). Lists structures
 * from GET /salary-structures and CRUDs them via /salary-structures; each stores
 * component percentages of CTC. A preview modal posts an annual CTC to
 * POST /salary-structures/:id/preview to show the monthly/annual breakdown.
 */
import { useEffect, useState } from 'react';
import { toast } from 'react-toastify';
import api from '../api/client';
import PageHeader from '../components/PageHeader';
import { confirmDialog } from '../components/dialogs';

const inr = new Intl.NumberFormat('en-IN', {
  style: 'currency',
  currency: 'INR',
  maximumFractionDigits: 0,
});

// [stateKey, label, default] for each percentage component
const PCT_FIELDS = [
  ['basicPct', 'Basic', 40],
  ['hraPct', 'HRA', 20],
  ['specialAllowancePct', 'Special Allowance', 25],
  ['conveyancePct', 'Conveyance', 5],
  ['medicalPct', 'Medical', 5],
  ['ltaPct', 'LTA', 5],
];

// Rows shown in the preview breakdown table: [responseKey, label]
const PREVIEW_ROWS = [
  ['basic', 'Basic'],
  ['hra', 'HRA'],
  ['specialAllowance', 'Special Allowance'],
  ['conveyance', 'Conveyance'],
  ['medical', 'Medical'],
  ['lta', 'LTA'],
];

const blankComponents = () =>
  PCT_FIELDS.reduce((acc, [key, , def]) => ({ ...acc, [key]: def }), {});

const blankForm = () => ({
  name: '',
  description: '',
  isActive: true,
  components: blankComponents(),
});

export default function AdminSalaryStructures() {
  const [structures, setStructures] = useState([]);
  const [employees, setEmployees] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const [showModal, setShowModal] = useState(false);
  const [editingId, setEditingId] = useState(null);
  const [form, setForm] = useState(blankForm());
  // Optional "assign this structure to an employee" alongside create/edit.
  const [assign, setAssign] = useState({ employee: '', annualCtc: '' });
  const [saving, setSaving] = useState(false);

  // Preview modal
  const [previewFor, setPreviewFor] = useState(null);
  const [annualCtc, setAnnualCtc] = useState(1200000);
  const [preview, setPreview] = useState(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [previewError, setPreviewError] = useState('');

  const load = async () => {
    setLoading(true);
    setError('');
    try {
      const res = await api.get('/salary-structures');
      setStructures(res.data.structures);
    } catch (err) {
      setError(err.response?.data?.message || 'Failed to load salary structures');
    } finally {
      setLoading(false);
    }
  };
  useEffect(() => {
    load();
    // Employees for the optional "assign to employee" picker.
    api.get('/employees?excludeExecutives=true')
      .then(({ data }) => setEmployees((data.profiles || []).filter((p) => p.user)))
      .catch(() => {});
  }, []);

  // Component percentages must sum to at most 100% of CTC; block save if over.
  const totalPct = PCT_FIELDS.reduce(
    (sum, [key]) => sum + (Number(form.components[key]) || 0),
    0
  );
  const overLimit = totalPct > 100;

  const openCreate = () => {
    setEditingId(null);
    setForm(blankForm());
    setAssign({ employee: '', annualCtc: '' });
    setError('');
    setShowModal(true);
  };
  const openEdit = (s) => {
    setEditingId(s._id);
    setForm({
      name: s.name,
      description: s.description || '',
      isActive: s.isActive,
      components: { ...blankComponents(), ...(s.components || {}) },
    });
    setAssign({ employee: '', annualCtc: '' });
    setError('');
    setShowModal(true);
  };

  const setPct = (key, value) =>
    setForm((f) => ({ ...f, components: { ...f.components, [key]: value } }));

  const save = async (e) => {
    e.preventDefault();
    if (overLimit) return;
    setSaving(true);
    setError('');
    try {
      // 1) Create or update the structure template.
      let structureId = editingId;
      if (editingId) {
        await api.put(`/salary-structures/${editingId}`, form);
      } else {
        const { data } = await api.post('/salary-structures', form);
        structureId = data.structure._id;
      }
      // 2) Optionally assign it (and CTC) to the chosen employee.
      if (assign.employee && structureId) {
        const { data } = await api.post(`/salary-structures/${structureId}/assign`, {
          employee: assign.employee,
          annualCtc: assign.annualCtc === '' ? undefined : Number(assign.annualCtc),
        });
        const emp = employees.find((p) => p._id === assign.employee);
        const name = emp ? `${emp.user?.firstName || ''} ${emp.user?.lastName || ''}`.trim() : 'the employee';
        toast.success(`Structure assigned to ${name}${data.annualCtc ? ` · CTC ₹${Number(data.annualCtc).toLocaleString('en-IN')}` : ''}`);
      }
      setShowModal(false);
      await load();
    } catch (err) {
      setError(err.response?.data?.message || 'Save failed');
    } finally {
      setSaving(false);
    }
  };

  const remove = async (s) => {
    if (!(await confirmDialog({ message: `Delete salary structure "${s.name}"?`, tone: 'danger', confirmText: 'Delete' }))) return;
    try {
      await api.delete(`/salary-structures/${s._id}`);
      await load();
    } catch (err) {
      toast.error(err.response?.data?.message || 'Delete failed');
    }
  };

  const openPreview = (s) => {
    setPreviewFor(s);
    setPreview(null);
    setPreviewError('');
    runPreview(s._id, annualCtc);
  };

  const runPreview = async (id, ctc) => {
    setPreviewLoading(true);
    setPreviewError('');
    try {
      const res = await api.post(`/salary-structures/${id}/preview`, { annualCtc: Number(ctc) || 0 });
      setPreview(res.data);
    } catch (err) {
      setPreviewError(err.response?.data?.message || 'Preview failed');
    } finally {
      setPreviewLoading(false);
    }
  };

  const onCtcChange = (value) => {
    setAnnualCtc(value);
    if (previewFor) runPreview(previewFor._id, value);
  };

  const summary = (c = {}) =>
    `Basic ${c.basicPct || 0}% · HRA ${c.hraPct || 0}% · Special ${c.specialAllowancePct || 0}%`;

  return (
    <div>
      <PageHeader title="Salary Structures" subtitle="Reusable CTC templates">
        <button
          onClick={openCreate}
          className="px-4 py-2 bg-gray-900 text-white rounded-lg hover:bg-gray-700 text-sm"
        >
          + New Structure
        </button>
      </PageHeader>

      {error && (
        <div className="mb-4 text-sm text-red-700 bg-red-50 border border-red-200 px-3 py-2 rounded-lg">
          {error}
        </div>
      )}

      <div className="bg-white shadow rounded-lg overflow-hidden">
        <table className="min-w-full divide-y divide-gray-200 text-sm">
          <thead className="bg-gray-50">
            <tr>
              <th className="px-4 py-3 text-left font-medium text-gray-700">Name</th>
              <th className="px-4 py-3 text-left font-medium text-gray-700">Description</th>
              <th className="px-4 py-3 text-left font-medium text-gray-700">Components</th>
              <th className="px-4 py-3 text-left font-medium text-gray-700">Status</th>
              <th className="px-4 py-3 text-right font-medium text-gray-700">Actions</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100">
            {loading ? (
              <tr>
                <td colSpan={5} className="px-4 py-6 text-center text-gray-500">
                  Loading…
                </td>
              </tr>
            ) : structures.length === 0 ? (
              <tr>
                <td colSpan={5} className="px-4 py-6 text-center text-gray-500">
                  No salary structures yet
                </td>
              </tr>
            ) : (
              structures.map((s) => (
                <tr key={s._id}>
                  <td className="px-4 py-3 font-medium text-gray-900">{s.name}</td>
                  <td className="px-4 py-3 text-gray-600">{s.description || '-'}</td>
                  <td className="px-4 py-3 text-xs text-gray-500">{summary(s.components)}</td>
                  <td className="px-4 py-3">
                    <span
                      className={`text-xs px-2 py-0.5 rounded-lg ${
                        s.isActive ? 'bg-green-100 text-green-800' : 'bg-gray-200 text-gray-600'
                      }`}
                    >
                      {s.isActive ? 'Active' : 'Inactive'}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-right space-x-2">
                    <button
                      onClick={() => openPreview(s)}
                      className="text-emerald-700 hover:underline"
                    >
                      Preview
                    </button>
                    <button onClick={() => openEdit(s)} className="text-blue-600 hover:underline">
                      Edit
                    </button>
                    <button onClick={() => remove(s)} className="text-red-600 hover:underline">
                      Delete
                    </button>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      {/* Create / Edit modal */}
      {showModal && (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center px-4 z-50 overflow-y-auto py-8">
          <div className="bg-white rounded-xl shadow-lg w-full max-w-2xl p-6">
            <h2 className="card-title mb-4">{editingId ? 'Edit Structure' : 'New Structure'}</h2>
            <form onSubmit={save} className="space-y-3">
              <input
                required
                placeholder="Name *"
                value={form.name}
                onChange={(e) => setForm({ ...form, name: e.target.value })}
                className="block w-full border rounded-lg px-3 py-2"
              />
              <textarea
                rows={2}
                placeholder="Description"
                value={form.description}
                onChange={(e) => setForm({ ...form, description: e.target.value })}
                className="block w-full border rounded-lg px-3 py-2"
              />
              <label className="flex items-center gap-2 text-sm text-gray-700">
                <input
                  type="checkbox"
                  checked={form.isActive}
                  onChange={(e) => setForm({ ...form, isActive: e.target.checked })}
                />
                Active
              </label>

              <div className="border-t pt-3">
                <div className="text-xs font-medium text-gray-500 mb-2">
                  Components (% of annual CTC)
                </div>
                <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
                  {PCT_FIELDS.map(([key, label]) => (
                    <label key={key} className="text-sm text-gray-700">
                      <span className="block mb-1 text-xs">{label}</span>
                      <input
                        type="number"
                        min="0"
                        max="100"
                        value={form.components[key]}
                        onChange={(e) => setPct(key, e.target.value)}
                        className="block w-full border rounded-lg px-3 py-2"
                      />
                    </label>
                  ))}
                </div>
                <div
                  className={`mt-3 text-sm font-medium ${
                    overLimit ? 'text-red-600' : 'text-gray-700'
                  }`}
                >
                  Total: {totalPct}%
                  {overLimit && <span className="ml-2">- must not exceed 100%</span>}
                </div>
              </div>

              {/* Optional: assign this structure to an employee */}
              <div className="border-t pt-3">
                <div className="text-xs font-medium text-gray-500 mb-2">Assign to an employee (optional)</div>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  <label className="text-sm text-gray-700">
                    <span className="block mb-1 text-xs">Employee</span>
                    <select
                      value={assign.employee}
                      onChange={(e) => setAssign({ ...assign, employee: e.target.value })}
                      className="block w-full border rounded-lg px-3 py-2 bg-white"
                    >
                      <option value="">— none —</option>
                      {employees.map((p) => (
                        <option key={p._id} value={p._id}>
                          {p.employeeCode} · {p.user?.firstName} {p.user?.lastName}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label className="text-sm text-gray-700">
                    <span className="block mb-1 text-xs">Annual CTC (₹)</span>
                    <input
                      type="number"
                      min="0"
                      disabled={!assign.employee}
                      value={assign.annualCtc}
                      onChange={(e) => setAssign({ ...assign, annualCtc: e.target.value })}
                      placeholder="keep current"
                      className="block w-full border rounded-lg px-3 py-2 disabled:bg-gray-100"
                    />
                  </label>
                </div>
                {assign.employee && (
                  <p className="text-[11px] text-gray-400 mt-1">
                    This sets the employee's salary structure{assign.annualCtc ? ' and annual CTC' : ' (CTC left unchanged — enter it to make payroll derivable)'}. You can also do this in Monthly Payroll Run.
                  </p>
                )}
              </div>

              {error && (
                <div className="text-sm text-red-700 bg-red-50 border border-red-200 px-3 py-2 rounded-lg">
                  {error}
                </div>
              )}
              <div className="flex justify-end gap-2 pt-2">
                <button
                  type="button"
                  onClick={() => setShowModal(false)}
                  className="px-4 py-2 text-sm border rounded-lg hover:bg-gray-50"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={saving || overLimit}
                  className="px-4 py-2 text-sm bg-gray-900 text-white rounded-lg hover:bg-gray-700 disabled:opacity-60"
                >
                  {saving ? 'Saving…' : 'Save'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Preview modal */}
      {previewFor && (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center px-4 z-50 overflow-y-auto py-8">
          <div className="bg-white rounded-xl shadow-lg w-full max-w-lg p-6">
            <h2 className="card-title mb-1">Preview · {previewFor.name}</h2>
            <p className="text-xs text-gray-500 mb-4">
              Enter an annual CTC to see the monthly and annual breakdown.
            </p>

            <label className="block text-sm text-gray-700 mb-4">
              <span className="block mb-1 text-xs">Annual CTC (₹)</span>
              <input
                type="number"
                min="0"
                value={annualCtc}
                onChange={(e) => onCtcChange(e.target.value)}
                className="block w-full border rounded-lg px-3 py-2"
              />
            </label>

            {previewError && (
              <div className="mb-3 text-sm text-red-700 bg-red-50 border border-red-200 px-3 py-2 rounded-lg">
                {previewError}
              </div>
            )}

            {previewLoading ? (
              <div className="py-6 text-center text-gray-500 text-sm">Calculating…</div>
            ) : preview ? (
              <table className="min-w-full divide-y divide-gray-200 text-sm">
                <thead className="bg-gray-50">
                  <tr>
                    <th className="px-3 py-2 text-left font-medium text-gray-700">Component</th>
                    <th className="px-3 py-2 text-right font-medium text-gray-700">Monthly</th>
                    <th className="px-3 py-2 text-right font-medium text-gray-700">Annual</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100">
                  {PREVIEW_ROWS.map(([key, label]) => (
                    <tr key={key}>
                      <td className="px-3 py-2 text-gray-700">{label}</td>
                      <td className="px-3 py-2 text-right">{inr.format(preview.monthly[key] || 0)}</td>
                      <td className="px-3 py-2 text-right">{inr.format(preview.annual[key] || 0)}</td>
                    </tr>
                  ))}
                  <tr className="font-semibold bg-gray-50">
                    <td className="px-3 py-2 text-gray-900">Gross</td>
                    <td className="px-3 py-2 text-right">{inr.format(preview.monthlyGross || 0)}</td>
                    <td className="px-3 py-2 text-right">{inr.format(preview.annualGross || 0)}</td>
                  </tr>
                </tbody>
              </table>
            ) : (
              <div className="py-6 text-center text-gray-500 text-sm">No preview yet</div>
            )}

            <div className="flex justify-end gap-2 pt-4">
              <button
                type="button"
                onClick={() => {
                  setPreviewFor(null);
                  setPreview(null);
                }}
                className="px-4 py-2 text-sm border rounded-lg hover:bg-gray-50"
              >
                Close
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
