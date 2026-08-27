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

export default function AdminApprovals() {
  return (
    <div>
      <PageHeader
        title="Approvals"
        subtitle="Leave and resignation requests climbing the reporting hierarchy that are waiting on you, plus those you sit above."
      />

      <ApprovalsBoard />
    </div>
  );
}
