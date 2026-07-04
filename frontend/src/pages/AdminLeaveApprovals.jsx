import PageHeader from '../components/PageHeader';
import LeaveApprovalsInbox from '../components/LeaveApprovalsInbox';

// Approver inbox for the admin portal — used mainly by CEO/MD (and any admin who
// sits in someone's reporting chain). It hits /api/approvals/* which is
// protect-only, so the read-only CEO/MD executives CAN act here even though they
// can't write on the admin-gated routes.
export default function AdminLeaveApprovals() {
  return (
    <div>
      <PageHeader
        title="Leave Approvals"
        subtitle="Leave requests climbing the reporting hierarchy that are waiting on you, plus those you sit above."
      />
      <LeaveApprovalsInbox />
    </div>
  );
}
