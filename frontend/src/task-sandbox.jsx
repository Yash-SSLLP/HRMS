/**
 * TEMPORARY dev harness (delete after verifying, with task-sandbox.html).
 *
 * Renders the REAL task pages with the axios adapter swapped for fixtures, the
 * way review-demo.jsx does. THE POINT IS THAT NOTHING IS WRITTEN: this
 * project's local backend talks to the live Atlas cluster, so clicking about in
 * the real portal to check a layout would create real tasks, real notifications
 * and real audit rows in production. Fixtures make the pages exercisable with no
 * database at all.
 *
 * Every request the pages make is recorded on `window.__requests`, so it is also
 * a check that the pages ask for what they should.
 */
import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import api from './api/client';
import { useAuthStore } from './store/authStore';
import AdminTasks from './pages/AdminTasks';
import EmployeeTasks from './pages/EmployeeTasks';
import TaskDetail from './pages/TaskDetail';
import AdminTaskWorkflows from './pages/AdminTaskWorkflows';
import { DialogHost } from './components/dialogs';
import './index.css';

const ME = { _id: 'u-me', firstName: 'Priya', lastName: 'Sharma', role: 'HRManager', email: 'priya@example.test' };
const RAHUL = { _id: 'u-rahul', firstName: 'Rahul', lastName: 'Verma', role: 'Employee' };
const AMIT = { _id: 'u-amit', firstName: 'Amit', lastName: 'Kumar', role: 'Employee' };

const day = 86400000;
const iso = (offsetDays) => new Date(Date.now() + offsetDays * day).toISOString();

const mkTask = (o) => ({
  _id: o._id,
  code: o.code,
  title: o.title,
  description: o.description || '',
  status: o.status,
  statusLabel: o.status,
  priority: o.priority || 'Medium',
  progress: o.progress ?? 0,
  dueDate: o.dueDate,
  startDate: o.startDate,
  taskType: o.taskType || 'General',
  department: o.department || 'Operations',
  assignedTo: o.assignee || RAHUL,
  assignees: (o.assignees || [{ user: o.assignee || RAHUL, role: 'Owner', status: o.status, progress: o.progress ?? 0 }]),
  supervisor: ME,
  createdBy: ME,
  overdue: !!o.overdue,
  commentCount: o.commentCount || 0,
  minutesLogged: o.minutesLogged || 0,
  estimatedMinutes: o.estimatedMinutes,
  extensionCount: o.extensionCount || 0,
  rejectionCount: o.rejectionCount || 0,
  workflowName: o.workflowName,
  attachments: o.attachments || [],
  checklist: o.checklist || [],
  requirements: o.requirements || {},
  location: o.location || { captureOn: [], enforceOn: [], captured: [] },
  incentive: o.incentive || { enabled: false, points: 0 },
  tags: o.tags || [],
  customFields: o.customFields || [],
  stateNote: o.stateNote,
  column: o.column || 'progress',
});

const TASKS = [
  mkTask({ _id: 't1', code: 'TSK-2026-00041', title: 'Warehouse stock inspection', status: 'ASSIGNED', priority: 'Urgent', dueDate: iso(-1), overdue: true, department: 'Operations', location: { captureOn: ['start', 'submit'], enforceOn: ['submit'], captured: [] }, requirements: { photo: true, minPhotos: 3, remarks: true, location: true, checklist: true }, checklist: [{ _id: 'c1', text: 'Gate seal checked', done: true, mandatory: true, doneByName: 'Rahul Verma', doneAt: iso(-1) }, { _id: 'c2', text: 'Stock counted', done: false, mandatory: true }], incentive: { enabled: true, points: 20, distribution: 'share', setByName: 'Priya Sharma' } }),
  mkTask({ _id: 't2', code: 'TSK-2026-00042', title: 'Employee onboarding — Ankit Roy', status: 'IN_PROGRESS', priority: 'High', progress: 65, dueDate: iso(1), department: 'HR', workflowName: 'Employee Onboarding', minutesLogged: 145, estimatedMinutes: 240, commentCount: 3, assignees: [{ user: RAHUL, role: 'Owner', status: 'IN_PROGRESS', progress: 80, responsibility: 'Documents', minutesLogged: 95 }, { user: AMIT, role: 'Contributor', status: 'ACCEPTED', progress: 50, responsibility: 'IT setup', minutesLogged: 50 }] }),
  mkTask({ _id: 't3', code: 'TSK-2026-00043', title: 'Monthly attendance audit', status: 'SUBMITTED', dueDate: iso(0), department: 'HR', workflowName: 'Attendance Audit', progress: 80 }),
  mkTask({ _id: 't4', code: 'TSK-2026-00044', title: 'Asset verification — laptops', status: 'REJECTED', priority: 'High', dueDate: iso(2), progress: 40, stateNote: 'Serial numbers are missing for three of them.', rejectionCount: 1 }),
  mkTask({ _id: 't5', code: 'TSK-2026-00045', title: 'Vendor onboarding paperwork', status: 'COMPLETED', dueDate: iso(-5), progress: 100, department: 'Finance', incentive: { enabled: true, points: 10 } }),
  mkTask({ _id: 't6', code: 'TSK-2026-00046', title: 'Update the payroll checklist', status: 'BLOCKED', dueDate: iso(4), stateNote: 'Waiting on the revised CTC template from Finance.', progress: 20 }),
];

const DETAIL = {
  task: { ...TASKS[0], originalDueDate: iso(-3), assignedAt: iso(-4), acceptedAt: null, workflowVersion: 2, workflowName: 'Site Inspection' },
  can: { edit: true, review: true, work: true, manage: true },
  roles: ['assignee', 'reviewer', 'admin'],
  transitions: [
    { to: 'ACCEPTED', label: 'Accepted', needsReason: false },
    { to: 'ON_HOLD', label: 'On hold', needsReason: true },
    { to: 'CANCELLED', label: 'Cancelled', needsReason: true },
  ],
  workflow: [
    { key: 'assign', name: 'Site visit', type: 'assignment', status: 'Approved', actors: [{ user: 'u-rahul', name: 'Rahul Verma', decision: 'approved', decidedAt: iso(-2) }], completedAt: iso(-2) },
    { key: 'fin', name: 'Finance check', type: 'approval', status: 'Pending', parallelGroup: 'g1', join: 'all', actors: [{ user: 'u-me', name: 'Priya Sharma', decision: null }], dueAt: iso(-0.2) },
    { key: 'adm', name: 'Admin check', type: 'approval', status: 'Approved', parallelGroup: 'g1', join: 'all', actors: [{ user: 'u-amit', name: 'Amit Kumar', decision: 'approved', note: 'Logistics are fine.', decidedAt: iso(-1) }] },
    { key: 'dir', name: 'Director sign-off', type: 'approval', status: 'Waiting', actors: [] },
  ],
  requirements: [{ key: 'remarks', label: 'Remarks' }, { key: 'photo', label: 'Photo' }, { key: 'location', label: 'Location' }, { key: 'checklist', label: 'Checklist completed' }],
  activity: [
    { _id: 'a1', kind: 'created', byName: 'Priya Sharma', message: 'Priya Sharma created the task', at: iso(-4) },
    { _id: 'a2', kind: 'assigned', byName: 'Priya Sharma', message: 'Priya Sharma assigned it to Rahul Verma', at: iso(-4) },
    { _id: 'a3', kind: 'accepted', byName: 'Rahul Verma', message: 'Rahul Verma accepted the task', at: iso(-3.9) },
    { _id: 'a4', kind: 'started', byName: 'Rahul Verma', message: 'Rahul Verma started work', at: iso(-3), location: { lat: 12.9716, lng: 77.5946, distanceM: 42, insideFence: true } },
    { _id: 'a5', kind: 'geofenceBlocked', message: 'Refused: 5210 m from Main Warehouse, outside the 200 m fence', at: iso(-2.5), location: { lat: 13.02, lng: 77.59, distanceM: 5210, insideFence: false } },
    { _id: 'a6', kind: 'submitted', byName: 'Rahul Verma', message: 'Rahul Verma submitted for review', at: iso(-2) },
    { _id: 'a7', kind: 'rejected', byName: 'Priya Sharma', message: 'Priya Sharma sent the task back', note: 'Only two photos — the spec asks for three.', at: iso(-1.5) },
    { _id: 'a8', kind: 'resubmitted', byName: 'Rahul Verma', message: 'Rahul Verma submitted for review (attempt 2)', at: iso(-1) },
    { _id: 'a9', kind: 'escalated', message: 'Escalated to supervisor — 26 hours overdue', at: iso(-0.5) },
  ],
  submissions: [
    { _id: 's2', submittedByName: 'Rahul Verma', attempt: 2, status: 'Pending', submittedAt: iso(-1), remarks: 'All three photos attached this time, plus the gate seal close-up.', evidence: [{ _id: 'f1', name: 'gate-seal.jpg' }, { _id: 'f2', name: 'aisle-3.jpg' }, { _id: 'f3', name: 'aisle-4.jpg' }], urls: [], location: { lat: 12.9716, lng: 77.5946, distanceM: 42, insideFence: true } },
    { _id: 's1', submittedByName: 'Rahul Verma', attempt: 1, status: 'Rejected', submittedAt: iso(-2), remarks: 'Inspection done.', evidence: [{ _id: 'f0', name: 'aisle-3.jpg' }], reviewedByName: 'Priya Sharma', reviewNote: 'Only two photos — the spec asks for three.' },
  ],
  comments: [
    { _id: 'cm1', authorName: 'Priya Sharma', authorRole: 'HRManager', body: 'Please make sure aisle 4 is included this time.', createdAt: iso(-1.6), attachments: [] },
    { _id: 'cm2', authorName: 'Rahul Verma', authorRole: 'Employee', body: 'Done — added it.', createdAt: iso(-1), attachments: [] },
    { _id: 'cm3', authorName: 'Priya Sharma', authorRole: 'HRManager', internal: true, body: 'Second time this month. Worth a word with the team lead.', createdAt: iso(-0.9), attachments: [] },
  ],
  timeEntries: [
    { _id: 'te1', userName: 'Rahul Verma', startedAt: iso(-3), activeMinutes: 95, breakMinutes: 15, source: 'timer', status: 'stopped', approvalStatus: null },
    { _id: 'te2', userName: 'Rahul Verma', startedAt: iso(-1), activeMinutes: 50, breakMinutes: 0, source: 'manual', status: 'stopped', approvalStatus: 'Pending' },
  ],
  extensions: [
    { _id: 'x1', requestedByName: 'Rahul Verma', currentDueDate: iso(-3), requestedDueDate: iso(-1), approvedDueDate: iso(-1), status: 'Approved', reason: 'Site was closed on Tuesday.', decidedByName: 'Priya Sharma' },
  ],
  incentives: [
    { _id: 'i1', name: 'Rahul Verma', outcome: 'rejectedFirst', basis: '20 points × 50% (sent back before approval) ÷ 1 person', points: 10, status: 'Pending' },
  ],
  subtasks: [],
  blockers: [],
};

const META = {
  statuses: [], priorities: ['Low', 'Medium', 'High', 'Urgent'],
  columns: [], assigneeRoles: ['Owner', 'Contributor', 'Reviewer', 'Observer'],
  requirements: [], evidenceKinds: [],
  locationEvents: ['accept', 'start', 'submit', 'approve', 'complete'],
  geofenceRules: ['start', 'submit', 'complete'],
  incentiveOutcomes: [],
  defaultSplit: { early: 1, onTime: 0.8, late: 0.4, veryLate: 0, rejectedFirst: 0.5 },
  workflows: [{ _id: 'w1', name: 'Site Inspection', activeVersion: 2 }, { _id: 'w2', name: 'Employee Onboarding', activeVersion: 1 }],
  templates: [{ _id: 'tp1', name: 'Employee Onboarding', taskType: 'Onboarding' }],
  taskTypes: ['General', 'Onboarding', 'Audit', 'Inspection'],
  can: { manage: true, configure: true },
};

const WORKFLOW_DETAIL = {
  workflow: {
    _id: 'w1', name: 'Site Inspection', activeVersion: 2, active: true,
    draft: [
      { key: 'assign', name: 'Site visit', type: 'assignment', order: 0, assigneeRule: { kind: 'user', users: [], quorum: 'any' } },
      { key: 'fin', name: 'Finance check', type: 'approval', order: 1, parallelGroup: 'g1', join: 'all', assigneeRule: { kind: 'permission', permission: 'payroll.manage', quorum: 'any' }, slaHours: 24 },
      { key: 'adm', name: 'Admin check', type: 'approval', order: 2, parallelGroup: 'g1', join: 'all', assigneeRule: { kind: 'supervisor', quorum: 'any' } },
      { key: 'gate', name: 'Over ₹50,000?', type: 'condition', order: 3, condition: { field: 'customFields.amount', operator: 'gt', value: 50000, onTrue: 'dir', onFalse: '' } },
      { key: 'dir', name: 'Director sign-off', type: 'approval', order: 4, assigneeRule: { kind: 'role', roles: ['CEO', 'MD'], quorum: 'any' } },
    ],
    versions: [
      { version: 1, steps: [{}, {}], publishedByName: 'Priya Sharma', publishedAt: iso(-30) },
      { version: 2, steps: [{}, {}, {}], publishedByName: 'Priya Sharma', publishedAt: iso(-5) },
    ],
  },
  taskCount: 4,
  problems: [],
};

const FIXTURES = {
  '/tasks/meta': META,
  '/tasks/me/timer': { entry: { _id: 'te-live', task: { _id: 't2', title: 'Employee onboarding — Ankit Roy' }, startedAt: new Date(Date.now() - 22 * 60000).toISOString(), status: 'running', pauses: [], liveMinutes: 22 } },
  '/tasks/me/summary': { counts: {}, total: 6, open: 5, completed: 1, dueToday: 1, overdue: 1, pendingApprovals: 2, awaitingAccept: 1, incentive: { earned: 34, pending: 10 }, runningTimer: null },
  '/tasks/approvals': { count: 2, tasks: [{ ...TASKS[2], submittedAt: iso(-0.5), submissions: [{ _id: 's9', remarks: 'Audit complete for 214 employees; three exceptions listed in the sheet.' }], step: { name: 'HR verification' } }, { ...TASKS[1], submittedAt: iso(-2), submissions: [], step: null }] },
  '/tasks/incentives': { count: 1, pendingPoints: 10, incentives: [{ _id: 'i1', name: 'Rahul Verma', employeeCode: 'SS-1042', taskTitle: 'Warehouse stock inspection', taskCode: 'TSK-2026-00041', task: { _id: 't1' }, outcome: 'rejectedFirst', basis: '20 points × 50% (sent back before approval) ÷ 1 person', points: 10, status: 'Pending' }] },
  '/tasks/workload': { count: 3, people: [
    { user: 'u-rahul', name: 'Rahul Verma', employeeCode: 'SS-1042', department: 'Operations', total: 12, active: 8, overdue: 2, dueToday: 1, completed: 4, estimatedHours: 31, loggedHours: 26.5 },
    { user: 'u-amit', name: 'Amit Kumar', employeeCode: 'SS-1088', department: 'IT', total: 20, active: 15, overdue: 5, dueToday: 3, completed: 5, estimatedHours: 46, loggedHours: 41 },
    { user: 'u-p', name: 'Priya Nair', employeeCode: 'SS-1101', department: 'HR', total: 4, active: 4, overdue: 0, dueToday: 0, completed: 0, estimatedHours: 22, loggedHours: 9 },
  ] },
  '/task-workflows': { count: 2, workflows: [
    { _id: 'w1', name: 'Site Inspection', description: 'Visit, two parallel checks, a value gate, then the director.', stepCount: 5, versionCount: 2, activeVersion: 2, taskCount: 4, active: true, versions: [] },
    { _id: 'w2', name: 'Employee Onboarding', stepCount: 3, versionCount: 1, activeVersion: null, taskCount: 0, active: true, versions: [] },
  ] },
  '/task-workflows/templates': { count: 1, templates: [
    { _id: 'tp1', name: 'Employee Onboarding', taskType: 'Onboarding', description: 'Documents, IT, orientation.', workflow: { name: 'Employee Onboarding' }, trigger: 'employee.created', usageCount: 12, active: true, system: true },
  ] },
  '/task-workflows/recurring': { count: 1, recurring: [
    { _id: 'r1', name: 'Monthly attendance audit', template: { name: 'Attendance Audit' }, frequency: 'monthly', interval: 1, nextOccurrence: iso(12), generatedCount: 9, active: true },
  ] },
  '/admin/users?active=true&excludeExecutives=true': { users: [ME, RAHUL, AMIT] },
  '/projects': { projects: [{ _id: 'p1', name: 'Q3 Compliance' }] },
  '/work-locations': { locations: [{ _id: 'wl1', name: 'Main Warehouse', radiusM: 200 }] },
};

window.__requests = [];
api.defaults.adapter = async (config) => {
  const url = config.url + (config.params ? `?${new URLSearchParams(
    Object.entries(config.params).filter(([, v]) => v != null).map(([k, v]) => [k, String(v)])
  )}` : '');
  window.__requests.push({ method: config.method, url });

  let data = FIXTURES[config.url] ?? FIXTURES[url];

  if (!data) {
    if (config.url === '/tasks') data = { count: TASKS.length, total: TASKS.length, page: 1, pages: 1, tasks: TASKS };
    else if (config.url === '/tasks/me') data = { count: 4, tasks: TASKS.slice(0, 4) };
    else if (config.url === '/tasks/board') {
      data = { columns: [
        { key: 'new', label: 'New', tasks: [TASKS[0]] },
        { key: 'accepted', label: 'Accepted', tasks: [] },
        { key: 'progress', label: 'In progress', tasks: [TASKS[1], TASKS[3], TASKS[5]] },
        { key: 'submitted', label: 'Submitted', tasks: [TASKS[2]] },
        { key: 'review', label: 'Review', tasks: [] },
        { key: 'done', label: 'Completed', tasks: [TASKS[4]] },
      ] };
    } else if (/^\/tasks\/[^/]+$/.test(config.url)) data = DETAIL;
    else if (/^\/task-workflows\/[^/]+$/.test(config.url)) data = WORKFLOW_DETAIL;
    else data = {};
  }
  return { data, status: 200, statusText: 'OK', headers: {}, config };
};

useAuthStore.setState({ user: ME, token: 'sandbox' });
document.documentElement.setAttribute('data-role', 'HRManager');
document.documentElement.setAttribute('data-portal', 'admin');

const PAGES = [
  ['Admin tasks', <AdminTasks key="a" />],
  ['Task detail', <TaskDetail key="d" base="/admin/tasks" />],
  ['My tasks', <EmployeeTasks key="e" />],
  ['Workflows', <AdminTaskWorkflows key="w" />],
];

function Sandbox() {
  const [i, setI] = useState(0);
  return (
    <MemoryRouter initialEntries={['/admin/tasks/t1']}>
      <div className="p-4">
        <div className="flex gap-2 mb-4 flex-wrap">
          {PAGES.map(([label], j) => (
            <button key={label} type="button" onClick={() => setI(j)}
              className={`px-3 py-2 text-sm rounded-lg border ${i === j ? 'bg-gray-900 text-white border-gray-900' : 'bg-white border-gray-300'}`}
              data-testid={`sandbox-${j}`}>
              {label}
            </button>
          ))}
        </div>
        <Routes>
          <Route path="*" element={PAGES[i][1]} />
        </Routes>
        <DialogHost />
      </div>
    </MemoryRouter>
  );
}

createRoot(document.getElementById('root')).render(<Sandbox />);
