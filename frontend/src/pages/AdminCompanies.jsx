/**
 * AdminCompanies — the companies (legal entities) the HRMS runs for. Lists them
 * from GET /companies with a headcount, and creates / edits / deletes them via
 * /companies. Employees are tied to a company on their own record (the employee
 * form); a CEO/MD is limited to certain companies on the Permissions page.
 * Deleting a company is blocked while people are still assigned to it.
 *
 * WHO SEES WHAT: an HR Manager reads this page and gets no buttons at all — the
 * headcount per entity is useful to them, changing the entity is not their call.
 * The Backend account and the executives (CEO/MD) manage it. A CEO/MD is allowed
 * here WITHOUT being switched into edit mode, unlike almost everywhere else,
 * because a company is the executive's own domain; routes/companyRoutes.js says
 * the same thing on the server, which is what actually enforces it.
 */
import { useEffect, useState } from 'react';
import { toast } from 'react-toastify';
import api from '../api/client';
import { useAuthStore } from '../store/authStore';
import PageHeader from '../components/PageHeader';
import { confirmDialog } from '../components/dialogs';

const blank = () => ({ name: '', code: '', isActive: true });

// Roles that may change a company. Mirrors MAY_MANAGE in the router.
const MANAGER_ROLES = ['SuperAdmin', 'CEO', 'MD'];

export default function AdminCompanies() {
  const currentUser = useAuthStore((s) => s.user);
  const canManage = MANAGER_ROLES.includes(currentUser?.role);

  // A CEO/MD narrowed to certain companies manages only those. An empty/absent
  // list means unrestricted — the same rule the server applies in
  // assertCompanyScope, mirrored here so a button that would 403 is never shown.
  const myCompanies = (currentUser?.companies || []).map(String);
  const limited = currentUser?.role !== 'SuperAdmin' && myCompanies.length > 0;
  const canEditCompany = (c) => canManage && (!limited || myCompanies.includes(String(c._id)));
  // Adding a company while narrowed would create one the exec cannot then manage.
  const canCreate = canManage && !limited;

  const [companies, setCompanies] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [editing, setEditing] = useState(null);
  const [saving, setSaving] = useState(false);

  const load = async () => {
    setLoading(true);
    setError('');
    try {
      const { data } = await api.get('/companies');
      setCompanies(data.companies);
    } catch (err) {
      setError(err.response?.data?.message || 'Failed to load');
    } finally {
      setLoading(false);
    }
  };
  useEffect(() => { load(); }, []);

  const openCreate = () => setEditing(blank());
  const openEdit = (c) => setEditing({ _id: c._id, name: c.name, code: c.code || '', isActive: c.isActive });

  const save = async (e) => {
    e.preventDefault();
    setSaving(true);
    setError('');
    try {
      const payload = { name: editing.name, code: editing.code, isActive: editing.isActive };
      if (editing._id) await api.put(`/companies/${editing._id}`, payload);
      else await api.post('/companies', payload);
      setEditing(null);
      await load();
    } catch (err) {
      setError(err.response?.data?.message || 'Save failed');
    } finally {
      setSaving(false);
    }
  };

  const remove = async (c) => {
    if (!(await confirmDialog({ message: `Delete company "${c.name}"?`, tone: 'danger', confirmText: 'Delete' }))) return;
    try {
      await api.delete(`/companies/${c._id}`);
      await load();
    } catch (err) {
      toast.error(err.response?.data?.message || 'Delete failed');
    }
  };

  // ----- Who belongs to a company -----
  // The headcount on each card was a dead end: it said "4 employees" with no way
  // to see who, or to change it. This opens the roster behind it.
  const [roster, setRoster] = useState(null); // { company, members, others }
  const [rosterBusy, setRosterBusy] = useState(false);
  const [rosterQ, setRosterQ] = useState('');

  const openRoster = async (c) => {
    setRosterQ('');
    setRoster({ company: c, members: null, others: null }); // opens with a spinner
    try {
      const { data } = await api.get(`/companies/${c._id}/employees`);
      setRoster(data);
    } catch (err) {
      toast.error(err.response?.data?.message || 'Could not load the employee list');
      setRoster(null);
    }
  };

  /** Move one person in or out, then refresh both the roster and the counts. */
  const moveEmployee = async (profileId, into) => {
    if (!roster) return;
    setRosterBusy(true);
    try {
      await api.patch(`/companies/${roster.company._id}/employees`,
        into ? { add: [profileId] } : { remove: [profileId] });
      const { data } = await api.get(`/companies/${roster.company._id}/employees`);
      setRoster(data);
      await load(); // the headcount on the cards behind the modal
    } catch (err) {
      toast.error(err.response?.data?.message || 'Could not update');
    } finally {
      setRosterBusy(false);
    }
  };

  const rosterFilter = (list) => {
    const t = rosterQ.trim().toLowerCase();
    if (!t) return list;
    return list.filter((m) => `${m.name} ${m.employeeCode} ${m.email} ${m.designation} ${m.department}`
      .toLowerCase().includes(t));
  };

  return (
    <div>
      <PageHeader title="Companies" subtitle="The companies this HRMS runs for — employees belong to one, and a CEO/MD can be limited to some">
        {canCreate && (
          <button onClick={openCreate} className="px-4 py-2 bg-gray-900 text-white rounded-lg hover:bg-gray-700 text-sm">+ Add Company</button>
        )}
      </PageHeader>

      {error && <div className="mb-4 text-sm text-red-700 bg-red-50 border border-red-200 px-3 py-2 rounded-lg">{error}</div>}

      {/* Say why the buttons are missing rather than leaving a page that looks
          broken. Two different reasons, so two different sentences. */}
      {!canManage && (
        <div className="mb-4 text-sm text-gray-600 bg-gray-50 border border-gray-200 px-4 py-3 rounded-xl">
          You can see the companies and their headcounts here. Adding, editing and removing a company is done by
          the Backend account or a CEO/MD.
        </div>
      )}
      {canManage && limited && (
        <div className="mb-4 text-sm text-gray-600 bg-gray-50 border border-gray-200 px-4 py-3 rounded-xl">
          Your account is assigned to {myCompanies.length === 1 ? 'one company' : `${myCompanies.length} companies`},
          so you can edit {myCompanies.length === 1 ? 'that one' : 'those'} only. The others are shown for reference.
        </div>
      )}

      {loading ? (
        <p className="text-sm text-gray-500">Loading…</p>
      ) : companies.length === 0 ? (
        <div className="bg-white shadow rounded-lg p-10 text-center text-gray-500">
          No companies yet. Add one, then set it on each employee’s record.
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
          {companies.map((c) => (
            <div key={c._id} className="bg-white shadow rounded-xl p-5 flex flex-col">
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <div className="font-semibold text-gray-900 truncate">{c.name}</div>
                  {c.code && <div className="text-xs text-gray-400 mt-0.5 font-mono">{c.code}</div>}
                </div>
                <span className={`shrink-0 text-xs px-2 py-0.5 rounded-lg ${c.isActive ? 'bg-green-100 text-green-800' : 'bg-gray-200 text-gray-600'}`}>
                  {c.isActive ? 'Active' : 'Inactive'}
                </span>
              </div>

              {/* The headcount is the way in to the roster — it was previously
                  a dead number with no way to see or change who it counted. */}
              <button
                type="button"
                onClick={() => openRoster(c)}
                className="text-sm text-gray-600 mt-3 text-left hover:text-gray-900 hover:underline w-fit"
                title={`See and assign the employees in ${c.name}`}
              >
                👥 {c.assignedCount} employee{c.assignedCount === 1 ? '' : 's'}
              </button>

              <div className="mt-4 pt-3 border-t border-gray-100 flex items-center gap-3 text-sm">
                <button onClick={() => openRoster(c)} className="text-gray-600 hover:underline">
                  {canEditCompany(c) ? 'Employees' : 'View employees'}
                </button>
                {canEditCompany(c) && (
                  <>
                    <button onClick={() => openEdit(c)} className="text-blue-600 hover:underline">Edit</button>
                    <button onClick={() => remove(c)} className="text-red-600 hover:underline ml-auto">Delete</button>
                  </>
                )}
              </div>
            </div>
          ))}
        </div>
      )}

      {/* ---------------- Who belongs to this company ---------------- */}
      {roster && (
        <Modal
          title={`Employees · ${roster.company.name}`}
          onClose={() => setRoster(null)}
          wide
        >
          {roster.members === null ? (
            <p className="text-sm text-gray-500">Loading…</p>
          ) : (
            <>
              <p className="text-xs text-gray-500 -mt-2 mb-3">
                {canEditCompany(roster.company)
                  ? 'An employee belongs to one company. Adding somebody here moves them out of whichever company they are in now.'
                  : 'Read-only — assigning employees to a company is done by the Backend account or a CEO/MD.'}
              </p>

              <input
                value={rosterQ}
                onChange={(e) => setRosterQ(e.target.value)}
                placeholder="Search name, code, designation…"
                className="block w-full border rounded-lg px-3 py-2 text-sm mb-4"
              />

              <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
                <RosterColumn
                  title={`In this company (${roster.members.length})`}
                  people={rosterFilter(roster.members)}
                  empty="Nobody is assigned to this company yet."
                  action={canEditCompany(roster.company)
                    ? { label: 'Remove', tone: 'text-red-600', onClick: (m) => moveEmployee(m._id, false) }
                    : null}
                  busy={rosterBusy}
                />
                <RosterColumn
                  title={`Everyone else (${roster.others.length})`}
                  people={rosterFilter(roster.others)}
                  empty="Everybody is already in this company."
                  showCompany
                  action={canEditCompany(roster.company)
                    ? { label: 'Add', tone: 'text-blue-600', onClick: (m) => moveEmployee(m._id, true) }
                    : null}
                  busy={rosterBusy}
                />
              </div>
            </>
          )}
        </Modal>
      )}

      {editing && (
        <Modal title={editing._id ? 'Edit Company' : 'Add Company'} onClose={() => setEditing(null)}>
          <form onSubmit={save} className="space-y-3">
            <div>
              <label className="block text-xs font-medium text-gray-600 mb-1">Name *</label>
              <input required value={editing.name} onChange={(e) => setEditing({ ...editing, name: e.target.value })}
                placeholder="e.g. Sequence Surfaces LLP" className="block w-full border rounded-lg px-3 py-2" />
            </div>
            <div>
              <label className="block text-xs font-medium text-gray-600 mb-1">Short code</label>
              <input value={editing.code} onChange={(e) => setEditing({ ...editing, code: e.target.value })}
                placeholder="e.g. SSL" className="block w-full border rounded-lg px-3 py-2 uppercase" />
            </div>
            <label className="flex items-center gap-2 text-sm text-gray-700">
              <input type="checkbox" checked={editing.isActive} onChange={(e) => setEditing({ ...editing, isActive: e.target.checked })} />
              Active
            </label>
            <div className="flex justify-end gap-2 pt-2">
              <button type="button" onClick={() => setEditing(null)} className="px-4 py-2 text-sm border rounded-lg hover:bg-gray-50">Cancel</button>
              <button type="submit" disabled={saving} className="px-4 py-2 text-sm bg-gray-900 text-white rounded-lg hover:bg-gray-700 disabled:opacity-60">{saving ? 'Saving…' : 'Save'}</button>
            </div>
          </form>
        </Modal>
      )}
    </div>
  );
}

/**
 * One side of the roster: the people in this company, or everyone else.
 *
 * Two columns rather than a checkbox list, because the question being answered
 * is "who is in and who is out", and a single list with ticks makes you hold
 * that distinction in your head instead of showing it.
 */
function RosterColumn({ title, people, empty, action, busy, showCompany }) {
  return (
    <div>
      <h3 className="text-xs font-semibold uppercase tracking-wide text-gray-500 mb-2">{title}</h3>
      <div className="border border-gray-200 rounded-xl divide-y divide-gray-100 max-h-80 overflow-y-auto">
        {people.length === 0 ? (
          <p className="text-sm text-gray-400 px-3 py-6 text-center">{empty}</p>
        ) : people.map((m) => (
          <div key={m._id} className="flex items-center gap-3 px-3 py-2.5">
            <div className="min-w-0 flex-1">
              <div className="text-sm font-medium text-gray-900 truncate">
                {m.name}
                {!m.isActive && <span className="ml-2 text-[11px] text-gray-400">inactive</span>}
              </div>
              <div className="text-xs text-gray-500 truncate">
                {[m.employeeCode, m.designation, m.department].filter(Boolean).join(' · ') || m.email}
              </div>
              {/* Where they are NOW, so adding them reads as a move. */}
              {showCompany && (
                <div className="text-[11px] text-gray-400 truncate mt-0.5">
                  {m.companyName ? `Currently in ${m.companyName}` : 'No company'}
                </div>
              )}
            </div>
            {action && (
              <button
                type="button"
                disabled={busy}
                onClick={() => action.onClick(m)}
                className={`text-xs ${action.tone} hover:underline disabled:opacity-40 shrink-0`}
              >
                {action.label}
              </button>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

function Modal({ title, onClose, children, wide }) {
  return (
    <div className="fixed inset-0 bg-black/40 flex items-start justify-center px-4 z-50 overflow-y-auto py-8">
      <div className={`bg-white rounded-xl shadow-lg w-full ${wide ? 'max-w-3xl' : 'max-w-lg'} p-6`}>
        <div className="flex items-center justify-between mb-4">
          <h2 className="card-title">{title}</h2>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-700 text-xl leading-none">×</button>
        </div>
        {children}
      </div>
    </div>
  );
}
