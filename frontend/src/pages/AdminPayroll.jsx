/**
 * AdminPayroll — manual payslip management (admin portal). Lists/filters payslips
 * from GET /payroll (employees from GET /employees), creates/edits drafts via
 * POST/PUT /payroll, transitions status (approve/pay/delete) via
 * PATCH /payroll/:id/:action, exports the payroll register (.xlsx), downloads the salary-slip PDF, and emails the
 * payslip from the company mailbox (POST /payroll/:id/email). Bulk runs live on AdminPayrollRun.
 */
import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { toast } from 'react-toastify';
import api from '../api/client';
import { downloadFile } from '../api/download';
import PageHeader from '../components/PageHeader';
import MailComposeModal from '../components/MailComposeModal';
import { confirmDialog } from '../components/dialogs';
import SalarySetupAlert from '../components/SalarySetupAlert';
import SearchableSelect from '../components/SearchableSelect';

const MONTHS = [
  'January','February','March','April','May','June',
  'July','August','September','October','November','December',
];

// Free late arrivals per month before the penalty starts. Mirrors LATE_ALLOWANCE
// in backend/controllers/payrollController.js — display only (the amount itself
// is always computed server-side), but keep the two in step.
const LATE_ALLOWANCE = 5;

/** Strip undefined keys so a spread can't blank a value the engine didn't produce. */
const dropUndefined = (obj) =>
  Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined));

const STATUS_COLORS = {
  Draft: 'bg-gray-100 text-gray-700',
  Approved: 'bg-blue-100 text-blue-800',
  Paid: 'bg-green-100 text-green-800',
  OnHold: 'bg-amber-100 text-amber-800',
};

// Custody of the document, separate from `status`, which is about the money.
// Amber is the queue: something is waiting on HR. See models/Payroll.js.
const RELEASE = {
  NotRequested: { label: 'Not requested', tone: 'bg-gray-100 text-gray-600' },
  Requested: { label: 'Requested', tone: 'bg-amber-100 text-amber-800' },
  Approved: { label: 'Approved — to finalise', tone: 'bg-blue-100 text-blue-800' },
  Finalised: { label: 'Released', tone: 'bg-green-100 text-green-800' },
  ChangeRequested: { label: 'Change requested', tone: 'bg-amber-100 text-amber-800' },
};
const releaseOf = (p) => (RELEASE[p.release?.status] ? p.release.status : 'NotRequested');

// Every payslip field the editor round-trips. The save is an Object.assign on
// the server, so a field missing here is silently zeroed on a manual edit —
// keep this in step with models/Payroll.js.
const blankSlip = () => ({
  employee: '',
  payPeriodYear: new Date().getFullYear(),
  payPeriodMonth: new Date().getMonth() + 1,
  workingDays: 30,
  paidDays: 30,
  lopDays: 0,
  halfDays: 0,
  lateDays: 0,
  additionalPaidDays: 0,
  monthlySalary: 0,
  annualCtc: 0,
  earnings: { basic: 0, hra: 0, specialAllowance: 0, conveyanceAllowance: 0, medicalAllowance: 0, lta: 0, bonus: 0, overtime: 0, leaveIncentive: 0, doubleDayPay: 0, otherEarnings: 0 },
  deductions: { epf: 0, esic: 0, professionalTax: 0, tds: 0, loanRecovery: 0, salaryAdvance: 0, lopDeduction: 0, latePenalty: 0, emergencyPenalty: 0, otherDeductions: 0 },
});

// Friendlier than the camelCase-to-spaced fallback for the money fields HR reads.
const FIELD_LABELS = {
  conveyanceAllowance: 'Conveyance (TA)',
  lta: 'LTA',
  leaveIncentive: 'Leave incentive',
  doubleDayPay: 'Sunday / comp-off duty (2×)',
  otherEarnings: 'Other Pay',
  epf: 'PF / EPF',
  esic: 'ESIC',
  tds: 'TDS',
  loanRecovery: 'Loan EMI',
  salaryAdvance: 'Salary Advance EMI',
  lopDeduction: 'LOP / unpaid days',
  latePenalty: 'Late coming',
  emergencyPenalty: 'Emergency leave (2×)',
};
const labelOf = (k) => FIELD_LABELS[k] || k.replace(/([A-Z])/g, ' $1').replace(/^./, (c) => c.toUpperCase());

const inr = (n) =>
  new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', maximumFractionDigits: 0 }).format(n || 0);

export default function AdminPayroll() {
  const [payslips, setPayslips] = useState([]);
  const [employees, setEmployees] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [filter, setFilter] = useState({ year: new Date().getFullYear(), month: '', status: '' });

  const [showModal, setShowModal] = useState(false);
  const [params] = useSearchParams();
  const navigate = useNavigate();
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
    // Changing the period invalidates the re-generate ticks (they are employee
    // ids for that month's existing payslips).
    setRunModal((rm) => ({ ...rm, year, month, loadingPreview: true, result: null, regen: [] }));
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
    setRunModal({ year, month, preview: null, loadingPreview: true, running: false, result: null, regen: [] });
    loadRunPreview(year, month);
  };

  // Tick / untick an already-generated payslip for re-generation.
  const toggleRegen = (id) => setRunModal((rm) => ({
    ...rm,
    regen: rm.regen.includes(id) ? rm.regen.filter((x) => x !== id) : [...rm.regen, id],
  }));

  const toggleAllRegen = (ids) => setRunModal((rm) => ({
    ...rm,
    regen: ids.every((id) => rm.regen.includes(id)) ? [] : ids,
  }));

  const executeRun = async () => {
    const regen = runModal.regen || [];
    // Overwriting an Approved payslip sends it back to Draft, which hides it from
    // the employee and breaks the shared link until it is approved again.
    const approved = (runModal.preview?.rows || [])
      .filter((r) => regen.includes(r.employeeId) && r.existingStatus === 'Approved');
    if (approved.length && !(await confirmDialog({
      message: `${approved.length} approved payslip${approved.length === 1 ? '' : 's'} will be recomputed and reset to Draft. `
        + 'Their shared payslip links stop working until they are approved again. Continue?',
      tone: 'danger',
      confirmText: 'Re-generate',
    }))) return;
    setRunModal((rm) => ({ ...rm, running: true }));
    try {
      const { data } = await api.post('/payroll/run', { year: runModal.year, month: runModal.month, regenerate: regen });
      toast.success(
        `Created ${data.created} draft payslip${data.created === 1 ? '' : 's'} · ${data.derived} from structure, ${data.copiedFromLast} copied`
        + (data.regenerated ? ` · re-generated ${data.regenerated}` : '')
      );
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
      halfDays: p.halfDays || 0,
      lateDays: p.lateDays || 0,
      additionalPaidDays: p.additionalPaidDays || 0,
      monthlySalary: p.monthlySalary || 0,
      annualCtc: p.annualCtc || 0,
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
    }, { amounts: false }).then((days) => fetchSalaryInfo({
      over: {
        employee,
        payPeriodYear: p.payPeriodYear,
        payPeriodMonth: p.payPeriodMonth,
        paidDays: days?.paidDays ?? p.paidDays,
        workingDays: days?.workingDays ?? p.workingDays,
      },
    }));
  };

  // Deep link from the Payslip Requests queue: /admin/payroll?edit=<id> opens
  // that payslip in this editor, so HR corrects it in the one place the full
  // editor lives rather than a second copy of it. The slip is fetched by id
  // instead of being looked up in `payslips`, which the page's filters may hide.
  const editParam = params.get('edit');
  useEffect(() => {
    if (!editParam) return;
    let cancelled = false;
    (async () => {
      try {
        const { data } = await api.get(`/payroll/${editParam}`);
        if (!cancelled && data.payslip) openEdit(data.payslip);
      } catch (err) {
        toast.error(err.response?.data?.message || 'Could not open that payslip');
      }
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editParam]);

  // Load (and optionally apply) the earnings + statutory deductions derived from
  // the employee's assigned salary structure × CTC. Earnings come back at their
  // full monthly value; the unpaid days arrive as the `lopDeduction`.
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
  //
  // The money the same policy produces is written here too. Counting 8 late days
  // into the header and leaving the late-coming deduction at ₹0 was the bug: the
  // amounts are attendance-derived, not structure-derived, so `derive-salary`
  // (the "Fill from structure" button) never had them and nothing else filled
  // them in. They stay editable, exactly like the day counts above them.
  // `amounts: false` refreshes only the day counts — used when reopening a SAVED
  // payslip, whose earnings/deductions may have been corrected by hand and must
  // not be silently recomputed underneath HR.
  const syncAttendanceDays = async (over = {}, { amounts = true } = {}) => {
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
        halfDays: c.counts?.halfDay ?? f.halfDays,
        lateDays: c.policy?.lateDays ?? f.lateDays,
        additionalPaidDays: c.policy?.unusedLeave ?? f.additionalPaidDays,
        // Salary-slip header figures, frozen onto the payslip when it is saved.
        monthlySalary: c.ctc ? Math.round(c.ctc / 12) : f.monthlySalary,
        annualCtc: c.ctc ?? f.annualCtc,
      };
      // Only overwrite a figure the engine actually produced — before a salary
      // structure exists the pay-derived ones come back 0/undefined, and blanking
      // a value HR typed would be worse than leaving it alone. The late penalty
      // is flat-rate, so it is real even without a structure.
      const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);
      const money = {
        deductions: dropUndefined({
          latePenalty: num(c.latePenalty),
          lopDeduction: num(c.lopDeduction),
          emergencyPenalty: num(c.emergencyPenalty),
        }),
        earnings: dropUndefined({
          leaveIncentive: num(c.earnings?.leaveIncentive),
          doubleDayPay: num(c.doubleDayPay),
        }),
      };
      setForm((prev) => (amounts
        ? {
          ...prev,
          ...days,
          deductions: { ...prev.deductions, ...money.deductions },
          earnings: { ...prev.earnings, ...money.earnings },
        }
        : { ...prev, ...days }));
      return { ...days, ...money };
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
      // Arrived from the release queue to correct a slip before approving it —
      // send HR back there rather than stranding them on this page.
      if (params.get('from') === 'requests') {
        navigate('/admin/payslip-requests');
        return;
      }
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
      {/* Warn before the run, not after: employees with no structure/CTC
          silently produce ₹0 payslips. */}
      <SalarySetupAlert />

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
              <th className="px-4 py-3 text-right font-medium text-gray-700"
                title="Late-arrival penalty: the first 5 late days each month are free; each day beyond that costs ₹200 (monthly Basic under ₹25,000) or ₹400 (₹25,000 and above).">
                Late deduction
              </th>
              <th className="px-4 py-3 text-right font-medium text-gray-700">Deductions</th>
              <th className="px-4 py-3 text-right font-medium text-gray-700">Net</th>
              <th className="px-4 py-3 text-left font-medium text-gray-700">Status</th>
              <th className="px-4 py-3 text-left font-medium text-gray-700">Release</th>
              <th className="px-4 py-3 text-right font-medium text-gray-700">Actions</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100">
            {loading ? (
              <tr><td colSpan={9} className="px-4 py-4"><div className="space-y-2.5"><div className="skeleton h-4 rounded" /><div className="skeleton h-4 rounded w-5/6" /><div className="skeleton h-4 rounded w-2/3" /></div></td></tr>
            ) : payslips.length === 0 ? (
              <tr><td colSpan={9} className="px-4 py-6 text-center text-gray-500">No payslips</td></tr>
            ) : payslips.map((p) => (
              <tr key={p._id}>
                <td className="px-4 py-3">
                  {p.employee?.user?.firstName} {p.employee?.user?.lastName}
                  <div className="text-xs text-gray-500 font-mono">{p.employee?.employeeCode}</div>
                </td>
                <td className="px-4 py-3">{MONTHS[p.payPeriodMonth - 1]} {p.payPeriodYear}</td>
                <td className="px-4 py-3 text-right">{inr(p.grossSalary)}</td>
                {/* Broken out of the Deductions total because it is the one
                    line HR is most often asked to justify. */}
                <td className="px-4 py-3 text-right">
                  {p.deductions?.latePenalty > 0 ? (
                    <>
                      <div className="text-red-600 font-medium">− {inr(p.deductions.latePenalty)}</div>
                      <div className="text-[11px] text-gray-400">
                        {p.lateDays || 0} late · {Math.max(0, (p.lateDays || 0) - LATE_ALLOWANCE)} over
                      </div>
                    </>
                  ) : (
                    <span className="text-gray-400">
                      {p.lateDays > 0 ? `${p.lateDays} late · within limit` : '—'}
                    </span>
                  )}
                </td>
                <td className="px-4 py-3 text-right">{inr(p.totalDeductions)}</td>
                <td className="px-4 py-3 text-right font-semibold">{inr(p.netPay)}</td>
                <td className="px-4 py-3">
                  <span className={`inline-block px-2 py-0.5 text-xs rounded-lg ${STATUS_COLORS[p.status]}`}>{p.status}</span>
                </td>
                <td className="px-4 py-3">
                  <span className={`inline-block px-2 py-0.5 text-xs rounded-lg ${RELEASE[releaseOf(p)].tone}`}>
                    {RELEASE[releaseOf(p)].label}
                  </span>
                  {['Requested', 'Approved', 'ChangeRequested'].includes(releaseOf(p)) && (
                    <Link to="/admin/payslip-requests" className="block text-[11px] text-blue-600 hover:underline mt-1">
                      Handle in Payslip Requests
                    </Link>
                  )}
                </td>
                <td className="px-4 py-3 text-right space-x-2 whitespace-nowrap">
                  {/* Release is handled on the Payslip Requests page — this page
                      is about the money, and one home for the workflow beats two.
                      The state is still shown here because it is useful context
                      when reviewing figures. */}
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
                        className="text-blue-600 hover:underline">
                        {releaseOf(p) === 'Finalised' ? 'PDF' : 'Preview'}
                      </button>
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
              {/* Not always a draft: the release queue opens approved payslips
                  here too, so HR can correct one before handing it over. */}
              {editingId ? 'Edit Payslip' : 'New Payslip'}
            </h2>
            <form onSubmit={onSave} className="space-y-3">
              <div className="grid grid-cols-3 gap-3">
                <div className="col-span-1">
                  <label className="block text-sm text-gray-700">Employee *</label>
                  <SearchableSelect
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
                  </SearchableSelect>
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
                {/* Printed on the salary slip's day block — no effect on the amounts. */}
                {[['halfDays', 'Half Days'], ['lateDays', 'Late Days'], ['additionalPaidDays', 'Additional Paid Days']].map(([k, label]) => (
                  <div key={k}>
                    <label className="block text-sm text-gray-700">{label}</label>
                    <input type="number" value={form[k]}
                      onChange={(e) => setForm({ ...form, [k]: Number(e.target.value) })}
                      className="mt-1 block w-full border rounded-lg px-3 py-2" />
                  </div>
                ))}
              </div>
              <p className="text-[11px] text-gray-400 -mt-1">
                Auto-filled from attendance (after LOP &amp; leave-quota normalization) · editable.
                Half/Late/Additional days are printed on the slip only — the LOP amount is the
                <span className="font-medium"> LOP / unpaid days</span> deduction below.
              </p>

              {/* Salary structure → derive earnings + statutory deductions */}
              <div className="pt-3 border-t">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="text-sm">
                    <span className="font-semibold text-gray-700">Salary structure: </span>
                    {salaryInfo == null ? (
                      <span className="text-gray-400">select an employee…</span>
                    ) : salaryInfo.needsSetup ? (
                      <span className="text-amber-700">not assigned — set structure &amp; CTC on the Hikes page</span>
                    ) : (
                      <span className="text-gray-700">{salaryInfo.structure?.name} · CTC {inr(salaryInfo.annualCtc)}/yr</span>
                    )}
                  </div>
                  {/* Structure first, then attendance: the structure supplies the
                      component earnings and the statutory cuts, and the sync adds
                      the attendance-derived money (late coming, LOP, emergency
                      leave, leave incentive, 2× duty) on top. This is also the
                      one action that re-derives a SAVED slip, which openEdit
                      deliberately leaves alone. */}
                  <button type="button" disabled={!form.employee || !salaryInfo || salaryInfo.needsSetup}
                    onClick={async () => { await fetchSalaryInfo({ apply: true }); await syncAttendanceDays(); }}
                    className="text-xs px-3 py-1.5 rounded-lg bg-indigo-600 text-white hover:bg-indigo-700 disabled:opacity-50">
                    Fill earnings &amp; deductions from structure
                  </button>
                </div>
                {salaryInfo && !salaryInfo.needsSetup && (
                  <p className="text-[11px] text-gray-400 mt-1">
                    Earnings are the full monthly value (Basic is never prorated); the {form.workingDays - form.paidDays} unpaid
                    day(s) out of {form.workingDays} are recovered as the LOP deduction ·
                    PF/EPF &amp; ESI not deducted (₹0), PT ₹200 — all editable below.
                  </p>
                )}
              </div>

              <h3 className="text-sm font-semibold text-gray-700 pt-3 border-t">Earnings (₹)</h3>
              <div className="grid grid-cols-3 gap-3">
                {Object.keys(form.earnings).map((k) => (
                  <div key={k}>
                    <label className="block text-xs text-gray-600">{labelOf(k)}</label>
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
                    <label className="block text-xs text-gray-600">{labelOf(k)}</label>
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
        // Already-generated payslips HR may tick to recompute (Paid never, and
        // hand-entered/copied payslips have no structure to re-derive from).
        const regen = runModal.regen || [];
        const regenIds = rows.filter((r) => r.canRegenerate).map((r) => r.employeeId);
        const isRegen = (r) => regen.includes(r.employeeId);
        const tag = (r) => isRegen(r)
          ? ['will re-generate', 'bg-indigo-100 text-indigo-700']
          : r.existingLocked
            ? ['locked (Paid)', 'bg-gray-100 text-gray-500']
            : r.existingStatus
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
                Creates a Draft payslip for every active employee for the selected month. Payslips that already exist
                are skipped unless you tick them to re-generate — those are recomputed from the salary structure and
                the current attendance. Paid payslips can never be overwritten.
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
                    {runModal.result.regenerated ? ` · re-generated ${runModal.result.regenerated}` : ''}
                    {runModal.result.skippedExisting ? ` · skipped ${runModal.result.skippedExisting} existing` : ''}.
                    {runModal.result.regeneratedFromApproved
                      ? ` ${runModal.result.regeneratedFromApproved} approved payslip(s) are back to Draft — approve them again.`
                      : ''}
                  </div>
                  {runModal.result.regeneratedEmailed?.length > 0 && (
                    <div className="text-xs bg-amber-50 border border-amber-200 text-amber-800 px-3 py-2 rounded-lg">
                      Already emailed before this re-run — the sent PDF is now out of date, resend after reviewing:{' '}
                      {runModal.result.regeneratedEmailed.join(', ')}
                    </div>
                  )}
                  {(runModal.result.regenerateBlocked?.paid?.length > 0
                    || runModal.result.regenerateBlocked?.noSetup?.length > 0) && (
                    <div className="text-xs bg-gray-50 border border-gray-200 text-gray-600 px-3 py-2 rounded-lg space-y-1">
                      {runModal.result.regenerateBlocked.paid?.length > 0 && (
                        <div>Not re-generated (already Paid): {runModal.result.regenerateBlocked.paid.join(', ')}</div>
                      )}
                      {runModal.result.regenerateBlocked.noSetup?.length > 0 && (
                        <div>Not re-generated (no salary structure to recompute from): {runModal.result.regenerateBlocked.noSetup.join(', ')}</div>
                      )}
                    </div>
                  )}
                  <div className="grid grid-cols-3 gap-2 text-sm">
                    <div className="bg-emerald-50 rounded-lg p-2 text-emerald-800">From structure: <strong>{runModal.result.derived}</strong></div>
                    <div className="bg-blue-50 rounded-lg p-2 text-blue-800">Copied from last: <strong>{runModal.result.copiedFromLast}</strong></div>
                    <div className="bg-amber-50 rounded-lg p-2 text-amber-800">Needs setup (blank): <strong>{runModal.result.needsSetup?.length || 0}</strong></div>
                  </div>
                  {runModal.result.needsSetup?.length > 0 && (
                    <div className="text-xs text-amber-700">
                      Assign a salary structure &amp; CTC (Hikes page) for: {runModal.result.needsSetup.join(', ')}
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
                  <div className="grid grid-cols-2 sm:grid-cols-5 gap-2 text-sm mb-3">
                    <div className="bg-gray-50 rounded-lg p-2">To generate: <strong>{toGen.length}</strong></div>
                    <div className="bg-emerald-50 rounded-lg p-2 text-emerald-800">From structure: <strong>{willDerive.length}</strong></div>
                    <div className="bg-blue-50 rounded-lg p-2 text-blue-800">Copy from last: <strong>{willCopy.length}</strong></div>
                    <div className="bg-amber-50 rounded-lg p-2 text-amber-800">Needs setup: <strong>{willBlank.length}</strong></div>
                    <div className="bg-indigo-50 rounded-lg p-2 text-indigo-800">Re-generate: <strong>{regen.length}</strong></div>
                  </div>
                  <div className="border rounded-lg overflow-hidden max-h-72 overflow-y-auto">
                    <table className="min-w-full text-sm divide-y divide-gray-100">
                      <thead className="bg-gray-50 sticky top-0">
                        <tr>
                          <th className="px-3 py-2 text-left font-medium text-gray-600" title="Re-generate the existing payslip">
                            <input type="checkbox" disabled={regenIds.length === 0}
                              checked={regenIds.length > 0 && regenIds.every((id) => regen.includes(id))}
                              onChange={() => toggleAllRegen(regenIds)}
                              className="align-middle disabled:opacity-40" />
                            <span className="ml-1 text-xs font-normal">redo</span>
                          </th>
                          <th className="px-3 py-2 text-left font-medium text-gray-600">Employee</th>
                          <th className="px-3 py-2 text-left font-medium text-gray-600">Source</th>
                          <th className="px-3 py-2 text-left font-medium text-gray-600">Status</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-gray-100">
                        {rows.map((r) => {
                          const [label, cls] = tag(r);
                          return (
                            <tr key={r.employeeId} className={r.existingStatus && !isRegen(r) ? 'opacity-60' : ''}>
                              <td className="px-3 py-1.5">
                                {r.existingStatus ? (
                                  <input type="checkbox" checked={isRegen(r)} disabled={!r.canRegenerate}
                                    onChange={() => toggleRegen(r.employeeId)}
                                    title={r.canRegenerate
                                      ? 'Recompute this payslip from the salary structure & attendance'
                                      : r.existingLocked
                                        ? 'Paid payslips cannot be overwritten'
                                        : 'No salary structure to recompute from — edit this payslip from the list instead'}
                                    className="align-middle disabled:opacity-40" />
                                ) : <span className="text-xs text-gray-300">—</span>}
                              </td>
                              <td className="px-3 py-1.5">
                                {r.name} <span className="text-xs text-gray-400 font-mono">{r.employeeCode}</span>
                              </td>
                              <td className="px-3 py-1.5 text-gray-600">
                                {r.source || '—'}
                                {r.existingNetPay != null && (
                                  <span className="ml-1 text-xs text-gray-400">current {inr(r.existingNetPay)}</span>
                                )}
                              </td>
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
                    <button onClick={executeRun} disabled={runModal.running || toGen.length + regen.length === 0}
                      className="px-4 py-2 text-sm bg-indigo-600 text-white rounded-lg hover:bg-indigo-700 disabled:opacity-50">
                      {runModal.running ? 'Generating…' : [
                        toGen.length ? `Generate ${toGen.length} draft${toGen.length === 1 ? '' : 's'}` : '',
                        regen.length ? `Re-generate ${regen.length}` : '',
                      ].filter(Boolean).join(' · ') || 'Generate'}
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
