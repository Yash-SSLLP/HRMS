/**
 * The form a task is created and edited with (section 3).
 *
 * The spec asks for thirty-odd fields on one form, which is a form nobody fills
 * in. So it is arranged as one short REQUIRED section and four collapsed
 * sections underneath it: most tasks are a title, a person and a date, and the
 * requirements, location, workflow and incentive are there for the ones that
 * need them, folded away for the ones that do not.
 *
 * THE INCENTIVE IS SET HERE, BY THE MANAGER ASSIGNING THE TASK, and it is in
 * POINTS. That is not a simplification of the spec's rupee figures — this
 * portal pays every incentive in one company-wide points pool valued by a single
 * rate, so points are the only unit that reaches the dashboards, the
 * leaderboards and the payouts that already exist. The preview under the field
 * shows what each outcome would actually pay, so ₹-shaped thinking still has an
 * answer: set 500 points and the ladder is 500 / 400 / 200 / 0.
 */
import { useEffect, useMemo, useState } from 'react';
import { FiChevronDown, FiChevronRight, FiPlus, FiX, FiAward, FiMapPin, FiCheckSquare, FiGitBranch } from 'react-icons/fi';
import SearchableSelect from '../SearchableSelect';
import { peopleOptions, hasLeft } from '../../utils/peopleOptions';
import { ASSIGNEE_ROLES, TASK_PRIORITY, INCENTIVE_OUTCOME_LABELS } from '../../utils/taskLifecycle';

const EVERYONE = '__all__';

const blank = {
  title: '', description: '', taskType: 'General', category: '', department: '',
  project: '', priority: 'Medium', startDate: '', dueDate: '', estimatedMinutes: '',
  supervisor: '', manager: '', tags: '',
  requiresApproval: false,
  requirements: { remarks: false, checklist: false, attachment: false, photo: false, location: false, signature: false, minPhotos: 0, minAttachments: 0, note: '' },
  location: { captureOn: [], enforceOn: [], workLocation: '', radiusM: '' },
  incentive: { enabled: false, points: 0, distribution: 'share' },
  workflow: '',
  checklist: [],
};

/** A collapsible block. Open when it already has something in it. */
function Section({ title, icon: Icon, summary, children, defaultOpen = false }) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className="border border-gray-200 rounded-lg">
      <button type="button" onClick={() => setOpen((o) => !o)}
        className="w-full flex items-center gap-2 px-3 py-2.5 text-left" style={{ minHeight: 40 }}>
        {open ? <FiChevronDown size={14} className="text-gray-400" /> : <FiChevronRight size={14} className="text-gray-400" />}
        {Icon && <Icon size={14} className="text-gray-400" />}
        <span className="text-sm font-medium text-gray-700">{title}</span>
        {summary && <span className="ml-auto text-xs text-gray-400 truncate max-w-[45%]">{summary}</span>}
      </button>
      {open && <div className="px-3 pb-3 pt-1 space-y-3 border-t border-gray-100">{children}</div>}
    </div>
  );
}

/** A labelled switch. Reuses the portal's checkbox look rather than inventing one. */
function Toggle({ checked, onChange, label, hint }) {
  return (
    <label className="flex items-start gap-2 cursor-pointer" style={{ minHeight: 28 }}>
      <input type="checkbox" checked={!!checked} onChange={(e) => onChange(e.target.checked)}
        className="mt-0.5 h-4 w-4 rounded border-gray-300" />
      <span>
        <span className="text-sm text-gray-700">{label}</span>
        {hint && <span className="block text-xs text-gray-400">{hint}</span>}
      </span>
    </label>
  );
}

/**
 * @param {object} props
 * @param {object|null} props.task - editing an existing one, or null to create
 * @param {object} props.meta - GET /tasks/meta
 * @param {Array} props.users
 * @param {Array} props.projects
 * @param {Array} props.workLocations
 * @param {(payload:object) => Promise<void>} props.onSave
 * @param {() => void} props.onClose
 */
export default function TaskFormModal({
  task, meta = {}, users = [], projects = [], workLocations = [], onSave, onClose,
}) {
  const editing = !!task;
  const [form, setForm] = useState(blank);
  const [assignees, setAssignees] = useState([]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [newItem, setNewItem] = useState('');

  useEffect(() => {
    if (!task) { setForm(blank); setAssignees([]); return; }
    const plain = (v, d) => ({ ...d, ...(v || {}) });
    setForm({
      ...blank,
      title: task.title || '',
      description: task.description || '',
      taskType: task.taskType || 'General',
      category: task.category || '',
      department: task.department || '',
      project: task.project?._id || task.project || '',
      priority: task.priority || 'Medium',
      startDate: task.startDate ? String(task.startDate).slice(0, 10) : '',
      dueDate: task.dueDate ? String(task.dueDate).slice(0, 16) : '',
      estimatedMinutes: task.estimatedMinutes || '',
      supervisor: task.supervisor?._id || task.supervisor || '',
      manager: task.manager?._id || task.manager || '',
      tags: (task.tags || []).join(', '),
      requiresApproval: !!task.requiresApproval,
      requirements: plain(task.requirements, blank.requirements),
      location: {
        ...blank.location,
        ...(task.location || {}),
        workLocation: task.location?.workLocation || '',
        radiusM: task.location?.radiusM || '',
      },
      incentive: plain(task.incentive, blank.incentive),
      workflow: task.workflowRef || '',
      checklist: (task.checklist || []).map((c) => ({ text: c.text, mandatory: c.mandatory !== false, _id: c._id })),
    });
    setAssignees((task.assignees || []).map((a) => ({
      user: String(a.user?._id || a.user),
      role: a.role || 'Contributor',
      responsibility: a.responsibility || '',
    })));
  }, [task]);

  const assignableCount = useMemo(() => users.filter((u) => !hasLeft(u)).length, [users]);

  const set = (patch) => setForm((f) => ({ ...f, ...patch }));
  const setIn = (key, patch) => setForm((f) => ({ ...f, [key]: { ...f[key], ...patch } }));

  const addAssignee = (userId) => {
    if (!userId) return;
    if (userId === EVERYONE) { setAssignees([{ user: EVERYONE, role: 'Owner' }]); return; }
    setAssignees((list) => (
      list.some((a) => a.user === userId)
        ? list
        : [...list.filter((a) => a.user !== EVERYONE), { user: userId, role: list.length ? 'Contributor' : 'Owner', responsibility: '' }]
    ));
  };
  const patchAssignee = (userId, patch) => setAssignees((list) => list.map((a) => {
    if (a.user !== userId) return a;
    // Exactly one Owner: promoting somebody demotes whoever held it.
    return { ...a, ...patch };
  }).map((a, _i, all) => (
    patch.role === 'Owner' && a.user !== userId && a.role === 'Owner' ? { ...a, role: 'Contributor' } : a
  )));
  const dropAssignee = (userId) => setAssignees((list) => list.filter((a) => a.user !== userId));

  const everyone = !editing && assignees.some((a) => a.user === EVERYONE);

  // What the incentive would actually pay, worked out the same way the server
  // works it out. Shown rather than described, because "20 points shared four
  // ways, on time" is not a sum anybody should have to do in their head.
  const incentivePreview = useMemo(() => {
    const cfg = form.incentive;
    if (!cfg.enabled || !(cfg.points > 0)) return [];
    const split = meta.defaultSplit || { early: 1, onTime: 0.8, late: 0.4, veryLate: 0, rejectedFirst: 0.5 };
    const people = everyone ? 1 : Math.max(1, assignees.length);
    const shares = cfg.distribution === 'each' ? 1 : people;
    return Object.entries(split).map(([outcome, mult]) => ({
      outcome,
      label: INCENTIVE_OUTCOME_LABELS[outcome] || outcome,
      points: Math.round(((Number(cfg.points) || 0) * mult / shares) * 100) / 100,
    }));
  }, [form.incentive, assignees.length, everyone, meta.defaultSplit]);

  const submit = async (e) => {
    e.preventDefault();
    setError('');
    if (!form.title.trim()) { setError('A task needs a title.'); return; }
    setSaving(true);
    try {
      const payload = {
        ...form,
        project: form.project || undefined,
        supervisor: form.supervisor || undefined,
        manager: form.manager || undefined,
        estimatedMinutes: form.estimatedMinutes ? Number(form.estimatedMinutes) : undefined,
        startDate: form.startDate || undefined,
        dueDate: form.dueDate || undefined,
        tags: form.tags ? form.tags.split(',').map((t) => t.trim()).filter(Boolean) : [],
        location: {
          ...form.location,
          workLocation: form.location.workLocation || undefined,
          radiusM: form.location.radiusM ? Number(form.location.radiusM) : undefined,
        },
        incentive: {
          ...form.incentive,
          points: Number(form.incentive.points) || 0,
        },
        workflow: form.workflow || undefined,
        checklist: form.checklist,
      };
      if (everyone) {
        payload.assignToAll = true;
        delete payload.assignees;
      } else {
        payload.assignees = assignees.map((a) => ({
          user: a.user, role: a.role, responsibility: a.responsibility || undefined,
        }));
      }
      // A workflow is chosen once, when the task starts. Re-sending it on an
      // edit would be asking to restart the route a task is halfway through.
      if (editing) delete payload.workflow;
      await onSave(payload);
    } catch (err) {
      setError(err.response?.data?.message || err.message || 'Save failed');
    } finally {
      setSaving(false);
    }
  };

  const userOptions = useMemo(
    () => peopleOptions(users, (u) => `${u.firstName} ${u.lastName}`, { keep: assignees.map((a) => a.user) }),
    [users, assignees]
  );
  const nameOf = (id) => {
    const u = users.find((x) => String(x._id) === String(id));
    return u ? `${u.firstName} ${u.lastName}` : 'Somebody';
  };

  return (
    <div className="fixed inset-0 bg-black/40 flex items-start justify-center px-4 z-50 overflow-y-auto py-8">
      <div className="bg-white rounded-xl shadow-lg w-full max-w-2xl p-6">
        <div className="flex items-center justify-between mb-4">
          <h2 className="card-title">{editing ? `Edit ${task.code || 'task'}` : 'New task'}</h2>
          <button type="button" onClick={onClose} className="text-gray-400 hover:text-gray-600" aria-label="Close">
            <FiX size={18} />
          </button>
        </div>

        <form onSubmit={submit} className="space-y-4">
          {/* ===== the short required part ===== */}
          <div>
            <label className="block text-sm text-gray-700">Title *</label>
            <input required value={form.title} onChange={(e) => set({ title: e.target.value })}
              className="mt-1 block w-full border rounded-lg px-3 py-2" placeholder="What needs doing?" />
          </div>

          <div>
            <label className="block text-sm text-gray-700">Description</label>
            <textarea rows={3} value={form.description} onChange={(e) => set({ description: e.target.value })}
              className="mt-1 block w-full border rounded-lg px-3 py-2" />
          </div>

          {/* ===== who ===== */}
          <div>
            <label className="block text-sm text-gray-700">Assigned to</label>
            <SearchableSelect value="" onChange={(e) => addAssignee(e.target.value)}
              className="mt-1 block w-full border rounded-lg px-3 py-2">
              <option value="">Add somebody…</option>
              {!editing && assignableCount > 0 && <option value={EVERYONE}>All employees ({assignableCount})</option>}
              {userOptions}
            </SearchableSelect>

            {everyone && (
              <p className="mt-2 text-xs text-amber-600">
                Each of the {assignableCount} gets their OWN copy to complete — {assignableCount} rows on the list.
                A task is something one person marks done, so a shared row would be done by whoever got there first.
              </p>
            )}

            {!everyone && assignees.length > 0 && (
              <div className="mt-2 space-y-2">
                {assignees.map((a) => (
                  <div key={a.user} className="flex flex-wrap items-center gap-2 border border-gray-200 rounded-lg p-2">
                    <span className="text-sm text-gray-800 flex-1 min-w-[120px]">{nameOf(a.user)}</span>
                    <select value={a.role} onChange={(e) => patchAssignee(a.user, { role: e.target.value })}
                      className="border rounded-lg px-2 py-1 text-xs" style={{ minHeight: 32 }}>
                      {ASSIGNEE_ROLES.map((r) => <option key={r} value={r}>{r}</option>)}
                    </select>
                    <input value={a.responsibility}
                      onChange={(e) => patchAssignee(a.user, { responsibility: e.target.value })}
                      placeholder="Their part — e.g. Venue"
                      className="border rounded-lg px-2 py-1 text-xs flex-1 min-w-[140px]" style={{ minHeight: 32 }} />
                    <button type="button" onClick={() => dropAssignee(a.user)}
                      className="text-gray-400 hover:text-red-600 px-1" aria-label="Remove">
                      <FiX size={14} />
                    </button>
                  </div>
                ))}
                {assignees.length > 1 && (
                  <p className="text-xs text-gray-400">
                    One task, several people — each with their own part, deadline and submission.
                    The Owner is the primary assignee.
                  </p>
                )}
              </div>
            )}
          </div>

          {/* ===== when ===== */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <label className="block text-sm text-gray-700">Start</label>
              <input type="date" value={form.startDate} onChange={(e) => set({ startDate: e.target.value })}
                className="mt-1 block w-full border rounded-lg px-3 py-2" />
            </div>
            <div>
              <label className="block text-sm text-gray-700">Due</label>
              <input type="datetime-local" value={form.dueDate} onChange={(e) => set({ dueDate: e.target.value })}
                className="mt-1 block w-full border rounded-lg px-3 py-2" />
            </div>
            <div>
              <label className="block text-sm text-gray-700">Priority</label>
              <select value={form.priority} onChange={(e) => set({ priority: e.target.value })}
                className="mt-1 block w-full border rounded-lg px-3 py-2">
                {TASK_PRIORITY.map((p) => <option key={p}>{p}</option>)}
              </select>
            </div>
            <div>
              <label className="block text-sm text-gray-700">Estimated (minutes)</label>
              <input type="number" min="0" value={form.estimatedMinutes}
                onChange={(e) => set({ estimatedMinutes: e.target.value })}
                className="mt-1 block w-full border rounded-lg px-3 py-2" />
            </div>
          </div>

          {/* ===== the folded-away sections ===== */}

          <Section title="Classification & people" icon={FiPlus}
            summary={[form.taskType, form.department].filter(Boolean).join(' · ')}>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div>
                <label className="block text-sm text-gray-700">Type</label>
                <input list="task-types" value={form.taskType} onChange={(e) => set({ taskType: e.target.value })}
                  className="mt-1 block w-full border rounded-lg px-3 py-2" />
                <datalist id="task-types">
                  {(meta.taskTypes || []).map((t) => <option key={t} value={t} />)}
                </datalist>
              </div>
              <div>
                <label className="block text-sm text-gray-700">Category</label>
                <input value={form.category} onChange={(e) => set({ category: e.target.value })}
                  className="mt-1 block w-full border rounded-lg px-3 py-2" />
              </div>
              <div>
                <label className="block text-sm text-gray-700">Project</label>
                <SearchableSelect value={form.project} onChange={(e) => set({ project: e.target.value })}
                  className="mt-1 block w-full border rounded-lg px-3 py-2">
                  <option value="">—</option>
                  {projects.map((p) => <option key={p._id} value={p._id}>{p.name}</option>)}
                </SearchableSelect>
              </div>
              <div>
                <label className="block text-sm text-gray-700">Department</label>
                <input value={form.department} onChange={(e) => set({ department: e.target.value })}
                  className="mt-1 block w-full border rounded-lg px-3 py-2" />
              </div>
              <div>
                <label className="block text-sm text-gray-700">Supervisor</label>
                <SearchableSelect value={form.supervisor} onChange={(e) => set({ supervisor: e.target.value })}
                  className="mt-1 block w-full border rounded-lg px-3 py-2">
                  <option value="">You, by default</option>
                  {userOptions}
                </SearchableSelect>
              </div>
              <div>
                <label className="block text-sm text-gray-700">Manager (escalates to)</label>
                <SearchableSelect value={form.manager} onChange={(e) => set({ manager: e.target.value })}
                  className="mt-1 block w-full border rounded-lg px-3 py-2">
                  <option value="">—</option>
                  {userOptions}
                </SearchableSelect>
              </div>
              <div className="sm:col-span-2">
                <label className="block text-sm text-gray-700">Tags</label>
                <input value={form.tags} onChange={(e) => set({ tags: e.target.value })}
                  placeholder="comma, separated"
                  className="mt-1 block w-full border rounded-lg px-3 py-2" />
              </div>
            </div>
          </Section>

          <Section title="Checklist" icon={FiCheckSquare}
            summary={form.checklist.length ? `${form.checklist.length} item${form.checklist.length === 1 ? '' : 's'}` : ''}
            defaultOpen={form.checklist.length > 0}>
            {form.checklist.map((item, i) => (
              <div key={i} className="flex items-center gap-2">
                <input value={item.text}
                  onChange={(e) => set({ checklist: form.checklist.map((c, j) => (j === i ? { ...c, text: e.target.value } : c)) })}
                  className="flex-1 border rounded-lg px-3 py-1.5 text-sm" style={{ minHeight: 36 }} />
                <label className="text-xs text-gray-500 flex items-center gap-1 whitespace-nowrap">
                  <input type="checkbox" checked={item.mandatory !== false}
                    onChange={(e) => set({ checklist: form.checklist.map((c, j) => (j === i ? { ...c, mandatory: e.target.checked } : c)) })}
                    className="h-3.5 w-3.5 rounded border-gray-300" />
                  must
                </label>
                <button type="button" onClick={() => set({ checklist: form.checklist.filter((_, j) => j !== i) })}
                  className="text-gray-400 hover:text-red-600" aria-label="Remove">
                  <FiX size={14} />
                </button>
              </div>
            ))}
            <div className="flex gap-2">
              <input value={newItem} onChange={(e) => setNewItem(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key !== 'Enter') return;
                  e.preventDefault();
                  if (!newItem.trim()) return;
                  set({ checklist: [...form.checklist, { text: newItem.trim(), mandatory: true }] });
                  setNewItem('');
                }}
                placeholder="Add an item and press Enter"
                className="flex-1 border rounded-lg px-3 py-1.5 text-sm" style={{ minHeight: 36 }} />
              <button type="button"
                onClick={() => { if (newItem.trim()) { set({ checklist: [...form.checklist, { text: newItem.trim(), mandatory: true }] }); setNewItem(''); } }}
                className="px-3 py-1.5 text-sm border rounded-lg hover:bg-gray-50" style={{ minHeight: 36 }}>
                Add
              </button>
            </div>
          </Section>

          <Section title="What submission must carry" icon={FiCheckSquare}
            summary={Object.entries(form.requirements).filter(([k, v]) => v === true).map(([k]) => k).join(', ')}>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-4 gap-y-1">
              <Toggle label="Remarks" checked={form.requirements.remarks}
                onChange={(v) => setIn('requirements', { remarks: v })} />
              <Toggle label="Checklist completed" checked={form.requirements.checklist}
                onChange={(v) => setIn('requirements', { checklist: v })} />
              <Toggle label="Attachment" checked={form.requirements.attachment}
                onChange={(v) => setIn('requirements', { attachment: v })} />
              <Toggle label="Photo" checked={form.requirements.photo}
                onChange={(v) => setIn('requirements', { photo: v })} />
              <Toggle label="Location" checked={form.requirements.location}
                onChange={(v) => setIn('requirements', { location: v })} />
              <Toggle label="Signature" checked={form.requirements.signature}
                onChange={(v) => setIn('requirements', { signature: v })} />
            </div>
            {(form.requirements.photo || form.requirements.attachment) && (
              <div className="grid grid-cols-2 gap-3">
                {form.requirements.photo && (
                  <div>
                    <label className="block text-xs text-gray-500">How many photos</label>
                    <input type="number" min="1" value={form.requirements.minPhotos || 1}
                      onChange={(e) => setIn('requirements', { minPhotos: Number(e.target.value) })}
                      className="mt-1 block w-full border rounded-lg px-3 py-1.5 text-sm" style={{ minHeight: 36 }} />
                  </div>
                )}
                {form.requirements.attachment && (
                  <div>
                    <label className="block text-xs text-gray-500">How many attachments</label>
                    <input type="number" min="1" value={form.requirements.minAttachments || 1}
                      onChange={(e) => setIn('requirements', { minAttachments: Number(e.target.value) })}
                      className="mt-1 block w-full border rounded-lg px-3 py-1.5 text-sm" style={{ minHeight: 36 }} />
                  </div>
                )}
              </div>
            )}
            <div>
              <label className="block text-xs text-gray-500">What good evidence looks like</label>
              <input value={form.requirements.note} onChange={(e) => setIn('requirements', { note: e.target.value })}
                placeholder="Shown on the submission form"
                className="mt-1 block w-full border rounded-lg px-3 py-1.5 text-sm" style={{ minHeight: 36 }} />
            </div>
            <Toggle label="Needs somebody's approval to finish"
              hint="Off means completing the task is the assignee's own call."
              checked={form.requiresApproval} onChange={(v) => set({ requiresApproval: v })} />
          </Section>

          <Section title="Location & geofence" icon={FiMapPin}
            summary={(form.location.enforceOn || []).length ? `must be on site to ${form.location.enforceOn.join(', ')}` : ''}>
            <div>
              <div className="text-xs text-gray-500 mb-1">Record where the person is when they…</div>
              <div className="flex flex-wrap gap-3">
                {(meta.locationEvents || ['accept', 'start', 'submit', 'approve', 'complete']).map((ev) => (
                  <label key={ev} className="flex items-center gap-1.5 text-sm text-gray-700" style={{ minHeight: 28 }}>
                    <input type="checkbox" className="h-4 w-4 rounded border-gray-300"
                      checked={(form.location.captureOn || []).includes(ev)}
                      onChange={(e) => setIn('location', {
                        captureOn: e.target.checked
                          ? [...(form.location.captureOn || []), ev]
                          : (form.location.captureOn || []).filter((x) => x !== ev),
                      })} />
                    {ev}
                  </label>
                ))}
              </div>
            </div>
            <div>
              <div className="text-xs text-gray-500 mb-1">And REFUSE it unless they are inside the fence when they…</div>
              <div className="flex flex-wrap gap-3">
                {(meta.geofenceRules || ['start', 'submit', 'complete']).map((ev) => (
                  <label key={ev} className="flex items-center gap-1.5 text-sm text-gray-700" style={{ minHeight: 28 }}>
                    <input type="checkbox" className="h-4 w-4 rounded border-gray-300"
                      checked={(form.location.enforceOn || []).includes(ev)}
                      onChange={(e) => setIn('location', {
                        enforceOn: e.target.checked
                          ? [...(form.location.enforceOn || []), ev]
                          : (form.location.enforceOn || []).filter((x) => x !== ev),
                      })} />
                    {ev}
                  </label>
                ))}
              </div>
            </div>
            {(form.location.enforceOn || []).length > 0 && (
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs text-gray-500">Which site</label>
                  <SearchableSelect value={form.location.workLocation}
                    onChange={(e) => setIn('location', { workLocation: e.target.value })}
                    className="mt-1 block w-full border rounded-lg px-3 py-1.5 text-sm">
                    <option value="">The person's own assigned site</option>
                    {workLocations.map((w) => <option key={w._id} value={w._id}>{w.name}</option>)}
                  </SearchableSelect>
                </div>
                <div>
                  <label className="block text-xs text-gray-500">Radius (m) — blank uses the site's own</label>
                  <input type="number" min="0" value={form.location.radiusM}
                    onChange={(e) => setIn('location', { radiusM: e.target.value })}
                    className="mt-1 block w-full border rounded-lg px-3 py-1.5 text-sm" style={{ minHeight: 36 }} />
                </div>
              </div>
            )}
          </Section>

          {!editing && (meta.workflows || []).length > 0 && (
            <Section title="Route it through a workflow" icon={FiGitBranch}
              summary={(meta.workflows.find((w) => w._id === form.workflow) || {}).name || ''}>
              <SearchableSelect value={form.workflow} onChange={(e) => set({ workflow: e.target.value })}
                className="block w-full border rounded-lg px-3 py-2">
                <option value="">No workflow — the supervisor approves it</option>
                {meta.workflows.map((w) => (
                  <option key={w._id} value={w._id}>{w.name} (v{w.activeVersion})</option>
                ))}
              </SearchableSelect>
              <p className="text-xs text-gray-400">
                The workflow&apos;s steps are copied onto the task when it starts, so editing the
                workflow later never changes a task already running on it.
              </p>
            </Section>
          )}

          <Section title="Incentive" icon={FiAward}
            summary={form.incentive.enabled && form.incentive.points > 0 ? `${form.incentive.points} points` : ''}
            defaultOpen={form.incentive.enabled}>
            <Toggle label="This task earns incentive points"
              hint="Points join the same company-wide pool as every other incentive, once sanctioned."
              checked={form.incentive.enabled} onChange={(v) => setIn('incentive', { enabled: v })} />
            {form.incentive.enabled && (
              <>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  <div>
                    <label className="block text-xs text-gray-500">Points the task is worth</label>
                    <input type="number" min="0" step="0.5" value={form.incentive.points}
                      onChange={(e) => setIn('incentive', { points: e.target.value })}
                      className="mt-1 block w-full border rounded-lg px-3 py-1.5 text-sm" style={{ minHeight: 36 }} />
                  </div>
                  <div>
                    <label className="block text-xs text-gray-500">With several people on it</label>
                    <select value={form.incentive.distribution}
                      onChange={(e) => setIn('incentive', { distribution: e.target.value })}
                      className="mt-1 block w-full border rounded-lg px-3 py-1.5 text-sm" style={{ minHeight: 36 }}>
                      <option value="share">Split the points between them</option>
                      <option value="each">Each earns the full figure</option>
                    </select>
                  </div>
                </div>
                {incentivePreview.length > 0 && (
                  <div className="rounded-lg bg-gray-50 border border-gray-100 p-2">
                    <div className="text-xs text-gray-500 mb-1">
                      What each person would earn{assignees.length > 1 && form.incentive.distribution === 'share'
                        ? ` (split ${assignees.length} ways)` : ''}:
                    </div>
                    <div className="grid grid-cols-2 sm:grid-cols-3 gap-x-4 gap-y-0.5">
                      {incentivePreview.map((r) => (
                        <div key={r.outcome} className="flex justify-between text-xs">
                          <span className="text-gray-600 truncate">{r.label}</span>
                          <span className="tabular-nums text-gray-900 ml-2">{r.points}</span>
                        </div>
                      ))}
                    </div>
                    <div className="text-[11px] text-gray-400 mt-1">
                      Nothing is credited until it is approved after the task is done.
                    </div>
                  </div>
                )}
              </>
            )}
          </Section>

          {error && (
            <div className="text-sm text-red-700 bg-red-50 border border-red-200 px-3 py-2 rounded-lg">{error}</div>
          )}

          <div className="flex justify-end gap-2 pt-1">
            <button type="button" onClick={onClose}
              className="px-4 py-2 text-sm border rounded-lg hover:bg-gray-50" style={{ minHeight: 40 }}>
              Cancel
            </button>
            <button type="submit" disabled={saving}
              className="px-4 py-2 text-sm bg-gray-900 text-white rounded-lg hover:bg-gray-700 disabled:opacity-60"
              style={{ minHeight: 40 }}>
              {saving ? 'Saving…' : editing ? 'Save' : 'Create task'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
