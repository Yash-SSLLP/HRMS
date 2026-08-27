/**
 * EmployeeApprovals — approver inbox (employee portal). Hosts the leave and
 * resignation approval inboxes (LeaveApprovalsInbox / ExitApprovalsInbox), which
 * fetch requests from the user's reporting chain. Data fetching lives in those
 * child components; this page just composes them.
 */
import PageHeader from '../components/PageHeader';
import ApprovalsBoard from '../components/ApprovalsBoard';

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

      <ApprovalsBoard />
    </div>
  );
}
