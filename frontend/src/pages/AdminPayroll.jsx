/**
 * AdminPayroll — manual payslip management (admin portal). Lists/filters payslips
 * from GET /payroll (employees from GET /employees), creates/edits drafts via
 * POST/PUT /payroll, transitions status (approve/pay/delete) via
 * PATCH /payroll/:id/:action, exports CSV, downloads the PDF, and emails the
 * payslip from the company mailbox (POST /payroll/:id/email). Bulk runs live on AdminPayrollRun.
 */
import { useEffect, useMemo, useState } from 'react';
import { toast } from 'react-toastify';
import api from '../api/client';
import { downloadFile } from '../api/download';
import PageHeader from '../components/PageHeader';
import MailComposeModal from '../components/MailComposeModal';
import { confirmDialog } from '../components/dialogs';

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
  earnings: { basic: 0, hra: 0, specialAllowance: 0, conveyanceAllowance: 0, medicalAllowance: 0, lta: 0, bonus: 0, overtime: 0, leaveIncentive: 0, otherEarnings: 0 },
  deductions: { epf: 0, esic: 0, professionalTax: 0, tds: 0, loanRecovery: 0, latePenalty: 0, otherDeductions: 0 },
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
  const [salaryInfo, setSalaryInfo] = useState(null); // derived structure×CTC info for the editor
  const [bonusCalc, setBonusCalc] = useState({ type: 'fixed', value: '' });
  const [runModal, setRunModal] = useState(null); // org-wide "run payroll" modal state

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

  // Live gross/deductions/net totals for the payslip form footer.
  const gross = useMemo(() =>
    Object.values(form.earnings).reduce((a, b) => a + Number(b || 0), 0), [form.earnings]);
  const totalDed = useMemo(() =>
    Object.values(form.deductions).reduce((a, b) => a + Number(b || 0), 0), [form.deductions]);
  const net = gross - totalDed;

  const openCreate = () => {
    setEditingId(null);
    setForm(blankSlip());
    setSalaryInfo(null);
    setBonusCalc({ type: 'fixed', value: '' });
    setShowModal(true);
  };

  // ----- Org-wide "run payroll for everyone" -----
  const loadRunPreview = async (year, month) => {
    setRunModal((rm) => ({ ...rm, year, month, loadingPreview: true, result: null }));
    try {
      const { data } = await api.get(`/payroll/run?year=${year}&month=${month}`);
      setRunModal((rm) => ({ ...rm, preview: data, loadingPreview: false }));
    } catch (err) {
      toast.error(err.response?.data?.message || 'Could not load the run preview');
      setRunModal((rm) => ({ ...rm, loadingPreview: false }));
    }
  };

  const openRun = () => {
    const month = Number(filter.month) || new Date().getMonth() + 1;
    const year = filter.year || new Date().getFullYear();
    setRunModal({ year, month, preview: null, loadingPreview: true, running: false, result: null });
    loadRunPreview(year, month);
  };

  const executeRun = async () => {
    setRunModal((rm) => ({ ...rm, running: true }));
    try {
      const { data } = await api.post('/payroll/run', { year: runModal.year, month: runModal.month });
      toast.success(`Created ${data.created} draft payslip${data.created === 1 ? '' : 's'} · ${data.derived} from structure, ${data.copiedFromLast} copied`);
      setRunModal((rm) => ({ ...rm, running: false, result: data }));
      // Surface the new drafts in the list underneath.
      setFilter((f) => ({ ...f, year: runModal.year, month: runModal.month, status: '' }));
    } catch (err) {
      toast.error(err.response?.data?.message || 'Run failed');
      setRunModal((rm) => ({ ...rm, running: false }));
    }
  };

  const openEdit = (p) => {
    setEditingId(p._id);
    const employee = p.employee?._id || p.employee;
    setForm({
      employee,
      payPeriodYear: p.payPeriodYear,
      payPeriodMonth: p.payPeriodMonth,
      workingDays: p.workingDays,
      paidDays: p.paidDays,
      lopDays: p.lopDays,
      earnings: { ...blankSlip().earnings, ...(p.earnings || {}) },
      deductions: { ...blankSlip().deductions, ...(p.deductions || {}) },
    });
    setSalaryInfo(null);
    setBonusCalc({ type: 'fixed', value: '' });
    setShowModal(true);
    // Refresh the day counts from attendance, then reflect them in the derived
    // preview (without applying — the saved earnings/deductions are left intact).
    syncAttendanceDays({
      employee,
      payPeriodYear: p.payPeriodYear,
      payPeriodMonth: p.payPeriodMonth,
    }).then((days) => fetchSalaryInfo({
      over: {
        employee,
        payPeriodYear: p.payPeriodYear,
        payPeriodMonth: p.payPeriodMonth,
        paidDays: days?.paidDays ?? p.paidDays,
        workingDays: days?.workingDays ?? p.workingDays,
      },
    }));
  };

  // Load (and optionally apply) the earnings + statutory deductions derived from
  // the employee's assigned salary structure × CTC, prorated by paid days.
  const fetchSalaryInfo = async ({ apply = false, over = {} } = {}) => {
    const f = { ...form, ...over };
    if (!f.employee) { setSalaryInfo(null); return; }
    try {
      const params = new URLSearchParams({
        employee: f.employee,
        year: f.payPeriodYear,
        month: f.payPeriodMonth,
        paidDays: f.paidDays,
        daysInMonth: f.workingDays,
      });
      const { data } = await api.get(`/payroll/derive-salary?${params}`);
      setSalaryInfo(data);
      if (apply && !data.needsSetup) {
        setForm((prev) => ({
          ...prev,
          earnings: { ...prev.earnings, ...data.earnings },
          deductions: { ...prev.deductions, ...data.deductions },
        }));
        toast.success(`Filled from ${data.structure?.name || 'salary structure'}`);
      }
      return data;
    } catch (err) {
      toast.error(err.response?.data?.message || 'Could not load the salary structure');
    }
  };

  // Pull the attendance-normalized day counts (working / paid / LOP) for the
  // employee's month and write them into the form, so the payslip always reflects
  // real attendance — the same LOP + leave-quota normalization the payroll run
  // uses — instead of a manual guess or a copy of last month. Returns the days.
  const syncAttendanceDays = async (over = {}) => {
    const f = { ...form, ...over };
    if (!f.employee) return null;
    try {
      const { data } = await api.get(
        `/payroll/run-employee?employee=${f.employee}&year=${f.payPeriodYear}&month=${f.payPeriodMonth}`
      );
      const c = data.computed || {};
      const days = {
        workingDays: c.daysInMonth ?? f.workingDays,
        paidDays: c.paidDays ?? f.paidDays,
        lopDays: c.lopDays ?? f.lopDays,
      };
      setForm((prev) => ({ ...prev, ...days }));
      return days;
    } catch {
      return null; // attendance unavailable — keep whatever is in the form
    }
  };

  // Compute the bonus amount from the chosen basis and write it to the bonus earning.
  const applyBonus = () => {
    const val = Number(bonusCalc.value) || 0;
    let amt = 0;
    if (bonusCalc.type === 'fixed') amt = Math.round(val);
    else if (bonusCalc.type === 'pctBasic') amt = Math.round((Number(form.earnings.basic) || 0) * val / 100);
    else if (bonusCalc.type === 'pctGross') {
      const base = Object.entries(form.earnings).reduce((a, [k, v]) => a + (k === 'bonus' ? 0 : Number(v || 0)), 0);
      amt = Math.round(base * val / 100);
    }
    updateNum('earnings', 'bonus', amt);
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
        if (!(await confirmDialog({ message: 'Delete this draft payslip?', tone: 'danger', confirmText: 'Delete' }))) return;
        await api.delete(`/payroll/${id}`);
      } else {
        await api.patch(`/payroll/${id}/${action}`);
      }
      await load();
    } catch (err) {
      toast.error(err.response?.data?.message || 'Action failed');
    }
  };

  // Email a payslip: fetch the server-rendered editable preview, then send it
  // from the company mailbox with the payslip PDF attached (no Gmail hop).
  const emailPayslip = async (p) => {
    const email = p.employee?.user?.email;
    if (!email) { toast.error('No email on file for this employee.'); return; }
    try {
      const { data } = await api.post(`/payroll/${p._id}/email`, { preview: true });
      setMail({
        to: data.to,
        title: 'Send payslip',
        link: data.link,
        sendLabel: 'Send payslip',
        note: "Review and edit the message below · it's emailed from the company mailbox with the payslip PDF attached.",
        defaultSubject: data.subject,
        defaultBody: data.body,
        attachedNames: data.attachments || [],
        onSend: async ({ subject, body }) => {
          await api.post(`/payroll/${p._id}/email`, { subject, body });
          await load();
        },
      });
    } catch (err) {
      toast.error(err.response?.data?.message || 'Could not prepare the payslip email');
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
            const q = `year=${filter.year}&month=${m}`;
            // Server names the file payroll_<Month>-<Year>_<date>_<time>.xlsx (Content-Disposition).
            downloadFile(`/payroll/export-sheet?${q}`, `payroll-${filter.year}-${String(m).padStart(2, '0')}.xlsx`)
              .catch((err) => toast.error(err.response?.data?.message || 'Export failed'));
          }}
          title={filter.month ? 'Download this month\'s payroll register (.xlsx)' : 'No month selected · exports the current month'}
          className="px-4 py-2 border border-gray-300 rounded-lg hover:bg-gray-50 text-sm mr-2">
          ⬇ Download Excel
        </button>
        <button onClick={openRun}
          className="px-4 py-2 bg-indigo-600 text-white rounded-lg hover:bg-indigo-700 text-sm mr-2">
          ▶ Run Payroll
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
                    onChange={(e) => {
                      const employee = e.target.value;
                      setForm({ ...form, employee });
                      syncAttendanceDays({ employee }).then((days) =>
                        fetchSalaryInfo({ over: { employee, paidDays: days?.paidDays, workingDays: days?.workingDays } }));
                    }}
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
                    onChange={(e) => {
                      const payPeriodYear = Number(e.target.value);
                      setForm({ ...form, payPeriodYear });
                      if (form.employee) syncAttendanceDays({ payPeriodYear }).then((days) =>
                        fetchSalaryInfo({ over: { payPeriodYear, paidDays: days?.paidDays, workingDays: days?.workingDays } }));
                    }}
                    className="mt-1 block w-full border rounded-lg px-3 py-2 disabled:bg-gray-100" />
                </div>
                <div>
                  <label className="block text-sm text-gray-700">Month *</label>
                  <select required disabled={!!editingId}
                    value={form.payPeriodMonth}
                    onChange={(e) => {
                      const payPeriodMonth = Number(e.target.value);
                      setForm({ ...form, payPeriodMonth });
                      if (form.employee) syncAttendanceDays({ payPeriodMonth }).then((days) =>
                        fetchSalaryInfo({ over: { payPeriodMonth, paidDays: days?.paidDays, workingDays: days?.workingDays } }));
                    }}
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
              <p className="text-[11px] text-gray-400 -mt-1">
                Auto-filled from attendance (after LOP &amp; leave-quota normalization) · editable.
              </p>

              {/* Salary structure → derive earnings + statutory deductions */}
              <div className="pt-3 border-t">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="text-sm">
                    <span className="font-semibold text-gray-700">Salary structure: </span>
                    {salaryInfo == null ? (
                      <span className="text-gray-400">select an employee…</span>
                    ) : salaryInfo.needsSetup ? (
                      <span className="text-amber-700">not assigned — set structure &amp; CTC in Monthly Payroll Run</span>
                    ) : (
                      <span className="text-gray-700">{salaryInfo.structure?.name} · CTC {inr(salaryInfo.annualCtc)}/yr</span>
                    )}
                  </div>
                  <button type="button" disabled={!form.employee || !salaryInfo || salaryInfo.needsSetup}
                    onClick={() => fetchSalaryInfo({ apply: true })}
                    className="text-xs px-3 py-1.5 rounded-lg bg-indigo-600 text-white hover:bg-indigo-700 disabled:opacity-50">
                    Fill earnings &amp; deductions from structure
                  </button>
                </div>
                {salaryInfo && !salaryInfo.needsSetup && (
                  <p className="text-[11px] text-gray-400 mt-1">
                    Prorated by Paid Days ({form.paidDays}/{form.workingDays}) · PF/EPF &amp; ESI not deducted (₹0), PT ₹200 — all editable below.
                  </p>
                )}
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

              {/* Bonus calculator */}
              <div className="bg-gray-50 rounded-lg p-2 flex flex-wrap items-end gap-2 text-xs">
                <span className="font-semibold text-gray-600 self-center">Bonus calculator:</span>
                <select value={bonusCalc.type} onChange={(e) => setBonusCalc({ ...bonusCalc, value: bonusCalc.value, type: e.target.value })}
                  className="border rounded px-2 py-1">
                  <option value="fixed">Fixed ₹</option>
                  <option value="pctBasic">% of Basic</option>
                  <option value="pctGross">% of Monthly Gross</option>
                </select>
                <input type="number" min="0" value={bonusCalc.value}
                  onChange={(e) => setBonusCalc({ ...bonusCalc, value: e.target.value })}
                  placeholder={bonusCalc.type === 'fixed' ? 'Amount ₹' : 'Percent %'}
                  className="border rounded px-2 py-1 w-28" />
                <button type="button" onClick={applyBonus}
                  className="px-2.5 py-1 rounded bg-gray-900 text-white hover:bg-gray-700">Apply to Bonus</button>
                <span className="text-gray-400 self-center">→ current bonus {inr(form.earnings.bonus)}</span>
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

      {/* ===== Run payroll for everyone ===== */}
      {runModal && (() => {
        const rows = runModal.preview?.rows || [];
        const toGen = rows.filter((r) => !r.existingStatus);
        const willDerive = toGen.filter((r) => r.hasSalarySetup);
        const willCopy = toGen.filter((r) => !r.hasSalarySetup && r.source);
        const willBlank = toGen.filter((r) => !r.hasSalarySetup && !r.source);
        const tag = (r) => r.existingStatus
          ? ['already generated', 'bg-gray-100 text-gray-500']
          : r.hasSalarySetup
            ? ['from structure', 'bg-emerald-100 text-emerald-700']
            : r.source
              ? ['copy from last', 'bg-blue-100 text-blue-700']
              : ['needs setup', 'bg-amber-100 text-amber-700'];
        return (
          <div className="fixed inset-0 bg-black/40 flex items-center justify-center px-4 z-50 overflow-y-auto py-8">
            <div className="bg-white rounded-xl shadow-lg w-full max-w-3xl p-6">
              <div className="flex justify-between items-start mb-1">
                <h2 className="card-title">Run payroll for everyone</h2>
                <button onClick={() => setRunModal(null)} className="text-gray-400 hover:text-gray-700 text-xl leading-none">×</button>
              </div>
              <p className="text-sm text-gray-500 mb-4">
                Creates a Draft payslip for every active employee for the selected month. Existing payslips are never overwritten.
              </p>

              <div className="flex flex-wrap items-end gap-3 mb-4">
                <div>
                  <label className="block text-xs text-gray-600">Year</label>
                  <input type="number" value={runModal.year} disabled={!!runModal.result}
                    onChange={(e) => loadRunPreview(Number(e.target.value), runModal.month)}
                    className="border rounded-lg px-2 py-1 w-24 disabled:bg-gray-100" />
                </div>
                <div>
                  <label className="block text-xs text-gray-600">Month</label>
                  <select value={runModal.month} disabled={!!runModal.result}
                    onChange={(e) => loadRunPreview(runModal.year, Number(e.target.value))}
                    className="border rounded-lg px-2 py-1 disabled:bg-gray-100">
                    {MONTHS.map((m, i) => <option key={m} value={i + 1}>{m}</option>)}
                  </select>
                </div>
              </div>

              {runModal.result ? (
                <div className="space-y-3">
                  <div className="text-sm bg-green-50 border border-green-200 text-green-800 px-3 py-2 rounded-lg">
                    Created <strong>{runModal.result.created}</strong> draft payslip(s) for {MONTHS[runModal.month - 1]} {runModal.year}
                    {runModal.result.skippedExisting ? ` · skipped ${runModal.result.skippedExisting} existing` : ''}.
                  </div>
                  <div className="grid grid-cols-3 gap-2 text-sm">
                    <div className="bg-emerald-50 rounded-lg p-2 text-emerald-800">From structure: <strong>{runModal.result.derived}</strong></div>
                    <div className="bg-blue-50 rounded-lg p-2 text-blue-800">Copied from last: <strong>{runModal.result.copiedFromLast}</strong></div>
                    <div className="bg-amber-50 rounded-lg p-2 text-amber-800">Needs setup (blank): <strong>{runModal.result.needsSetup?.length || 0}</strong></div>
                  </div>
                  {runModal.result.needsSetup?.length > 0 && (
                    <div className="text-xs text-amber-700">
                      Assign a salary structure &amp; CTC (Monthly Payroll Run) for: {runModal.result.needsSetup.join(', ')}
                    </div>
                  )}
                  <div className="flex justify-end pt-1">
                    <button onClick={() => setRunModal(null)} className="px-4 py-2 text-sm bg-gray-900 text-white rounded-lg hover:bg-gray-700">Done</button>
                  </div>
                </div>
              ) : runModal.loadingPreview ? (
                <div className="text-gray-500 py-6 text-center">Loading preview…</div>
              ) : runModal.preview ? (
                <>
                  <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 text-sm mb-3">
                    <div className="bg-gray-50 rounded-lg p-2">To generate: <strong>{toGen.length}</strong></div>
                    <div className="bg-emerald-50 rounded-lg p-2 text-emerald-800">From structure: <strong>{willDerive.length}</strong></div>
                    <div className="bg-blue-50 rounded-lg p-2 text-blue-800">Copy from last: <strong>{willCopy.length}</strong></div>
                    <div className="bg-amber-50 rounded-lg p-2 text-amber-800">Needs setup: <strong>{willBlank.length}</strong></div>
                  </div>
                  <div className="border rounded-lg overflow-hidden max-h-72 overflow-y-auto">
                    <table className="min-w-full text-sm divide-y divide-gray-100">
                      <thead className="bg-gray-50 sticky top-0">
                        <tr>
                          <th className="px-3 py-2 text-left font-medium text-gray-600">Employee</th>
                          <th className="px-3 py-2 text-left font-medium text-gray-600">Source</th>
                          <th className="px-3 py-2 text-left font-medium text-gray-600">Status</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-gray-100">
                        {rows.map((r) => {
                          const [label, cls] = tag(r);
                          return (
                            <tr key={r.employeeId} className={r.existingStatus ? 'opacity-60' : ''}>
                              <td className="px-3 py-1.5">
                                {r.name} <span className="text-xs text-gray-400 font-mono">{r.employeeCode}</span>
                              </td>
                              <td className="px-3 py-1.5 text-gray-600">{r.source || '—'}</td>
                              <td className="px-3 py-1.5">
                                <span className={`inline-block px-2 py-0.5 text-xs rounded-lg ${cls}`}>{label}</span>
                                {r.existingStatus && <span className="ml-1 text-xs text-gray-400">({r.existingStatus})</span>}
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                  <div className="flex justify-end gap-2 pt-4">
                    <button onClick={() => setRunModal(null)} className="px-4 py-2 text-sm border rounded-lg hover:bg-gray-50">Cancel</button>
                    <button onClick={executeRun} disabled={runModal.running || toGen.length === 0}
                      className="px-4 py-2 text-sm bg-indigo-600 text-white rounded-lg hover:bg-indigo-700 disabled:opacity-50">
                      {runModal.running ? 'Generating…' : `Generate ${toGen.length} draft${toGen.length === 1 ? '' : 's'}`}
                    </button>
                  </div>
                </>
              ) : (
                <div className="text-gray-500 py-6 text-center">No data.</div>
              )}
            </div>
          </div>
        );
      })()}

      <MailComposeModal open={!!mail} onClose={() => setMail(null)} {...(mail || {})} />
    </div>
  );
}
