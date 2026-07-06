import { useEffect, useMemo, useState } from 'react';
import api from '../api/client';
import { downloadFile } from '../api/download';
import { apiPublicUrl } from '../api/compose';
import PageHeader from '../components/PageHeader';
import MailComposeModal from '../components/MailComposeModal';

const MONTHS = [
  'January','February','March','April','May','June',
  'July','August','September','October','November','December',
];

const STATUS_COLORS = {
  Draft: 'bg-gray-100 text-gray-700',
  Approved: 'bg-blue-100 text-blue-800',
  Paid: 'bg-green-100 text-green-800',
  OnHold: 'bg-amber-100 text-amber-800',
};

const blankSlip = () => ({
  employee: '',
  payPeriodYear: new Date().getFullYear(),
  payPeriodMonth: new Date().getMonth() + 1,
  workingDays: 30,
  paidDays: 30,
  lopDays: 0,
  earnings: { basic: 0, hra: 0, specialAllowance: 0, conveyanceAllowance: 0, medicalAllowance: 0, lta: 0, bonus: 0, overtime: 0, otherEarnings: 0 },
  deductions: { epf: 0, esic: 0, professionalTax: 0, tds: 0, loanRecovery: 0, otherDeductions: 0 },
});

const inr = (n) =>
  new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', maximumFractionDigits: 0 }).format(n || 0);

export default function AdminPayroll() {
  const [payslips, setPayslips] = useState([]);
  const [employees, setEmployees] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [filter, setFilter] = useState({ year: new Date().getFullYear(), month: '', status: '' });

  const [showModal, setShowModal] = useState(false);
  const [editingId, setEditingId] = useState(null);
  const [form, setForm] = useState(blankSlip());
  const [saving, setSaving] = useState(false);
  const [mail, setMail] = useState(null); // editable compose modal payload

  const load = async () => {
    setLoading(true);
    setError('');
    try {
      const params = new URLSearchParams();
      if (filter.year) params.set('year', filter.year);
      if (filter.month) params.set('month', filter.month);
      if (filter.status) params.set('status', filter.status);
      const [slipsRes, empRes] = await Promise.all([
        api.get(`/payroll?${params}`),
        api.get('/employees?excludeExecutives=true'),
      ]);
      setPayslips(slipsRes.data.payslips);
      setEmployees(empRes.data.profiles);
    } catch (err) {
      setError(err.response?.data?.message || 'Failed to load');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); /* eslint-disable-next-line */ }, [filter]);

  const gross = useMemo(() =>
    Object.values(form.earnings).reduce((a, b) => a + Number(b || 0), 0), [form.earnings]);
  const totalDed = useMemo(() =>
    Object.values(form.deductions).reduce((a, b) => a + Number(b || 0), 0), [form.deductions]);
  const net = gross - totalDed;

  const openCreate = () => {
    setEditingId(null);
    setForm(blankSlip());
    setShowModal(true);
  };

  const openEdit = (p) => {
    setEditingId(p._id);
    setForm({
      employee: p.employee?._id || p.employee,
      payPeriodYear: p.payPeriodYear,
      payPeriodMonth: p.payPeriodMonth,
      workingDays: p.workingDays,
      paidDays: p.paidDays,
      lopDays: p.lopDays,
      earnings: { ...blankSlip().earnings, ...(p.earnings || {}) },
      deductions: { ...blankSlip().deductions, ...(p.deductions || {}) },
    });
    setShowModal(true);
  };

  const onSave = async (e) => {
    e.preventDefault();
    setSaving(true);
    setError('');
    try {
      if (editingId) {
        await api.put(`/payroll/${editingId}`, form);
      } else {
        await api.post('/payroll', form);
      }
      setShowModal(false);
      await load();
    } catch (err) {
      setError(err.response?.data?.message || 'Save failed');
    } finally {
      setSaving(false);
    }
  };

  const doAction = async (id, action) => {
    try {
      if (action === 'delete') {
        if (!window.confirm('Delete this draft payslip?')) return;
        await api.delete(`/payroll/${id}`);
      } else {
        await api.patch(`/payroll/${id}/${action}`);
      }
      await load();
    } catch (err) {
      alert(err.response?.data?.message || 'Action failed');
    }
  };

  // Email a payslip: generate a public (no-login) download link, then open the
  // editable composer with that link inserted so HR can tweak before sending.
  const emailPayslip = async (p) => {
    const email = p.employee?.user?.email;
    if (!email) { alert('No email on file for this employee.'); return; }
    const period = `${MONTHS[p.payPeriodMonth - 1]} ${p.payPeriodYear}`;
    const name = `${p.employee?.user?.firstName || ''} ${p.employee?.user?.lastName || ''}`.trim();
    try {
      const { data } = await api.post(`/payroll/${p._id}/share`);
      const link = apiPublicUrl(`/payroll/public/${data.token}`);
      setMail({
        to: email,
        title: 'Send payslip',
        link,
        defaultSubject: `Payslip · ${period}`,
        defaultBody:
          `Dear ${name || 'Employee'},\n\n` +
          `Your payslip for ${period} is ready. You can view and download it from the link below:\n\n` +
          `${link}\n\n` +
          `Regards,\nHR`,
        onSent: async () => {
          await api.post(`/payroll/${p._id}/mark-sent`);
          await load();
        },
      });
    } catch (err) {
      alert(err.response?.data?.message || 'Could not prepare the payslip link');
    }
  };

  const updateNum = (group, key, v) => {
    setForm((f) => ({ ...f, [group]: { ...f[group], [key]: Number(v) || 0 } }));
  };

  return (
    <div>
      <PageHeader title="Payroll">
        <button
          onClick={() => {
            const m = Number(filter.month) || new Date().getMonth() + 1;
            const q = `year=${filter.year}&month=${m}${filter.status ? `&status=${filter.status}` : ''}`;
            downloadFile(`/payroll/export?${q}`, `payroll-${filter.year}-${String(m).padStart(2, '0')}.csv`)
              .catch((err) => alert(err.response?.data?.message || 'Export failed'));
          }}
          title={filter.month ? 'Download this month\'s payroll as an Excel-compatible sheet' : 'No month selected · exports the current month'}
          className="px-4 py-2 border border-gray-300 rounded-lg hover:bg-gray-50 text-sm mr-2">
          ⬇ Download Excel
        </button>
        <button onClick={openCreate}
          className="px-4 py-2 bg-gray-900 text-white rounded-lg hover:bg-gray-700 text-sm">
          + New Payslip
        </button>
      </PageHeader>

      <div className="bg-white p-3 rounded-lg shadow-sm mb-4 flex gap-3 items-end flex-wrap">
        <div>
          <label className="block text-xs text-gray-600">Year</label>
          <input type="number" value={filter.year}
            onChange={(e) => setFilter({ ...filter, year: Number(e.target.value) })}
            className="border rounded-lg px-2 py-1 w-24" />
        </div>
        <div>
          <label className="block text-xs text-gray-600">Month</label>
          <select value={filter.month} onChange={(e) => setFilter({ ...filter, month: e.target.value })}
            className="border rounded-lg px-2 py-1">
            <option value="">All</option>
            {MONTHS.map((m, i) => <option key={m} value={i + 1}>{m}</option>)}
          </select>
        </div>
        <div>
          <label className="block text-xs text-gray-600">Status</label>
          <select value={filter.status} onChange={(e) => setFilter({ ...filter, status: e.target.value })}
            className="border rounded-lg px-2 py-1">
            <option value="">All</option>
            {['Draft', 'Approved', 'Paid', 'OnHold'].map((s) => <option key={s}>{s}</option>)}
          </select>
        </div>
      </div>

      {error && (
        <div className="mb-4 text-sm text-red-700 bg-red-50 border border-red-200 px-3 py-2 rounded-lg">{error}</div>
      )}

      <div className="bg-white shadow rounded-lg overflow-hidden">
        <table className="min-w-full divide-y divide-gray-200 text-sm">
          <thead className="bg-gray-50">
            <tr>
              <th className="px-4 py-3 text-left font-medium text-gray-700">Employee</th>
              <th className="px-4 py-3 text-left font-medium text-gray-700">Period</th>
              <th className="px-4 py-3 text-right font-medium text-gray-700">Gross</th>
              <th className="px-4 py-3 text-right font-medium text-gray-700">Deductions</th>
              <th className="px-4 py-3 text-right font-medium text-gray-700">Net</th>
              <th className="px-4 py-3 text-left font-medium text-gray-700">Status</th>
              <th className="px-4 py-3 text-right font-medium text-gray-700">Actions</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100">
            {loading ? (
              <tr><td colSpan={7} className="px-4 py-4"><div className="space-y-2.5"><div className="skeleton h-4 rounded" /><div className="skeleton h-4 rounded w-5/6" /><div className="skeleton h-4 rounded w-2/3" /></div></td></tr>
            ) : payslips.length === 0 ? (
              <tr><td colSpan={7} className="px-4 py-6 text-center text-gray-500">No payslips</td></tr>
            ) : payslips.map((p) => (
              <tr key={p._id}>
                <td className="px-4 py-3">
                  {p.employee?.user?.firstName} {p.employee?.user?.lastName}
                  <div className="text-xs text-gray-500 font-mono">{p.employee?.employeeCode}</div>
                </td>
                <td className="px-4 py-3">{MONTHS[p.payPeriodMonth - 1]} {p.payPeriodYear}</td>
                <td className="px-4 py-3 text-right">{inr(p.grossSalary)}</td>
                <td className="px-4 py-3 text-right">{inr(p.totalDeductions)}</td>
                <td className="px-4 py-3 text-right font-semibold">{inr(p.netPay)}</td>
                <td className="px-4 py-3">
                  <span className={`inline-block px-2 py-0.5 text-xs rounded-lg ${STATUS_COLORS[p.status]}`}>{p.status}</span>
                </td>
                <td className="px-4 py-3 text-right space-x-2 whitespace-nowrap">
                  {p.status === 'Draft' && (
                    <>
                      <button onClick={() => openEdit(p)} className="text-blue-600 hover:underline">Edit</button>
                      <button onClick={() => doAction(p._id, 'approve')} className="text-green-700 hover:underline">Approve</button>
                      <button onClick={() => doAction(p._id, 'delete')} className="text-red-600 hover:underline">Delete</button>
                    </>
                  )}
                  {p.status === 'Approved' && (
                    <button onClick={() => doAction(p._id, 'pay')} className="text-green-700 hover:underline">Mark Paid</button>
                  )}
                  {(p.status === 'Approved' || p.status === 'Paid') && (
                    <>
                      <button
                        onClick={() => downloadFile(
                          `/payroll/${p._id}/pdf`,
                          `payslip-${p.employee?.employeeCode || 'employee'}-${p.payPeriodYear}-${String(p.payPeriodMonth).padStart(2, '0')}.pdf`
                        )}
                        className="text-blue-600 hover:underline">PDF</button>
                      <button onClick={() => emailPayslip(p)} className="text-indigo-600 hover:underline">{p.emailedAt ? 'Resend' : 'Email'}</button>
                    </>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {showModal && (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center px-4 z-50 overflow-y-auto py-8">
          <div className="bg-white rounded-xl shadow-lg w-full max-w-3xl p-6">
            <h2 className="card-title mb-4">
              {editingId ? 'Edit Payslip (Draft)' : 'New Payslip'}
            </h2>
            <form onSubmit={onSave} className="space-y-3">
              <div className="grid grid-cols-3 gap-3">
                <div className="col-span-1">
                  <label className="block text-sm text-gray-700">Employee *</label>
                  <select
                    required disabled={!!editingId}
                    value={form.employee}
                    onChange={(e) => setForm({ ...form, employee: e.target.value })}
                    className="mt-1 block w-full border rounded-lg px-3 py-2 disabled:bg-gray-100"
                  >
                    <option value="">Select…</option>
                    {employees.map((e) => (
                      <option key={e._id} value={e._id}>
                        {e.employeeCode} · {e.user?.firstName} {e.user?.lastName}
                      </option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className="block text-sm text-gray-700">Year *</label>
                  <input type="number" required disabled={!!editingId}
                    value={form.payPeriodYear}
                    onChange={(e) => setForm({ ...form, payPeriodYear: Number(e.target.value) })}
                    className="mt-1 block w-full border rounded-lg px-3 py-2 disabled:bg-gray-100" />
                </div>
                <div>
                  <label className="block text-sm text-gray-700">Month *</label>
                  <select required disabled={!!editingId}
                    value={form.payPeriodMonth}
                    onChange={(e) => setForm({ ...form, payPeriodMonth: Number(e.target.value) })}
                    className="mt-1 block w-full border rounded-lg px-3 py-2 disabled:bg-gray-100">
                    {MONTHS.map((m, i) => <option key={m} value={i + 1}>{m}</option>)}
                  </select>
                </div>
              </div>

              <div className="grid grid-cols-3 gap-3">
                <div>
                  <label className="block text-sm text-gray-700">Working Days</label>
                  <input type="number" value={form.workingDays}
                    onChange={(e) => setForm({ ...form, workingDays: Number(e.target.value) })}
                    className="mt-1 block w-full border rounded-lg px-3 py-2" />
                </div>
                <div>
                  <label className="block text-sm text-gray-700">Paid Days</label>
                  <input type="number" value={form.paidDays}
                    onChange={(e) => setForm({ ...form, paidDays: Number(e.target.value) })}
                    className="mt-1 block w-full border rounded-lg px-3 py-2" />
                </div>
                <div>
                  <label className="block text-sm text-gray-700">LOP Days</label>
                  <input type="number" value={form.lopDays}
                    onChange={(e) => setForm({ ...form, lopDays: Number(e.target.value) })}
                    className="mt-1 block w-full border rounded-lg px-3 py-2" />
                </div>
              </div>

              <h3 className="text-sm font-semibold text-gray-700 pt-3 border-t">Earnings (₹)</h3>
              <div className="grid grid-cols-3 gap-3">
                {Object.keys(form.earnings).map((k) => (
                  <div key={k}>
                    <label className="block text-xs text-gray-600 capitalize">{k.replace(/([A-Z])/g, ' $1')}</label>
                    <input type="number" value={form.earnings[k]}
                      onChange={(e) => updateNum('earnings', k, e.target.value)}
                      className="mt-1 block w-full border rounded-lg px-2 py-1" />
                  </div>
                ))}
              </div>

              <h3 className="text-sm font-semibold text-gray-700 pt-3 border-t">Deductions (₹)</h3>
              <div className="grid grid-cols-3 gap-3">
                {Object.keys(form.deductions).map((k) => (
                  <div key={k}>
                    <label className="block text-xs text-gray-600 capitalize">{k.replace(/([A-Z])/g, ' $1')}</label>
                    <input type="number" value={form.deductions[k]}
                      onChange={(e) => updateNum('deductions', k, e.target.value)}
                      className="mt-1 block w-full border rounded-lg px-2 py-1" />
                  </div>
                ))}
              </div>

              <div className="grid grid-cols-3 gap-3 pt-3 border-t text-sm">
                <div className="bg-gray-50 rounded-lg p-2">Gross: <strong>{inr(gross)}</strong></div>
                <div className="bg-gray-50 rounded-lg p-2">Deductions: <strong>{inr(totalDed)}</strong></div>
                <div className="bg-gray-50 rounded-lg p-2">Net: <strong>{inr(net)}</strong></div>
              </div>

              {error && (
                <div className="text-sm text-red-700 bg-red-50 border border-red-200 px-3 py-2 rounded-lg">{error}</div>
              )}

              <div className="flex justify-end gap-2 pt-2">
                <button type="button" onClick={() => setShowModal(false)}
                  className="px-4 py-2 text-sm border rounded-lg hover:bg-gray-50">Cancel</button>
                <button type="submit" disabled={saving}
                  className="px-4 py-2 text-sm bg-gray-900 text-white rounded-lg hover:bg-gray-700 disabled:opacity-60">
                  {saving ? 'Saving…' : 'Save Draft'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      <MailComposeModal open={!!mail} onClose={() => setMail(null)} {...(mail || {})} />
    </div>
  );
}
