/**
 * AdminPayrollRun — "Hikes" (admin portal). Sets an employee's salary basis:
 * their salary structure and annual CTC (PUT /employees/:id), CTC increments
 * (POST /payroll/employees/:id/hike), and the revision history — alongside the
 * month's attendance roll-up (GET /attendance/month-summary,
 * GET /payroll/run-employee) for context on what a hike is being given against.
 *
 * Generating, holding and approving payslips lives on the Payroll page; this
 * screen no longer carries the day calendar or the computed-salary panel.
 */
import { useEffect, useState } from 'react';
import { toast } from 'react-toastify';
import api from '../api/client';
import PageHeader from '../components/PageHeader';

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December'];

const PAYSLIP_STYLES = {
  Draft: 'bg-gray-100 text-gray-700',
  Approved: 'bg-blue-100 text-blue-800',
  Paid: 'bg-green-100 text-green-700',
  OnHold: 'bg-amber-100 text-amber-800',
};

const inr = (n) => `₹${Number(n || 0).toLocaleString('en-IN')}`;
const fullName = (u) => `${u?.firstName || ''} ${u?.lastName || ''}`.trim();

// Hikes — pick an employee and a month, set their salary structure + annual CTC,
// and give increments. The attendance roll-up beside it (paid/LOP days, leave,
// lateness) is context for the decision, not an editing surface.
export default function AdminPayrollRun() {
  const now = new Date();
  const [employees, setEmployees] = useState([]);
  const [structures, setStructures] = useState([]);
  const [employee, setEmployee] = useState('');
  const [year, setYear] = useState(now.getFullYear());
  const [month, setMonth] = useState(now.getMonth() + 1);

  const [att, setAtt] = useState(null);   // month-summary payload
  const [run, setRun] = useState(null);   // run-employee payload
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [setup, setSetup] = useState({ salaryStructure: '', annualCtc: '' });
  const [hike, setHike] = useState(null); // hike modal form, or null when closed

  useEffect(() => {
    api.get('/employees?excludeExecutives=true').then(({ data }) => {
      const profiles = (data.profiles || []).filter((p) => p.user);
      setEmployees(profiles);
      setEmployee((e) => e || profiles[0]?._id || '');
    }).catch(() => {});
    api.get('/salary-structures').then(({ data }) => setStructures(data.structures || [])).catch(() => {});
  }, []);

  const load = async (emp = employee) => {
    if (!emp) return;
    setLoading(true); setError('');
    try {
      const [aRes, rRes] = await Promise.all([
        api.get(`/attendance/month-summary?employee=${emp}&year=${year}&month=${month}`),
        api.get(`/payroll/run-employee?employee=${emp}&year=${year}&month=${month}`),
      ]);
      setAtt(aRes.data);
      setRun(rRes.data);
      setSetup({
        salaryStructure: rRes.data.employee?.salaryStructure?._id || '',
        // Prefill the current CTC so "Give hike" always starts from the effective
        // figure — fall back to the resolved CTC (from hike history) when the raw
        // annualCtc field hasn't been set yet.
        annualCtc: rRes.data.employee?.annualCtc || rRes.data.computed?.ctc || '',
      });
    } catch (err) {
      setError(err.response?.data?.message || 'Failed to load');
      setAtt(null); setRun(null);
    } finally { setLoading(false); }
  };
  // First load once the employee list arrives; after that the OK button applies.
  useEffect(() => { if (employee && !att) load(employee); /* eslint-disable-next-line */ }, [employee]);

  // ----- salary setup + hikes -----
  const saveSetup = async () => {
    setBusy(true);
    try {
      await api.put(`/employees/${employee}`, {
        salaryStructure: setup.salaryStructure || null,
        annualCtc: Number(setup.annualCtc) || 0,
      });
      toast.success('Salary setup saved');
      await load();
    } catch (err) { toast.error(err.response?.data?.message || 'Save failed'); }
    finally { setBusy(false); }
  };

  // ----- salary hike / increment -----
  const openHike = () => setHike({
    mode: 'percent', value: '',
    effectiveYear: year, effectiveMonth: month,
    newStructure: '', reason: '', // '' = keep current structure
  });

  // Live preview of the resulting CTC from the current hike inputs.
  const hikePreviewCtc = (() => {
    if (!hike) return 0;
    const cur = Number(setup.annualCtc) || 0;
    const v = Number(hike.value) || 0;
    if (hike.mode === 'percent') return Math.round(cur * (1 + v / 100));
    if (hike.mode === 'amount') return Math.round(cur + v);
    return Math.round(v); // set
  })();

  const submitHike = async (e) => {
    e.preventDefault();
    setBusy(true);
    try {
      const { data } = await api.post(`/payroll/employees/${employee}/hike`, {
        mode: hike.mode,
        value: Number(hike.value),
        newStructure: hike.newStructure || undefined,
        effectiveYear: Number(hike.effectiveYear),
        effectiveMonth: Number(hike.effectiveMonth),
        reason: hike.reason,
      });
      setHike(null);
      toast.success(data.applied
        ? `Hike applied · new CTC ${inr(data.entry.newCtc)}`
        : `Hike scheduled from ${MONTHS[(data.entry.effectiveMonth || 1) - 1]} ${data.entry.effectiveYear}`);
      await load();
    } catch (err) {
      toast.error(err.response?.data?.message || 'Could not apply the hike');
    } finally { setBusy(false); }
  };

  const c = run?.computed;
  const slip = run?.payslip;

  return (
    <div>
      <PageHeader title="Hikes" subtitle="Set an employee's salary structure & annual CTC, give increments, and review the CTC revision history" />

      {/* Filters + OK */}
      <div className="bg-white p-3 rounded-lg shadow-sm mb-4 flex gap-2 items-center flex-wrap">
        <select value={employee} onChange={(e) => { setEmployee(e.target.value); load(e.target.value); }} className="border rounded-lg px-3 py-2 text-sm bg-white min-w-[210px]">
          {employees.map((p) => <option key={p._id} value={p._id}>{fullName(p.user)} ({p.employeeCode || '-'})</option>)}
        </select>
        <select value={year} onChange={(e) => setYear(Number(e.target.value))} className="border rounded-lg px-3 py-2 text-sm bg-white">
          {Array.from({ length: 4 }, (_, i) => now.getFullYear() + 1 - i).map((y) => <option key={y}>{y}</option>)}
        </select>
        <select value={month} onChange={(e) => setMonth(Number(e.target.value))} className="border rounded-lg px-3 py-2 text-sm bg-white">
          {MONTHS.map((m, i) => <option key={m} value={i + 1}>{m}</option>)}
        </select>
        <button onClick={() => load()} disabled={loading || !employee}
          className="px-5 py-2 text-sm bg-indigo-600 text-white rounded-lg hover:bg-indigo-700 disabled:opacity-60">
          {loading ? 'Loading…' : 'OK'}
        </button>
        {slip && (
          <span className={`ml-auto text-xs px-2.5 py-1 rounded-full font-semibold ${PAYSLIP_STYLES[slip.status]}`}>
            {MONTHS[att.month - 1]} payslip: {slip.status} · {inr(slip.netPay)}
          </span>
        )}
      </div>

      {error && <div className="mb-4 text-sm text-red-700 bg-red-50 border border-red-200 px-3 py-2 rounded-lg">{error}</div>}

      {att && (
        <>
          {c && (
            <div>
              {/* Salary setup, CTC revisions + the attendance roll-up behind them */}
              <div className="bg-white shadow rounded-xl p-5">
                <h3 className="font-semibold text-gray-800 mb-3">Salary setup · {fullName(run.employee.user)}</h3>
                <div className="flex flex-wrap gap-2 items-center mb-4">
                  <select value={setup.salaryStructure} onChange={(e) => setSetup({ ...setup, salaryStructure: e.target.value })}
                    className="border rounded-lg px-3 py-2 text-sm bg-white flex-1 min-w-[160px]">
                    <option value="">Salary structure</option>
                    {structures.map((s) => <option key={s._id} value={s._id}>{s.name}</option>)}
                  </select>
                  <input type="number" min="0" placeholder="Annual CTC (₹)" value={setup.annualCtc}
                    onChange={(e) => setSetup({ ...setup, annualCtc: e.target.value })}
                    className="border rounded-lg px-3 py-2 text-sm w-40" />
                  <button onClick={saveSetup} disabled={busy} className="px-3 py-2 text-sm border rounded-lg hover:bg-gray-50 disabled:opacity-50">Save</button>
                  <button onClick={openHike} disabled={busy} title="Revise this employee's CTC (increment)"
                    className="px-3 py-2 text-sm rounded-lg bg-emerald-600 text-white hover:bg-emerald-700 disabled:opacity-50">Give hike</button>
                </div>

                {run.employee?.ctcHistory?.length > 0 && (
                  <div className="mb-4 text-xs">
                    <div className="font-semibold text-gray-600 mb-1">CTC revisions</div>
                    <ul className="space-y-0.5">
                      {[...run.employee.ctcHistory].reverse().slice(0, 5).map((h, i) => (
                        <li key={i} className="text-gray-500 flex justify-between gap-2">
                          <span>
                            {MONTHS[(h.effectiveMonth || 1) - 1]} {h.effectiveYear}: {inr(h.previousCtc)} → <span className="text-gray-700 font-medium">{inr(h.newCtc)}</span>
                            {h.reason ? ` · ${h.reason}` : ''}
                          </span>
                          <span className="text-gray-400 shrink-0">{h.byName || ''}</span>
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
                <div className="grid grid-cols-2 sm:grid-cols-3 gap-2 text-sm">
                  <Stat label="Paid days" value={`${c.paidDays} / ${c.daysInMonth}`} />
                  <Stat label="LOP days" value={c.lopDays} warn={c.lopDays > 0} />
                  {c.notEmployedDays > 0 && (
                    <Stat label="On payroll" value={`${c.eligibleDays} / ${c.daysInMonth} days`} warn />
                  )}
                  <Stat label="Present" value={c.counts.present} />
                  <Stat label="Half days" value={c.counts.halfDay} />
                  <Stat label={`Leave (of ${c.policy?.paidLeaveQuota ?? 2})`} value={c.counts.onLeave} warn={c.policy?.excessLeave > 0} />
                  <Stat label="Absent" value={c.counts.absent} warn={c.counts.absent > 0} />
                  <Stat label="No-punch (LOP)" value={c.counts.noPunchAbsent ?? 0} warn={(c.counts.noPunchAbsent ?? 0) > 0} />
                </div>
                {c.policy && (
                  <>
                    <h4 className="font-semibold text-gray-700 mt-4 mb-2 text-sm">Attendance policy · {MONTHS[att.month - 1]}</h4>
                    <div className="grid grid-cols-2 sm:grid-cols-3 gap-2 text-sm">
                      <Stat label={`Late arrivals (of ${c.policy.lateAllowance})`} value={c.policy.lateDays} warn={c.policy.excessLate > 0} />
                      <Stat label="Excess late" value={c.policy.excessLate} warn={c.policy.excessLate > 0} />
                      <Stat label="Excess leave" value={c.policy.excessLeave} warn={c.policy.excessLeave > 0} />
                      <Stat label="No-punch days" value={c.policy.noPunchDays ?? 0} warn={(c.policy.noPunchDays ?? 0) > 0} />
                    </div>
                    <p className="text-[11px] text-gray-400 mt-2">
                      {c.policy.paidLeaveQuota} paid leaves/month - unused convert to pay ({inr(c.policy.leaveIncentive)}), extras become LOP.
                      {' '}First {c.policy.lateAllowance} lates free; each extra costs {inr(c.policy.lateRate)}/day (monthly Basic {c.policy.monthlyBasic < 25000 ? '<' : '≥'} ₹25,000).
                      {' '}Working days with no punch-in/out are LOP ({c.policy.noPunchDays ?? 0} this month) unless regularised.
                      {' '}Basic and every other earning are always paid in full — LOP and late coming come off as deductions.
                      {' '}Salary is spread over all {c.daysInMonth} days of the month (Sundays &amp; holidays are paid)
                      {c.ctc > 0 ? `, so one day costs ${inr(Math.round(c.ctc / 12 / (c.daysInMonth || 1)))}` : ''}.
                      {c.notEmployedDays > 0 && ` This employee was on the payroll for ${c.eligibleDays} of those days (joined/exited mid-month), so pay is ${c.paidDays}/${c.daysInMonth}`
                        + ` and the monthly allowances are prorated to ${c.policy.paidLeaveQuota} paid leave (of ${c.policy.fullPaidLeaveQuota}) and ${c.policy.lateAllowance} free lates (of ${c.policy.fullLateAllowance}).`}
                    </p>
                  </>
                )}
                {c.hours && (
                  <>
                    <h4 className="font-semibold text-gray-700 mt-4 mb-2 text-sm">Working hours · {MONTHS[att.month - 1]}</h4>
                    <div className="grid grid-cols-2 sm:grid-cols-3 gap-2 text-sm">
                      <Stat label="Days present" value={`${c.hours.daysPresent} days`} />
                      <Stat label="Avg working hours" value={`${c.hours.avgHours} hrs`} />
                      <Stat label="Comp-off earned" value={c.hours.compOff} warn={c.hours.compOff > 0} />
                    </div>
                    <p className="text-[11px] text-gray-400 mt-2">
                      Average is over days actually worked. Sundays &amp; holidays are excluded unless worked · those count as comp-offs.
                    </p>
                  </>
                )}
              </div>

            </div>
          )}
        </>
      )}

      {/* Hike / increment modal */}
      {hike && (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center px-4 z-50 overflow-y-auto py-8">
          <div className="bg-white rounded-xl shadow-lg w-full max-w-lg p-6">
            <h2 className="font-semibold text-gray-900 mb-1">Give hike · {fullName(run?.employee?.user)}</h2>
            <p className="text-xs text-gray-500 mb-4">Current CTC: {inr(setup.annualCtc)}/yr</p>
            <form onSubmit={submitHike} className="space-y-3">
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs text-gray-600 mb-1">Hike type</label>
                  <select value={hike.mode} onChange={(e) => setHike({ ...hike, mode: e.target.value })}
                    className="block w-full border rounded-lg px-3 py-2 text-sm bg-white">
                    <option value="percent">Percentage (%)</option>
                    <option value="amount">Increase by ₹</option>
                    <option value="set">Set new CTC to ₹</option>
                  </select>
                </div>
                <div>
                  <label className="block text-xs text-gray-600 mb-1">
                    {hike.mode === 'percent' ? 'Percent (%)' : hike.mode === 'amount' ? 'Increase (₹/yr)' : 'New CTC (₹/yr)'}
                  </label>
                  <input type="number" min="0" required value={hike.value}
                    onChange={(e) => setHike({ ...hike, value: e.target.value })}
                    className="block w-full border rounded-lg px-3 py-2 text-sm" />
                </div>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs text-gray-600 mb-1">Effective month</label>
                  <select value={hike.effectiveMonth} onChange={(e) => setHike({ ...hike, effectiveMonth: Number(e.target.value) })}
                    className="block w-full border rounded-lg px-3 py-2 text-sm bg-white">
                    {MONTHS.map((m, i) => <option key={m} value={i + 1}>{m}</option>)}
                  </select>
                </div>
                <div>
                  <label className="block text-xs text-gray-600 mb-1">Effective year</label>
                  <input type="number" value={hike.effectiveYear}
                    onChange={(e) => setHike({ ...hike, effectiveYear: Number(e.target.value) })}
                    className="block w-full border rounded-lg px-3 py-2 text-sm" />
                </div>
              </div>

              <div>
                <label className="block text-xs text-gray-600 mb-1">Switch salary structure (optional)</label>
                <select value={hike.newStructure} onChange={(e) => setHike({ ...hike, newStructure: e.target.value })}
                  className="block w-full border rounded-lg px-3 py-2 text-sm bg-white">
                  <option value="">Keep current structure</option>
                  {structures.map((s) => <option key={s._id} value={s._id}>{s.name}</option>)}
                </select>
              </div>

              <div>
                <label className="block text-xs text-gray-600 mb-1">Reason</label>
                <input value={hike.reason} onChange={(e) => setHike({ ...hike, reason: e.target.value })}
                  placeholder="e.g. Annual appraisal 2026, promotion" className="block w-full border rounded-lg px-3 py-2 text-sm" />
              </div>

              <div className="bg-emerald-50 border border-emerald-200 rounded-lg px-3 py-2 text-sm text-emerald-900 flex justify-between">
                <span>New CTC</span>
                <span className="font-semibold">
                  {inr(setup.annualCtc)} → {inr(hikePreviewCtc)}
                  {Number(setup.annualCtc) > 0 && hikePreviewCtc > Number(setup.annualCtc) && (
                    <span className="text-emerald-600 ml-1">(+{Math.round((hikePreviewCtc / Number(setup.annualCtc) - 1) * 100)}%)</span>
                  )}
                </span>
              </div>

              <div className="flex justify-end gap-2 pt-1">
                <button type="button" onClick={() => setHike(null)} className="px-4 py-2 text-sm border rounded-lg hover:bg-gray-50">Cancel</button>
                <button type="submit" disabled={busy} className="px-4 py-2 text-sm bg-emerald-600 text-white rounded-lg hover:bg-emerald-700 disabled:opacity-60">
                  {busy ? 'Applying…' : 'Apply hike'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}

// Small labelled stat tile (red value when `warn`) used across the run panels.
function Stat({ label, value, warn }) {
  return (
    <div className="bg-gray-50 rounded-lg px-3 py-2">
      <div className="text-[11px] text-gray-500">{label}</div>
      <div className={`font-semibold ${warn ? 'text-red-600' : 'text-gray-900'}`}>{value}</div>
    </div>
  );
}
