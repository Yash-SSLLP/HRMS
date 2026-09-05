/**
 * AdminPermissions — SuperAdmin-only access-control console (admin portal).
 *
 * THE PAGE IS A MATRIX: people down the side, grants across the top. Everything
 * about the layout serves being able to answer two questions at a glance —
 * "what can this person reach?" (read a row) and "who can reach this?" (read a
 * column) — which is what an access review actually consists of.
 *
 * Three deliberate choices, because the previous version got each of them wrong:
 *
 *  1. EVERY GRANT IS THE SAME CONTROL. One switch, one accent colour, in every
 *     column. Grants used to be filled pills in five different hues — teal,
 *     purple, indigo, sky, amber — which carried no meaning (nothing about
 *     "export" is more purple than "assets") and made a security screen look
 *     like a toy. Colour is now reserved for the two places it MEANS something:
 *     the role chip, and the accent that says "on".
 *  2. THE EXPLANATION IS ON DEMAND. What each grant does used to be a
 *     twelve-line paragraph above the table that nobody read and everybody
 *     scrolled past. It is now a reference panel behind a button, plus a
 *     tooltip on each switch — there when you need it, out of the way when you
 *     are working.
 *  3. ORG-WIDE AND PER-PERSON ARE DIFFERENT THINGS. The switches that change
 *     the whole company (chat, the advance-approval gate) sit in their own
 *     section, above and visually apart from the per-person matrix, rather than
 *     reading as two more cards of the same weight.
 *
 * Grants it manages, all SuperAdmin-only on the server too: standalone module
 * access for anyone (cashbook / expenses / assets / khata), the separate khata
 * DOWNLOAD grant, the two per-employee attendance grants (WFH and
 * punch-anywhere), executive edit mode for a CEO/MD account, and the granular
 * capability list for HR Managers and Managers. It also hosts the org-wide
 * settings from GET/PUT /admin/org-settings — the chat module, the CEO/MD
 * advance-approval gate, and the footer printed on khata statement PDFs.
 */
import { useEffect, useMemo, useState } from 'react';
import {
  FiSearch, FiInfo, FiSliders, FiX, FiCheck, FiAlertCircle, FiHome,
} from 'react-icons/fi';
import api from '../api/client';
import PageHeader from '../components/PageHeader';
import ToggleSwitch from '../components/ToggleSwitch';
import { roleLabel } from '../config/roles';
import { GRANTABLE_ROLES } from '../config/permissions';
import { useAuthStore } from '../store/authStore';

/**
 * Role chips are the ONE place a colour carries information on this page: which
 * kind of account this is. Tints only (`bg-*-50` + `text-*-700`), never a filled
 * chip, so a column of them reads as labels rather than as a row of buttons —
 * and every hue here has a dark-mode remap in index.css.
 */
const ROLE_TONES = {
  SuperAdmin: 'bg-violet-50 text-violet-700 border-violet-200',
  HRManager: 'bg-teal-50 text-teal-700 border-teal-200',
  CEO: 'bg-amber-50 text-amber-800 border-amber-200',
  MD: 'bg-amber-50 text-amber-800 border-amber-200',
  Manager: 'bg-indigo-50 text-indigo-700 border-indigo-200',
  LDManager: 'bg-sky-50 text-sky-700 border-sky-200',
  AccountsManager: 'bg-emerald-50 text-emerald-700 border-emerald-200',
  Employee: 'bg-gray-100 text-gray-600 border-gray-200',
};

/** Initials for the identity cell's avatar. */
const initials = (u) => `${(u.firstName || '')[0] || ''}${(u.lastName || '')[0] || ''}`.toUpperCase() || '?';

/**
 * What each grant actually does, in one place.
 *
 * Written once and used twice — as the reference panel and as the `title` on
 * every switch — so the tooltip and the documentation cannot drift apart, which
 * is exactly what happened when both were maintained by hand.
 */
const GRANT_HELP = {
  cashbook: 'Open the cashbook: record money in and out of the company’s cash accounts. A standalone grant — any account can hold it, whatever their role.',
  expenses: 'Review, approve and settle staff expense claims.',
  assets: 'Issue, return and track company assets.',
  khata: 'Open the employee cashbook: give cash advances to staff, confirm what they spend, and settle up.',
  khataExport: 'Download every employee’s balances and full ledger as a spreadsheet. No role grants this on its own — reading the ledger on screen and walking out with a copy of it are different decisions.',
  wfh: 'Lets them tick “working from home” on a punch. That punch is not measured against the office geofence, and the day records as WFH.',
  remotePunch: 'The office geofence stops applying to them entirely — for site, field and travelling staff. Their punches are never flagged as outside the office, and they do not have to declare anything. The GPS location is still recorded and still shown on the punch map.',
  managerProfiles: 'Lets this HR Manager open and edit the employee profiles of people whose role is Manager — their department, reporting line, grade and pay basis. Off for everyone by default, and never implied by “Create / manage employees”: a Manager approves their own team’s leave and attendance, so who may rearrange their record is named one account at a time. Their role, password and account status stay with Super Admins either way.',
  execEdit: 'A CEO/MD account is view-only by default. In edit mode it can change data anywhere an HR Manager can — but this page, the org settings and the audit log stay with Super Admins.',
};

/**
 * One labelled switch inside a column that holds two related grants.
 *
 * `label` is the short word beside the switch ("Module", "Export"); `aria` is
 * the full name a screen reader needs, because "Export" on its own says nothing
 * about what is being exported once the column header is out of earshot.
 */
function GrantRow({ label, aria, ...rest }) {
  return (
    <div className="flex items-center gap-2">
      <ToggleSwitch size="sm" label={aria || label} {...rest} />
      <span className="text-[11px] leading-tight text-gray-500 whitespace-nowrap">{label}</span>
    </div>
  );
}

/** A cell for a grant that does not apply to this kind of account. */
const NotApplicable = ({ hint }) => (
  <span title={hint} className="text-gray-300 select-none">—</span>
);

/** One org-wide setting: what it does on the left, the switch on the right. */
function SettingRow({ title, description, checked, onChange, busy, onLabel, offLabel }) {
  return (
    <div className="flex items-start justify-between gap-6 py-4">
      <div className="min-w-0">
        <div className="text-sm font-medium text-gray-900">{title}</div>
        <p className="text-xs text-gray-500 mt-1 leading-relaxed max-w-3xl">{description}</p>
      </div>
      <div className="flex items-center gap-2.5 shrink-0 pt-0.5">
        <span className={`text-xs font-medium ${checked ? 'accent-text' : 'text-gray-400'}`}>
          {checked ? onLabel : offLabel}
        </span>
        <ToggleSwitch checked={checked} onChange={onChange} busy={busy} label={title} />
      </div>
    </div>
  );
}

export default function AdminPermissions() {
  const me = useAuthStore((s) => s.user);
  const isSuperAdmin = me?.role === 'SuperAdmin';

  const [users, setUsers] = useState([]);
  const [companies, setCompanies] = useState([]);
  const [catalog, setCatalog] = useState([]);
  const [q, setQ] = useState('');
  const [roleFilter, setRoleFilter] = useState('');
  const [showGuide, setShowGuide] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [busyId, setBusyId] = useState(null);

  const [permUser, setPermUser] = useState(null);
  const [permSel, setPermSel] = useState(() => new Set());
  const [permSaving, setPermSaving] = useState(false);

  // CEO/MD company-access modal: which companies this exec may see and manage.
  const [companyUser, setCompanyUser] = useState(null);
  const [companySel, setCompanySel] = useState(() => new Set());
  const [companySaving, setCompanySaving] = useState(false);
  const allKeys = catalog.map((p) => p.key);

  // Org-wide feature switches.
  const [org, setOrg] = useState({
    chatEnabled: false,
    khataAdvanceApprovalRequired: true,
    documentFooter: { helpline: '', note: '' },
  });
  const [orgBusy, setOrgBusy] = useState(false);
  // The footer inputs are edited freely and saved on a button, unlike the
  // switches — so they need their own draft, or every keystroke would be a PUT.
  const [footer, setFooter] = useState({ helpline: '', note: '' });
  const [footerSaved, setFooterSaved] = useState(false);

  // One reader for the org payload, so a switch save cannot drop a field it
  // does not know about — which is exactly how the footer would have been wiped
  // by the next toggle.
  const readOrg = (d = {}) => ({
    chatEnabled: !!d.chatEnabled,
    // Absent means the server has not been upgraded yet; the gate is on by
    // default there too, so assume on rather than showing it as disabled.
    khataAdvanceApprovalRequired: d.khataAdvanceApprovalRequired !== false,
    documentFooter: {
      helpline: d.documentFooter?.helpline || '',
      note: d.documentFooter?.note || '',
    },
  });

  const load = async () => {
    setLoading(true); setError('');
    try {
      const [u, c, o, comp] = await Promise.all([
        api.get('/admin/users'),
        // A catalogue that fails to load is NOT a quiet degradation: the
        // capability dialog would render empty and its Save would write "no
        // capabilities" to whoever it was opened on. The rest of the page still
        // loads; the error below and the disabled Save are what make it safe.
        api.get('/admin/permissions/catalog').catch(() => ({ data: { permissions: [], failed: true } })),
        api.get('/admin/org-settings').catch(() => ({ data: {} })),
        api.get('/companies').catch(() => ({ data: { companies: [] } })),
      ]);
      setUsers(u.data.users || []);
      setCompanies(comp.data.companies || []);
      setCatalog(c.data.permissions || []);
      if (c.data.failed) setError('Could not load the permission list — reload the page before changing anyone\u2019s capabilities.');
      const next = readOrg(o.data);
      setOrg(next);
      setFooter(next.documentFooter);
    } catch (err) {
      setError(err.response?.data?.message || 'Failed to load');
    } finally {
      setLoading(false);
    }
  };
  useEffect(() => { load(); }, []);

  // Optimistic toggle that reverts if the save fails. One handler for every
  // org switch, keyed by field, so adding another is one line rather than a
  // second copy of the same optimistic-update dance.
  const toggleOrg = async (field, errorText) => {
    const next = !org[field];
    setOrgBusy(true); setError('');
    setOrg({ ...org, [field]: next });
    try {
      const { data } = await api.put('/admin/org-settings', { [field]: next });
      setOrg(readOrg(data));
    } catch (err) {
      setOrg({ ...org, [field]: !next });
      setError(err.response?.data?.message || errorText);
    } finally {
      setOrgBusy(false);
    }
  };

  // The contact strip printed along the bottom of the khata statement PDF.
  const saveFooter = async () => {
    setOrgBusy(true); setError(''); setFooterSaved(false);
    try {
      const { data } = await api.put('/admin/org-settings', { documentFooter: footer });
      const next = readOrg(data);
      setOrg(next);
      setFooter(next.documentFooter);
      setFooterSaved(true);
    } catch (err) {
      setError(err.response?.data?.message || 'Could not save the statement footer');
    } finally {
      setOrgBusy(false);
    }
  };
  const footerDirty = footer.helpline !== org.documentFooter.helpline
    || footer.note !== org.documentFooter.note;

  /** Merge fields into ONE row of the table, leaving every other row untouched. */
  const patchRow = (id, patch) => setUsers((rows) => rows.map(
    (r) => (String(r._id || r.id) === String(id) ? { ...r, ...patch } : r)
  ));

  // Every per-person grant is the same call shape — PATCH one flag on one user
  // — so they share one handler and each toggle below is a single line.
  //
  // OPTIMISTIC, and deliberately so. This used to `await load()` after every
  // switch: four requests, the loading skeleton over the whole table, and the
  // scroll position back at the top — a full page reload to learn one boolean
  // the click already told us. The switch now paints immediately, the server's
  // own answer overwrites it, and a failure puts the switch back and says why.
  // Nothing else on the page moves. (`toggleOrg` above has always worked this
  // way; this brings the 50-row matrix in line with it.)
  const toggleAccess = async (u, { path, field, enabled, errorText }) => {
    const id = u._id || u.id;
    setBusyId(`${id}:${field}`); setError('');
    patchRow(id, { [field]: enabled });
    try {
      const { data } = await api.patch(`/admin/users/${id}/${path}`, { enabled });
      // Each of these endpoints answers `{ id, <field>: value }` — apply
      // whatever it names rather than trusting the guess above, so a server
      // that refuses or adjusts the value is what ends up on screen.
      const { id: _saved, ...fields } = data || {};
      if (Object.keys(fields).length) patchRow(id, fields);
    } catch (err) {
      patchRow(id, { [field]: !enabled }); // put the switch back
      setError(err.response?.data?.message || errorText);
    } finally {
      setBusyId(null);
    }
  };

  const toggleCashbook = (u) => toggleAccess(u, {
    path: 'cashbook-access', field: 'cashbookAccess', enabled: !u.cashbookAccess, errorText: 'Could not update cashbook access',
  });

  const toggleExpenses = (u) => toggleAccess(u, {
    path: 'expenses-access', field: 'expensesAccess', enabled: !u.expensesAccess, errorText: 'Could not update expenses access',
  });

  const toggleAssets = (u) => toggleAccess(u, {
    path: 'assets-access', field: 'assetsAccess', enabled: !u.assetsAccess, errorText: 'Could not update assets access',
  });

  // Two separate khata grants on purpose. The first opens the module so someone
  // can hand cash to staff and settle it; the second lets them download every
  // employee's ledger as a spreadsheet, which is data leaving the building and
  // therefore its own decision. Granting the download alone is allowed — it just
  // does nothing until the person can also reach the module.
  const toggleKhata = (u) => toggleAccess(u, {
    path: 'khata-access', field: 'khataAccess', enabled: !u.khataAccess, errorText: 'Could not update cashbook access',
  });

  const toggleKhataExport = (u) => toggleAccess(u, {
    path: 'khata-export-access', field: 'khataExportAccess', enabled: !u.khataExportAccess, errorText: 'Could not update cashbook download access',
  });

  // Which HR (or granted Manager) may edit a Manager's employee profile. Kept
  // out of the capability dialog on purpose: an HR Manager with no capability
  // list holds every key in that dialog by default, so putting it there would
  // hand it to every HR account at once — the opposite of a named list.
  const toggleManagerProfiles = (u) => toggleAccess(u, {
    path: 'manager-profile-access', field: 'managerProfileAccess', enabled: !u.managerProfileAccess, errorText: 'Could not update Manager-profile access',
  });

  // CEO/MD only: flip the account between view-only (the default) and edit mode.
  const toggleExecEdit = (u) => toggleAccess(u, {
    path: 'exec-edit-access', field: 'execEditAccess', enabled: !u.execEditAccess, errorText: 'Could not update executive access',
  });

  const toggleWfh = (u) => toggleAccess(u, {
    path: 'wfh-access', field: 'wfhAllowed', enabled: !u.wfhAllowed, errorText: 'Could not update work-from-home access',
  });

  /**
   * Let this employee punch in and out from anywhere.
   *
   * Deliberately a separate grant from WFH rather than a wider reading of it.
   * WFH is something the employee declares on a punch, and it records that they
   * worked from home that day. This says the office geofence does not apply to
   * them at all — the answer for site engineers, field sales and drivers, who
   * should not have to claim they were at home to avoid being flagged for being
   * where their job is.
   */
  const toggleRemotePunch = (u) => toggleAccess(u, {
    path: 'remote-punch-access', field: 'remotePunchAllowed', enabled: !u.remotePunchAllowed, errorText: 'Could not update punch-location access',
  });

  // Seed the dialog with what the account effectively holds RIGHT NOW. A null
  // array is "all" for an HR Manager but "none" for a Manager — seeding every
  // box for a Manager would mean one careless Save handed them full admin.
  const openPerms = (u) => {
    const effective = u.permissions == null
      ? (u.role === 'HRManager' ? allKeys : [])
      : u.permissions;
    setPermSel(new Set(effective));
    setPermUser(u);
  };
  const togglePerm = (key) => setPermSel((s) => { const n = new Set(s); n.has(key) ? n.delete(key) : n.add(key); return n; });
  const savePerms = async () => {
    setPermSaving(true); setError('');
    try {
      const id = permUser._id || permUser.id;
      const { data } = await api.patch(`/admin/users/${id}/permissions`, { permissions: [...permSel] });
      // Same reason as toggleAccess: patch the one row instead of reloading the
      // page behind the modal. This endpoint answers with the whole user.
      patchRow(id, { permissions: data?.user?.permissions ?? [...permSel] });
      setPermUser(null);
    } catch (err) {
      setError(err.response?.data?.message || 'Could not save permissions');
    } finally {
      setPermSaving(false);
    }
  };

  // CEO/MD company access. A stored value is the exact list; an empty/absent one
  // means EVERY company (see User.companies) — so we open the picker empty and
  // treat "nothing ticked" as unrestricted.
  const openCompanies = (u) => {
    setCompanySel(new Set((u.companies || []).map(String)));
    setCompanyUser(u);
  };
  const toggleCompany = (id) => setCompanySel((s) => { const n = new Set(s); n.has(id) ? n.delete(id) : n.add(id); return n; });
  const saveCompanies = async () => {
    setCompanySaving(true); setError('');
    try {
      const id = companyUser._id || companyUser.id;
      const { data } = await api.patch(`/admin/users/${id}/companies`, { companyIds: [...companySel] });
      patchRow(id, { companies: data?.companies ?? [...companySel] });
      setCompanyUser(null);
    } catch (err) {
      setError(err.response?.data?.message || 'Could not save company access');
    } finally {
      setCompanySaving(false);
    }
  };

  const permGroups = catalog.reduce((acc, p) => { (acc[p.group] = acc[p.group] || []).push(p); return acc; }, {});
  /** Flip a whole capability group at once — the common shape of a real change. */
  const toggleGroup = (items, on) => setPermSel((s) => {
    const n = new Set(s);
    items.forEach((p) => (on ? n.add(p.key) : n.delete(p.key)));
    return n;
  });

  /** How many capabilities an account effectively holds, for the row's badge. */
  const capCount = (u) => (u.permissions == null
    ? (u.role === 'HRManager' ? allKeys.length : 0)
    : u.permissions.length);

  // The role list is built from who is actually on the page rather than from
  // ROLES, so the filter never offers a role that would return nothing.
  const rolesPresent = useMemo(
    () => [...new Set(users.map((u) => u.role))].sort((a, b) => roleLabel(a).localeCompare(roleLabel(b))),
    [users]
  );

  const filtered = useMemo(() => {
    const t = q.trim().toLowerCase();
    return users.filter((u) => (!roleFilter || u.role === roleFilter)
      && (!t || `${u.firstName} ${u.lastName} ${u.email} ${roleLabel(u.role)}`.toLowerCase().includes(t)));
  }, [users, q, roleFilter]);

  if (!isSuperAdmin) {
    return (
      <div>
        <PageHeader title="Permissions" subtitle="Access control" />
        <div className="card p-6 flex items-start gap-3">
          <FiAlertCircle className="text-amber-600 mt-0.5 shrink-0" size={18} />
          <div>
            <p className="text-sm font-medium text-gray-900">Super Admins only</p>
            <p className="text-sm text-gray-500 mt-0.5">
              Granting access is the one thing that stays with the accounts that administer the system.
            </p>
          </div>
        </div>
      </div>
    );
  }

  const COLS = 10;

  return (
    <div>
      <PageHeader
        title="Permissions"
        subtitle="Who can reach which module, and what each account may do inside it.">
        <button
          type="button"
          onClick={() => setShowGuide((v) => !v)}
          aria-expanded={showGuide}
          className={`inline-flex items-center gap-1.5 px-3 py-2 text-sm rounded-lg border transition-colors
            ${showGuide ? 'accent-bg text-white border-transparent' : 'border-gray-300 text-gray-700 hover:bg-gray-50'}`}>
          <FiInfo size={15} /> What these grants mean
        </button>
      </PageHeader>

      {error && (
        <div className="mb-4 flex items-start gap-2 text-sm text-red-700 bg-red-50 border border-red-200 px-3 py-2.5 rounded-lg">
          <FiAlertCircle className="mt-0.5 shrink-0" size={16} />
          <span>{error}</span>
        </div>
      )}

      {/* The reference that used to be a paragraph nobody read. Two columns of
          term + meaning, behind a button, so it is available at the moment
          somebody hesitates over a switch and invisible the rest of the time. */}
      {showGuide && (
        <div className="card p-5 mb-5">
          <div className="flex items-start justify-between gap-4 mb-4">
            <div>
              <h2 className="card-title">What these grants mean</h2>
              <p className="text-xs text-gray-500 mt-0.5">
                Every switch here is enforced on the server as well — this page only decides what to ask for.
              </p>
            </div>
            <button type="button" onClick={() => setShowGuide(false)} aria-label="Close"
              className="topbar-icon-btn shrink-0"><FiX size={16} /></button>
          </div>
          <dl className="grid grid-cols-1 lg:grid-cols-2 gap-x-8 gap-y-3.5">
            {[
              ['Company Accounts', GRANT_HELP.cashbook],
              ['Expenses', GRANT_HELP.expenses],
              ['Assets', GRANT_HELP.assets],
              ['Employee Cashbook · Module', GRANT_HELP.khata],
              ['Employee Cashbook · Export', GRANT_HELP.khataExport],
              ['Attendance · WFH', GRANT_HELP.wfh],
              ['Attendance · Anywhere', GRANT_HELP.remotePunch],
              ['CEO / MD edit mode', GRANT_HELP.execEdit],
              ['Manager profiles', GRANT_HELP.managerProfiles],
              ['Capabilities', 'The fine-grained admin list for HR Managers and Managers. An HR Manager with none set keeps full access; a Manager starts with nothing and only sees the admin portal once granted something. Their team duties come from the role and are unaffected.'],
            ].map(([term, meaning]) => (
              <div key={term} className="min-w-0">
                <dt className="text-sm font-medium text-gray-900">{term}</dt>
                <dd className="text-xs text-gray-500 mt-0.5 leading-relaxed">{meaning}</dd>
              </div>
            ))}
          </dl>
        </div>
      )}

      {/* ---------------- Organisation-wide ---------------- */}
      <section className="card mb-5">
        <div className="px-5 pt-4 pb-1">
          <h2 className="card-title">Organisation</h2>
          <p className="text-xs text-gray-500 mt-0.5">
            Settings that apply to everybody, not to one account.
          </p>
        </div>

        <div className="px-5 divide-y divide-gray-100">
          <SettingRow
            title="Chat / Messages"
            description="When off, the chat dock is hidden from every portal and the mobile Chat tab disappears. Existing conversations are kept and come back untouched if you switch it on again."
            checked={org.chatEnabled}
            busy={orgBusy}
            onLabel="Enabled" offLabel="Disabled"
            onChange={() => toggleOrg('chatEnabled', 'Could not update the chat setting')} />

          <SettingRow
            title="CEO / MD approval for cash advances"
            description="When on, an employee's advance request waits for a CEO, MD or Super Admin to approve it before the accounts team can pay it. When off, requests go straight to the accounts team, who still decide which account the money comes out of. Requests already waiting on an executive stay there either way."
            checked={org.khataAdvanceApprovalRequired}
            busy={orgBusy}
            onLabel="Required" offLabel="Not required"
            onChange={() => toggleOrg('khataAdvanceApprovalRequired', 'Could not update the advance-approval setting')} />

          {/* The contact strip on the khata statement PDF. Only a Super Admin
              can change it, because the document goes outside the company. */}
          <div className="py-4">
            <div className="text-sm font-medium text-gray-900">Statement footer</div>
            <p className="text-xs text-gray-500 mt-1 mb-3 max-w-3xl leading-relaxed">
              Printed along the bottom of every cashbook statement PDF, next to the company logo. Leave the number
              blank to print no help line at all — a statement often leaves the building, so &quot;no number&quot;
              is a real choice.
            </p>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 max-w-3xl">
              <div>
                <label className="block text-xs font-medium text-gray-600 mb-1" htmlFor="footer-helpline">
                  Help / contact number
                </label>
                <input id="footer-helpline" value={footer.helpline} maxLength={40} placeholder="+91 96069 98652"
                  onChange={(e) => { setFooter({ ...footer, helpline: e.target.value }); setFooterSaved(false); }}
                  className="w-full border rounded-lg px-3 py-2 text-sm" />
              </div>
              <div>
                <label className="block text-xs font-medium text-gray-600 mb-1" htmlFor="footer-note">
                  Small print (optional)
                </label>
                <input id="footer-note" value={footer.note} maxLength={120}
                  placeholder="Queries on this statement within 7 days of receipt."
                  onChange={(e) => { setFooter({ ...footer, note: e.target.value }); setFooterSaved(false); }}
                  className="w-full border rounded-lg px-3 py-2 text-sm" />
              </div>
            </div>
            <div className="flex items-center gap-3 mt-3">
              <button type="button" onClick={saveFooter} disabled={orgBusy || !footerDirty}
                className="px-3.5 py-2 text-sm rounded-lg accent-bg text-white disabled:opacity-45 disabled:cursor-not-allowed">
                {orgBusy ? 'Saving…' : 'Save footer'}
              </button>
              {footerDirty ? (
                <span className="text-xs text-amber-700">Unsaved changes</span>
              ) : footerSaved ? (
                <span className="inline-flex items-center gap-1 text-xs text-emerald-700">
                  <FiCheck size={13} /> Saved
                </span>
              ) : null}
            </div>
          </div>
        </div>
      </section>

      {/* ---------------- People × grants ---------------- */}
      {/* Toolbar and table share one wrapper on purpose: the global responsive
          rule pins a card's non-table child to the left edge, so the filters
          stay put while a narrow screen scrolls the matrix sideways. */}
      <div className="bg-white shadow rounded-lg overflow-hidden">
        <div className="px-4 py-3.5 border-b border-gray-100 flex flex-wrap items-center gap-3">
          <div className="relative flex-1 min-w-[13rem] max-w-sm">
            <FiSearch className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400 pointer-events-none" size={15} />
            <input value={q} onChange={(e) => setQ(e.target.value)}
              placeholder="Search name, email or role…"
              aria-label="Search accounts"
              className="w-full border rounded-lg pl-9 pr-3 py-2 text-sm" />
          </div>

          <select value={roleFilter} onChange={(e) => setRoleFilter(e.target.value)}
            aria-label="Filter by role"
            className="border rounded-lg px-3 py-2 text-sm text-gray-700">
            <option value="">All roles</option>
            {rolesPresent.map((r) => <option key={r} value={r}>{roleLabel(r)}</option>)}
          </select>

          <span className="text-xs text-gray-500 ml-auto whitespace-nowrap">
            {loading ? 'Loading…'
              : `${filtered.length} of ${users.length} ${users.length === 1 ? 'account' : 'accounts'}`}
          </span>
        </div>

        <table className="min-w-full divide-y divide-gray-200 text-sm">
          <thead className="bg-gray-50">
            <tr>
              <th className="px-4 py-3 text-left font-semibold text-gray-700">Account</th>
              <th className="px-4 py-3 text-left font-semibold text-gray-700">Role</th>
              <th className="px-4 py-3 text-left font-semibold text-gray-700">Company Accounts</th>
              <th className="px-4 py-3 text-left font-semibold text-gray-700">Expenses</th>
              <th className="px-4 py-3 text-left font-semibold text-gray-700">Assets</th>
              <th className="px-4 py-3 text-left font-semibold text-gray-700">Employee Cashbook</th>
              <th className="px-4 py-3 text-left font-semibold text-gray-700">Attendance</th>
              <th className="px-4 py-3 text-left font-semibold text-gray-700">CEO / MD</th>
              <th className="px-4 py-3 text-left font-semibold text-gray-700">Manager profiles</th>
              <th className="px-4 py-3 text-left font-semibold text-gray-700">Capabilities</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100">
            {loading ? (
              [0, 1, 2, 3].map((i) => (
                <tr key={i}>
                  <td className="px-4 py-3.5" colSpan={COLS}>
                    <div className="skeleton h-9 rounded-lg" style={{ width: `${100 - i * 8}%` }} />
                  </td>
                </tr>
              ))
            ) : filtered.length === 0 ? (
              <tr>
                <td colSpan={COLS} className="px-4 py-12 text-center">
                  <p className="text-sm font-medium text-gray-700">No accounts match</p>
                  <p className="text-xs text-gray-500 mt-1">
                    {q || roleFilter ? 'Try a different search or clear the role filter.' : 'No users have been created yet.'}
                  </p>
                </td>
              </tr>
            ) : filtered.map((u) => {
              const id = u._id || u.id;
              // Busy is per SWITCH, not per row: flipping cashbook access used to
              // spin every other switch on the line and fade the whole row, which
              // read as "the account is saving" rather than "this grant is".
              const isBusy = (field) => busyId === `${id}:${field}`;
              const busy = String(busyId || '').startsWith(`${id}:`);
              const isExec = ['CEO', 'MD'].includes(u.role);
              return (
                <tr key={id}>
                  <td className="px-4 py-3">
                    <div className="flex items-center gap-3 min-w-0">
                      <span className="avatar-circle bg-gray-100 text-gray-600" aria-hidden="true">
                        {initials(u)}
                      </span>
                      <div className="min-w-0">
                        <div className="font-medium text-gray-900 truncate">{u.firstName} {u.lastName}</div>
                        <div className="text-xs text-gray-500 truncate">{u.email}</div>
                      </div>
                    </div>
                  </td>

                  <td className="px-4 py-3">
                    <span className={`inline-block px-2 py-0.5 text-xs font-medium rounded-md border whitespace-nowrap
                      ${ROLE_TONES[u.role] || ROLE_TONES.Employee}`}>
                      {roleLabel(u.role)}
                    </span>
                  </td>

                  <td className="px-4 py-3">
                    <ToggleSwitch checked={!!u.cashbookAccess} busy={isBusy('cashbookAccess')} label="Cashbook access"
                      title={GRANT_HELP.cashbook} onChange={() => toggleCashbook(u)} />
                  </td>

                  <td className="px-4 py-3">
                    <ToggleSwitch checked={!!u.expensesAccess} busy={isBusy('expensesAccess')} label="Expenses access"
                      title={GRANT_HELP.expenses} onChange={() => toggleExpenses(u)} />
                  </td>

                  <td className="px-4 py-3">
                    <ToggleSwitch checked={!!u.assetsAccess} busy={isBusy('assetsAccess')} label="Assets access"
                      title={GRANT_HELP.assets} onChange={() => toggleAssets(u)} />
                  </td>

                  {/* Reaching the module and taking its data out are two
                      decisions, so they are two switches — and the second is
                      shown even for roles that already hold the module, since
                      none of them can download without it. */}
                  <td className="px-4 py-3">
                    <div className="flex flex-col gap-2">
                      <GrantRow label="Module" aria="Employee cashbook module access" checked={!!u.khataAccess} busy={isBusy('khataAccess')}
                        title={GRANT_HELP.khata} onChange={() => toggleKhata(u)} />
                      <GrantRow label="Export" aria="Employee cashbook spreadsheet download" checked={!!u.khataExportAccess} busy={isBusy('khataExportAccess')}
                        title={GRANT_HELP.khataExport} onChange={() => toggleKhataExport(u)} />
                    </div>
                  </td>

                  {/* Both attendance flags live on the employee profile, so an
                      account without one (CEO/MD) has nothing to grant. */}
                  <td className="px-4 py-3">
                    {u.hasProfile ? (
                      <div className="flex flex-col gap-2">
                        <GrantRow label="WFH" aria="May mark a punch as work from home" checked={!!u.wfhAllowed} busy={isBusy('wfhAllowed')}
                          title={GRANT_HELP.wfh} onChange={() => toggleWfh(u)} />
                        <GrantRow label="Anywhere" aria="May check in and out from anywhere" checked={!!u.remotePunchAllowed} busy={isBusy('remotePunchAllowed')}
                          title={GRANT_HELP.remotePunch} onChange={() => toggleRemotePunch(u)} />
                      </div>
                    ) : (
                      <NotApplicable hint="No employee profile is linked to this account, so it has no attendance to grant." />
                    )}
                  </td>

                  <td className="px-4 py-3">
                    {isExec ? (
                      <div className="flex flex-col gap-2">
                        <div className="flex items-center gap-2">
                          <ToggleSwitch checked={!!u.execEditAccess} busy={isBusy('execEditAccess')} label="Executive edit mode"
                            title={GRANT_HELP.execEdit} onChange={() => toggleExecEdit(u)} />
                          <span className="text-[11px] leading-tight text-gray-500 whitespace-nowrap">
                            {u.execEditAccess ? 'Edit mode' : 'View only'}
                          </span>
                        </div>
                        <button type="button" onClick={() => openCompanies(u)}
                          title="Limit this executive to certain companies. With none chosen they see every company."
                          className="inline-flex items-center gap-1.5 px-2.5 py-1 text-[11px] rounded-lg border border-gray-300 text-gray-700 hover:bg-gray-50 whitespace-nowrap self-start">
                          <FiHome size={12} />
                          {u.companies && u.companies.length ? `${u.companies.length} compan${u.companies.length === 1 ? 'y' : 'ies'}` : 'All companies'}
                        </button>
                      </div>
                    ) : (
                      <NotApplicable hint="Only a CEO or MD account has a view-only mode to lift." />
                    )}
                  </td>

                  {/* Only the roles that can edit employee profiles at all have
                      anything to grant here — a SuperAdmin already may, and
                      nobody else reaches the employee form. */}
                  <td className="px-4 py-3">
                    {GRANTABLE_ROLES.includes(u.role) ? (
                      <ToggleSwitch checked={!!u.managerProfileAccess} busy={isBusy('managerProfileAccess')} label="May edit Manager profiles"
                        title={GRANT_HELP.managerProfiles} onChange={() => toggleManagerProfiles(u)} />
                    ) : (
                      <NotApplicable hint="Only an HR Manager or Manager account needs this — a Super Admin already edits every profile, and no other role edits any." />
                    )}
                  </td>

                  <td className="px-4 py-3">
                    {GRANTABLE_ROLES.includes(u.role) ? (
                      <button type="button" onClick={() => openPerms(u)}
                        className="inline-flex items-center gap-1.5 px-2.5 py-1.5 text-xs rounded-lg border border-gray-300 text-gray-700 hover:bg-gray-50 whitespace-nowrap">
                        <FiSliders size={13} />
                        {/* A null array means ALL for an HR Manager but NONE for
                            a Manager, so the count has to read the role too. */}
                        {u.permissions == null
                          ? (u.role === 'HRManager' ? 'All' : 'None')
                          : `${capCount(u)} of ${allKeys.length}`}
                      </button>
                    ) : (
                      <NotApplicable hint="Capabilities apply to HR Managers and Managers." />
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {permUser && (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center px-4 z-50">
          <div className="bg-white rounded-xl shadow-lg w-full max-w-3xl max-h-[90vh] flex flex-col">
            <div className="flex items-start justify-between gap-4 px-6 pt-5 pb-4 border-b border-gray-100">
              <div className="flex items-center gap-3 min-w-0">
                <span className="avatar-circle bg-gray-100 text-gray-600" aria-hidden="true">
                  {initials(permUser)}
                </span>
                <div className="min-w-0">
                  <h2 className="card-title truncate">{permUser.firstName} {permUser.lastName}</h2>
                  <p className="text-xs text-gray-500 mt-0.5">
                    {roleLabel(permUser.role)} · choose which admin capabilities this account has
                  </p>
                </div>
              </div>
              <button type="button" onClick={() => setPermUser(null)} aria-label="Close"
                className="topbar-icon-btn shrink-0"><FiX size={16} /></button>
            </div>

            <div className="px-6 py-4 overflow-y-auto">
              {permUser.role === 'Manager' && (
                <p className="text-xs text-gray-500 bg-gray-50 border border-gray-200 rounded-lg px-3 py-2.5 mb-4 leading-relaxed">
                  A Manager sees the admin portal only while they hold at least one capability. Their team duties —
                  approving their own team&apos;s leave — come from the role and are unaffected by anything here.
                </p>
              )}

              <div className="flex flex-wrap items-center gap-2 mb-4">
                <button type="button" onClick={() => setPermSel(new Set(allKeys))}
                  className="text-xs px-3 py-1.5 rounded-lg border border-gray-300 text-gray-700 hover:bg-gray-50">
                  Select all
                </button>
                <button type="button" onClick={() => setPermSel(new Set())}
                  className="text-xs px-3 py-1.5 rounded-lg border border-gray-300 text-gray-700 hover:bg-gray-50">
                  Clear all
                </button>
                <span className="text-xs text-gray-500 ml-auto">
                  <strong className="accent-text">{permSel.size}</strong> of {allKeys.length} granted
                </span>
              </div>

              <div className="space-y-3">
                {Object.entries(permGroups).map(([group, items]) => {
                  const on = items.filter((p) => permSel.has(p.key)).length;
                  const allOn = on === items.length;
                  return (
                    <div key={group} className="border border-gray-200 rounded-lg overflow-hidden">
                      <div className="flex items-center justify-between gap-3 px-3.5 py-2.5 bg-gray-50 border-b border-gray-200">
                        <span className="text-xs font-semibold uppercase tracking-wide text-gray-600">{group}</span>
                        <div className="flex items-center gap-2.5">
                          <span className="text-[11px] text-gray-500">{on}/{items.length}</span>
                          {/* Whole-group flips are the shape a real change
                              usually takes ("give them recruitment"). */}
                          <ToggleSwitch size="sm" checked={allOn} label={`Grant all of ${group}`}
                            title={allOn ? `Clear every ${group} capability` : `Grant every ${group} capability`}
                            onChange={() => toggleGroup(items, !allOn)} />
                        </div>
                      </div>
                      <div className="grid sm:grid-cols-2 gap-x-4 p-2">
                        {items.map((p) => (
                          <label key={p.key}
                            className="flex items-center gap-2.5 text-sm text-gray-700 px-2 py-1.5 rounded-md hover:bg-gray-50 cursor-pointer">
                            <input type="checkbox" checked={permSel.has(p.key)} onChange={() => togglePerm(p.key)}
                              className="rounded border-gray-300" />
                            {p.label}
                          </label>
                        ))}
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>

            {/* The page's error banner sits UNDER this overlay, so a rejected
                save used to look exactly like a save that did nothing. */}
            {error && (
              <div className="mx-6 mb-1 text-sm text-red-700 bg-red-50 border border-red-200 px-3 py-2 rounded-lg">
                {error}
              </div>
            )}
            <div className="flex justify-end gap-2 px-6 py-4 border-t border-gray-100">
              <button type="button" onClick={() => setPermUser(null)}
                className="px-4 py-2 text-sm border border-gray-300 rounded-lg hover:bg-gray-50">Cancel</button>
              {/* Save is dead while the catalogue is missing: with an empty
                  `allKeys` the dialog shows no capabilities, and saving would
                  write an empty list — stripping every capability the account
                  holds, silently. */}
              <button type="button" onClick={savePerms} disabled={permSaving || !allKeys.length}
                className="px-4 py-2 text-sm accent-bg text-white rounded-lg disabled:opacity-45">
                {permSaving ? 'Saving…' : 'Save permissions'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* CEO/MD company access modal */}
      {companyUser && (
        <div className="fixed inset-0 bg-black/40 flex items-start justify-center px-4 z-50 overflow-y-auto py-8"
          onClick={() => setCompanyUser(null)}>
          <div className="bg-white rounded-xl shadow-lg w-full max-w-md" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-start justify-between px-6 py-4 border-b border-gray-100">
              <div>
                <h2 className="card-title">Company access</h2>
                <p className="text-xs text-gray-500 mt-1">
                  {companyUser.firstName} {companyUser.lastName} ({companyUser.role}) sees and manages the ticked companies. Tick none to give access to every company.
                </p>
              </div>
              <button type="button" onClick={() => setCompanyUser(null)} aria-label="Close"
                className="topbar-icon-btn shrink-0">×</button>
            </div>
            <div className="px-6 py-4 max-h-80 overflow-y-auto">
              {companies.length === 0 ? (
                <p className="text-sm text-gray-400">No companies yet. Add one under Companies first.</p>
              ) : (
                <div className="space-y-1">
                  {companies.map((c) => (
                    <label key={c._id}
                      className="flex items-center gap-2.5 text-sm text-gray-700 px-2 py-1.5 rounded-md hover:bg-gray-50 cursor-pointer">
                      <input type="checkbox" checked={companySel.has(String(c._id))} onChange={() => toggleCompany(String(c._id))}
                        className="rounded border-gray-300" />
                      <span>{c.name}{c.code ? <span className="text-gray-400 font-mono text-xs"> · {c.code}</span> : null}</span>
                    </label>
                  ))}
                </div>
              )}
            </div>
            <div className="flex items-center justify-between gap-2 px-6 py-4 border-t border-gray-100">
              <span className="text-xs text-gray-500">{companySel.size === 0 ? 'All companies' : `${companySel.size} selected`}</span>
              <div className="flex gap-2">
                <button type="button" onClick={() => setCompanyUser(null)}
                  className="px-4 py-2 text-sm border border-gray-300 rounded-lg hover:bg-gray-50">Cancel</button>
                <button type="button" onClick={saveCompanies} disabled={companySaving}
                  className="px-4 py-2 text-sm accent-bg text-white rounded-lg disabled:opacity-45">
                  {companySaving ? 'Saving…' : 'Save access'}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
