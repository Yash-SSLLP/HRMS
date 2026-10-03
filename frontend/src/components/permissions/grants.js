/**
 * Every per-person grant on the Permissions page, described ONCE (2026-10-03).
 *
 * The person list, the grant drawer, the matrix and the "What these grants
 * mean" reference all read this file, so a grant added here appears in all four
 * and a sentence fixed here is fixed everywhere. Before the redesign each grant
 * was a hand-written column, a hand-written toggle function and a hand-written
 * guide entry — three copies that had already started to drift.
 *
 * A SWITCH is one boolean on one account, saved by
 * PATCH /admin/users/:id/<path> { enabled } — the server answers
 * `{ id, <field>: value }`. A SECTION groups the switches people think of
 * together and says when they do not apply to an account (an outside HR
 * consultancy, an account with no employee profile, …).
 */
import { GRANTABLE_ROLES } from '../../config/permissions';

/**
 * What each grant actually does. Used as the inline help in the drawer, as the
 * tooltip on every switch, and as the reference panel — so they cannot drift.
 */
export const GRANT_HELP = {
  cashbook: 'Open the cashbook: record money in and out of the company’s cash accounts. A standalone grant — any account can hold it, whatever their role.',
  assets: 'Issue, return and track company assets.',
  training: 'Opens the training module: the schedule, and booking on it. They can create a training, set its dates and times, add participants, edit it and cancel it — the same page HR uses, reached from My Portal. A standalone grant because whoever organises training is as often a department lead or a coordinator as HR, and the capability list only reaches HR Manager and Manager accounts.',
  taskProxy: 'Assign a task on somebody else’s behalf: the assign form offers “On behalf of”, and the task goes out in that person’s name — they approve it and it sits in their “Assigned by me” — while the record keeps who actually sent it. The sender does not keep it: once sent, it leaves their own lists and they hear nothing more about it. For an assistant or coordinator who hands out work for a director or a department head.',
  taskRecurring: 'Set up recurring tasks: opens the Recurring Tasks page — daily, weekly, monthly or yearly schedules that drop a task into people’s Tasks each time one comes round — and lets them pause, change and stop the ones they set. Schedules already running keep running either way; this decides who may see and change them.',
  taskPoints: 'Set a task’s points: the Points box on the assign form (and on recurring tasks). Without it the box is not shown and every task they set carries the company’s default points.',
  taskBulkDelete: 'Delete tasks in bulk: tick several tasks on the Tasks page and remove them together — any task they can see, like a Super Admin, not only the ones they set. Removed tasks keep their history and any points already credited; deleting for good stays a Super Admin’s.',
  taskReminders: 'Set a task’s notifications: the Reminders section on the assign form — before or after the deadline, or repeating until it is done, by app or email. Without it the section is not shown and the task simply gets the company’s default reminder.',
  loans: 'Decide staff loans and salary advances: the queue of requests, approve or decline, raise one on somebody’s behalf, and record repayments. A standalone grant — sanctioning an advance is as often an accounts job as an HR one, and this is the only way to give it to an account that is neither.',
  incentive: 'A role per incentive tab. Manager runs it — the point rate, the yield, the sheet counts, and correcting anything saved. Picker only puts together their own team for the day, and cannot edit it once saved.',
  khata: 'Open the employee cashbook: give cash advances to staff, confirm what they spend, and settle up.',
  khataExport: 'Download every employee’s balances and full ledger as a spreadsheet. No role grants this on its own — reading the ledger on screen and walking out with a copy of it are different decisions.',
  wfh: 'Lets them tick “working from home” on a punch. That punch is not measured against the office geofence, and the day records as WFH.',
  remotePunch: 'The office geofence stops applying to them entirely — for site, field and travelling staff. Their punches are never flagged as outside the office, and they do not have to declare anything. The GPS location is still recorded and still shown on the punch map.',
  managerProfiles: 'Lets this HR Manager open and edit the employee profiles of people whose role is Manager — their department, reporting line, grade and pay basis. Off for everyone by default, and never implied by “Create / manage employees”: a Manager approves their own team’s leave and attendance, so who may rearrange their record is named one account at a time. Their role, password and account status stay with Super Admins either way.',
  viewOnly: 'The God account can read the admin portal and change nothing, anywhere. There is no edit mode to switch on — the server refuses every write it makes. Choose which companies it may look at.',
  execEdit: 'A CEO/MD account is view-only by default. In edit mode it can change data anywhere an HR Manager can — but this page, the org settings and the audit log stay with Super Admins.',
  capabilities: 'The fine-grained admin list for HR Managers and Managers. An HR Manager with none set keeps full access; a Manager starts with nothing and only sees the admin portal once granted something. Their team duties come from the role and are unaffected.',
  companies: 'Which companies a CEO, MD, God or HR Consultancy account may see. With none chosen they see every company.',
};

// Why an outside HR consultancy has nothing to grant in the module sections.
export const EXTERNAL_HINT = 'An HR consultancy is an outside account: it can only add candidates and take their Round 1, so no module grant applies to it.';

/** One boolean per account. `short` is the word on a chip and in the matrix. */
export const SWITCHES = {
  cashbookAccess: { path: 'cashbook-access', label: 'Company Accounts', short: 'Company Accounts', help: GRANT_HELP.cashbook, err: 'Could not update cashbook access' },
  assetsAccess: { path: 'assets-access', label: 'Assets', short: 'Assets', help: GRANT_HELP.assets, err: 'Could not update assets access' },
  loansAccess: { path: 'loans-access', label: 'Loans & advances', short: 'Loans', help: GRANT_HELP.loans, err: 'Could not update loan access' },
  trainingAccess: { path: 'training-access', label: 'Training', short: 'Training', help: GRANT_HELP.training, err: 'Could not update training access' },
  taskProxyAccess: { path: 'task-proxy-access', label: 'Assign on somebody’s behalf', short: 'On behalf', help: GRANT_HELP.taskProxy, err: 'Could not update the tasks permission' },
  taskRecurringAccess: { path: 'task-recurring-access', label: 'Recurring tasks', short: 'Recurring', help: GRANT_HELP.taskRecurring, err: 'Could not update the recurring tasks permission' },
  taskReminderAccess: { path: 'task-reminder-access', label: 'Task reminders', short: 'Reminders', help: GRANT_HELP.taskReminders, err: 'Could not update the task reminders permission' },
  taskPointsAccess: { path: 'task-points-access', label: 'Task points', short: 'Points', help: GRANT_HELP.taskPoints, err: 'Could not update the task points permission' },
  taskBulkDeleteAccess: { path: 'task-bulk-delete-access', label: 'Delete tasks in bulk', short: 'Bulk delete', help: GRANT_HELP.taskBulkDelete, err: 'Could not update the bulk delete permission' },
  khataAccess: { path: 'khata-access', label: 'Employee Cashbook', short: 'Module', help: GRANT_HELP.khata, err: 'Could not update cashbook access' },
  khataExportAccess: { path: 'khata-export-access', label: 'Download the ledger', short: 'Export', help: GRANT_HELP.khataExport, err: 'Could not update cashbook download access' },
  wfhAllowed: { path: 'wfh-access', label: 'Work from home', short: 'WFH', help: GRANT_HELP.wfh, err: 'Could not update work-from-home access' },
  remotePunchAllowed: { path: 'remote-punch-access', label: 'Punch from anywhere', short: 'Anywhere', help: GRANT_HELP.remotePunch, err: 'Could not update punch-location access' },
  managerProfileAccess: { path: 'manager-profile-access', label: 'Edit Manager profiles', short: 'Manager profiles', help: GRANT_HELP.managerProfiles, err: 'Could not update Manager-profile access' },
  execEditAccess: { path: 'exec-edit-access', label: 'Edit mode', short: 'Edit mode', help: GRANT_HELP.execEdit, err: 'Could not update executive access' },
};

export const isExternal = (u) => u?.role === 'HRConsultancy';
export const isExec = (u) => ['CEO', 'MD'].includes(u?.role);
export const hasCompanyScope = (u) => isExec(u) || u?.role === 'God' || isExternal(u);

/**
 * The switch sections, in the order the drawer shows them. `na(u)` says why the
 * section does not apply to this account (null when it does); `byRole(u)` says
 * the account already holds all of it by its role, so there is nothing to grant.
 */
export const SECTIONS = [
  {
    id: 'modules', title: 'Modules', chipPrefix: '',
    keys: ['cashbookAccess', 'assetsAccess', 'loansAccess', 'trainingAccess'],
    na: (u) => (isExternal(u) ? 'Not for an outside agency' : null),
  },
  {
    id: 'tasks', title: 'Tasks', chipPrefix: 'Tasks · ',
    keys: ['taskProxyAccess', 'taskRecurringAccess', 'taskReminderAccess', 'taskPointsAccess', 'taskBulkDeleteAccess'],
    na: (u) => (isExternal(u) ? 'Not for an outside agency' : null),
    byRole: (u) => (u?.role === 'SuperAdmin' ? 'All, by role' : null),
  },
  {
    // Reaching the module and taking its data out are two decisions, so two
    // switches — and the second shows even for roles that already reach the
    // module, since none of them can download without it.
    id: 'khata', title: 'Employee Cashbook', chipPrefix: 'Cashbook · ',
    keys: ['khataAccess', 'khataExportAccess'],
    na: (u) => (isExternal(u) ? 'Not for an outside agency' : null),
  },
  {
    // Both attendance flags live on the employee profile, so an account without
    // one (CEO/MD) has nothing to grant.
    id: 'attendance', title: 'Attendance', chipPrefix: '',
    keys: ['wfhAllowed', 'remotePunchAllowed'],
    na: (u) => (u?.hasProfile ? null : 'No employee profile'),
  },
  {
    id: 'records', title: 'Employee records', chipPrefix: '',
    keys: ['managerProfileAccess'],
    na: (u) => (GRANTABLE_ROLES.includes(u?.role)
      ? null
      : 'HR Manager / Manager only'),
  },
];

/** The switches this account can actually be given (section applies, not held by role). */
export function grantableKeys(u) {
  return SECTIONS.filter((s) => !s.na(u) && !s.byRole?.(u)).flatMap((s) => s.keys);
}

/** Short chip labels for every switch this account holds, in section order. */
export function heldSwitches(u) {
  return SECTIONS.filter((s) => !s.na(u) && !s.byRole?.(u))
    .flatMap((s) => s.keys.filter((k) => u?.[k]).map((k) => `${s.chipPrefix}${SWITCHES[k].short}`));
}

/** The reference panel's rows: [term, meaning]. */
export const GUIDE = [
  ...SECTIONS.flatMap((s) => s.keys.map((k) => [
    s.id === 'modules' || s.id === 'records' ? SWITCHES[k].label : `${s.title} · ${SWITCHES[k].label}`,
    SWITCHES[k].help,
  ])),
  ['Incentive roles', GRANT_HELP.incentive],
  ['CEO / MD edit mode', GRANT_HELP.execEdit],
  ['Company access', GRANT_HELP.companies],
  ['Capabilities', GRANT_HELP.capabilities],
];
