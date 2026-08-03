import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { FiAlertTriangle, FiChevronRight } from 'react-icons/fi';
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
    <div className="salert mb-4">
      <div className="flex items-center gap-2.5 flex-wrap mb-2">
        <span className="salert-icon shrink-0"><FiAlertTriangle size={16} /></span>
        <span className="salert-title font-semibold tracking-tight">
          {employees.length} employee{employees.length === 1 ? '' : 's'} {employees.length === 1 ? 'has' : 'have'} no salary set up
        </span>
        <span className="salert-chip text-[10px] font-bold uppercase tracking-wide rounded-full px-2 py-0.5">
          Payroll will be ₹0
        </span>
      </div>
      <p className="salert-body text-xs mb-3 max-w-3xl">
        Payroll can&apos;t be calculated without a salary structure <em>and</em> an annual CTC.
        Pick a name below to assign both, then re-run the month.
      </p>
      <div className="space-y-1.5">
        {listed.map((e) => (
          <Link key={e.id} to={fixLink(e.id)}
            className="salert-row flex items-center justify-between gap-3 px-3 py-2">
            <span className="min-w-0 truncate">
              <span className="salert-name text-sm font-medium">{e.name}</span>
              <span className="salert-meta text-xs">
                {e.employeeCode ? ` · ${e.employeeCode}` : ''}
                {e.designation ? ` · ${e.designation}` : ''}
                {e.department ? ` · ${e.department}` : ''}
              </span>
            </span>
            <span className="flex items-center gap-1.5 shrink-0">
              <span className="salert-tag text-[11px] font-semibold">{missingLabel(e.missing)}</span>
              <FiChevronRight className="salert-chevron" size={14} />
            </span>
          </Link>
        ))}
      </div>
      <div className="flex items-center justify-between gap-3 mt-2.5">
        <span className="salert-body text-xs">{rest > 0 ? `+ ${rest} more` : ''}</span>
        <Link to="/admin/salary-structures" className="salert-title text-xs font-semibold hover:underline">
          Open Salary Structures →
        </Link>
      </div>
    </div>
  );
}
