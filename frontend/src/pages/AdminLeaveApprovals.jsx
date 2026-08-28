/**
 * AdminApprovals — the approver inbox for the admin portal (CEO / MD and any
 * admin who sits in someone's reporting chain). Mirrors the employee-portal
 * Approvals page: it hosts the leave, resignation and no-dues-clearance inboxes,
 * all of which fetch from the protect-only /approvals/* routes — so the
 * read-only CEO/MD executives CAN act here even though they can't write on the
 * admin-gated routes. Requests reach these queues by climbing the reporting
 * hierarchy (EmployeeProfile.reportingManager, the same field the Org Chart
 * uses), stopping at the first CEO/MD.
 */
import PageHeader from '../components/PageHeader';
import ApprovalsBoard from '../components/ApprovalsBoard';
import { useAuthStore } from '../store/authStore';

export default function AdminApprovals() {
  // The Backend's inbox is every open request, not only the rungs addressed to
  // it (see approvalController's seesAllApprovals), so the old "waiting on you"
  // line would have been wrong for exactly the account that sees the most.
  const me = useAuthStore((s) => s.user);
  const seesAll = me?.role === 'SuperAdmin';
  return (
    <div>
      <PageHeader
        title="Approvals"
        subtitle={seesAll
          ? 'Every open request across the organisation, whoever it is addressed to. Deciding one here overrides the rungs that have not had their turn, and tells them so.'
          : 'Leave and resignation requests climbing the reporting hierarchy that are waiting on you, plus those you sit above.'}
      />

      <ApprovalsBoard />
    </div>
  );
}
