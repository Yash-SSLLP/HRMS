import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { FiAlertTriangle } from 'react-icons/fi';
import api from '../api/client';
import { useAuthStore } from '../store/authStore';
import { hasPermission } from '../config/permissions';

// Standing alert for HR: active employees who have no salary structure and/or no
// annual CTC. Payroll cannot compute anything for them — they come out of a run
// with a ₹0 payslip, and even the late-arrival penalty is ₹0 because its
// ₹200/₹400 rate keys off monthly Basic. Better to catch it before the run than
// to explain a blank payslip afterwards.
//
// Renders nothing when everyone is set up, so it is invisible in the normal case.
// Each row deep-links into Salary Structures with `?assign=<profileId>`, which
// opens the assign modal already pointed at that employee — see the param
// handling in pages/AdminSalaryStructures.jsx.
const MAX_LISTED = 6;
const fixLink = (id) => `/admin/salary-structures?assign=${id}`;

const missingLabel = (missing) => {
  if (missing.includes('structure') && missing.includes('ctc')) return 'No salary structure or CTC';
  if (missing.includes('structure')) return 'No salary structure';
  return 'No annual CTC';
};

export default function SalarySetupAlert() {
  const user = useAuthStore((s) => s.user);
  const canSeePayroll = hasPermission(user, 'payroll.manage');
  const [employees, setEmployees] = useState([]);

  useEffect(() => {
    if (!canSeePayroll) return;
    api.get('/payroll/salary-setup-status')
      .then(({ data }) => setEmployees(data.employees || []))
      .catch(() => {}); // a failed check must never break the page it sits on
  }, [canSeePayroll]);

  if (!canSeePayroll || employees.length === 0) return null;

  const listed = employees.slice(0, MAX_LISTED);
  const rest = employees.length - listed.length;

  return (
    <div className="mb-4 bg-amber-50 border border-amber-200 rounded-xl p-4 shadow-sm">
      <div className="flex items-center gap-2 flex-wrap mb-2.5">
        <FiAlertTriangle className="text-amber-600 shrink-0" size={18} />
        <span className="font-semibold text-amber-900">
          {employees.length} employee{employees.length === 1 ? '' : 's'} {employees.length === 1 ? 'has' : 'have'} no salary set up
        </span>
        <span className="text-[10px] font-semibold uppercase tracking-wide bg-amber-600 text-white rounded-full px-2 py-0.5">
          Payroll will be ₹0
        </span>
      </div>
      <p className="text-xs text-amber-800 mb-2.5">
        Payroll can&apos;t be calculated without a salary structure <em>and</em> an annual CTC.
        Pick a name below to assign both, then re-run the month.
      </p>
      <div className="space-y-1.5">
        {listed.map((e) => (
          <Link key={e.id} to={fixLink(e.id)}
            className="flex items-baseline justify-between gap-3 bg-white/70 hover:bg-white rounded-lg px-3 py-2 border border-amber-100">
            <span className="min-w-0">
              <span className="text-sm font-medium text-gray-900">{e.name}</span>
              <span className="text-xs text-gray-500">
                {e.employeeCode ? ` · ${e.employeeCode}` : ''}
                {e.designation ? ` · ${e.designation}` : ''}
                {e.department ? ` · ${e.department}` : ''}
              </span>
            </span>
            <span className="text-xs text-amber-800 font-medium shrink-0">{missingLabel(e.missing)}</span>
          </Link>
        ))}
      </div>
      <div className="flex items-center justify-between mt-2">
        <span className="text-xs text-amber-700">{rest > 0 ? `+ ${rest} more` : ''}</span>
        <Link to="/admin/salary-structures" className="text-xs text-amber-800 font-medium hover:underline">
          Open Salary Structures →
        </Link>
      </div>
    </div>
  );
}
