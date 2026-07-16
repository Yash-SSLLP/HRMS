import PageHeader from '../components/PageHeader';
import LeaveApprovalsInbox from '../components/LeaveApprovalsInbox';
import ExitApprovalsInbox from '../components/ExitApprovalsInbox';

// Approver inbox for the employee portal. Visible to everyone because ANY
// employee can be someone's reporting manager in the org chart — not just people
// with the "Manager" role. Shows an empty state for non-approvers.
export default function EmployeeApprovals() {
  return (
    <div>
      <PageHeader
        title="Approvals"
        subtitle="Requests from your team climbing the reporting hierarchy that are waiting on you."
      />

      <h2 className="card-title mb-3">Leave</h2>
      <LeaveApprovalsInbox />

      <h2 className="card-title mt-8 mb-3">Resignations</h2>
      <ExitApprovalsInbox />
    </div>
  );
}
