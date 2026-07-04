import PageHeader from '../components/PageHeader';
import LeaveApprovalsInbox from '../components/LeaveApprovalsInbox';

// Approver inbox for the employee portal. Visible to everyone because ANY
// employee can be someone's reporting manager in the org chart — not just people
// with the "Manager" role. Shows an empty state for non-approvers.
export default function EmployeeApprovals() {
  return (
    <div>
      <PageHeader
        title="Approvals"
        subtitle="Leave requests from your team climbing the reporting hierarchy that are waiting on you."
      />
      <LeaveApprovalsInbox />
    </div>
  );
}
