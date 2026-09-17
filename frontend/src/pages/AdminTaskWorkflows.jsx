/**
 * Task workflows, templates and recurring schedules (sections 7, 23, 24).
 *
 * THE BUILDER IS A LIST, NOT A CANVAS, and that is a decision rather than a
 * shortcut. Everything a task workflow actually needs — an ordered set of steps,
 * some of which run at the same time, one of which may branch — is expressible
 * as a list with a "runs alongside the one above" switch, and a list is
 * something that works on a phone, is readable by a screen reader, needs no new
 * dependency, and can be described in words to somebody over the phone. The
 * picture is still drawn, read-only, by the same rail the task detail page uses,
 * so what you built is what you see.
 *
 * WHAT THE PAGE IS REALLY FOR is the two checks either side of Publish:
 *   - SIMULATE answers "who would actually be asked?" by running the SAME
 *     resolver the live engine runs. A step addressed to a role nobody holds, or
 *     to a reporting manager who has left, is a task that silently runs past an
 *     approval — and this is where that is discovered, not in production.
 *   - PUBLISH refuses a workflow that would strand a task: a branch pointing at
 *     a step that does not exist, an approval nobody can be resolved to, a
 *     parallel group whose members disagree about how it finishes.
 *
 * Publishing snapshots the draft as an immutable version. Tasks already running
 * carry their own copy of the steps and are never touched — which the page says
 * out loud, because it is the promise that makes editing a live workflow safe.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { toast } from 'react-toastify';
import {
  FiPlus, FiTrash2, FiChevronUp, FiChevronDown, FiPlay, FiUploadCloud,
  FiGitBranch, FiCopy, FiRepeat, FiAlertTriangle, FiCheck, FiX, FiEye,
} from 'react-icons/fi';
import PageHeader from '../components/PageHeader';
import { confirmDialog, promptDialog } from '../components/dialogs';
import SearchableSelect from '../components/SearchableSelect';
import WorkflowRail from '../components/task/WorkflowRail';
import useViewOnly from '../hooks/useViewOnly';
import { useTabParam } from '../hooks/useTabParam';
import api from '../api/client';
import * as T from '../api/tasks';

const TABS = [
  ['workflows', 'Workflows'],
  ['templates', 'Templates'],
  ['recurring', 'Recurring'],
];

const NODE_TYPES = [
  ['approval', 'Approval — somebody says yes or no'],
  ['review', 'Review — somebody looks and comments'],
  ['assignment', 'Assignment — somebody does the work'],
  ['notify', 'Notify — tell somebody and carry on'],
  ['wait', 'Wait — hold for a while'],
  ['condition', 'Condition — branch on a field'],
];

const ACTOR_KINDS = [
  ['user', 'Named people'],
  ['role', 'Everyone with a role'],
  ['permission', 'Everyone with a capability'],
  ['supervisor', "The task's supervisor"],
  ['manager', "The task's manager"],
  ['reportingManager', "The assignee's reporting manager"],
  ['hrPartner', "The assignee's HR partner"],
  ['creator', 'Whoever set the task'],
  ['department', "A department's task managers"],
];

const OPERATORS = [
  ['eq', 'is'], ['ne', 'is not'], ['gt', 'is more than'], ['gte', 'is at least'],
  ['lt', 'is less than'], ['lte', 'is at most'], ['in', 'is one of'],
  ['contains', 'contains'], ['empty', 'is empty'], ['notEmpty', 'is not empty'],
];

const FREQUENCIES = [
  ['daily', 'Daily'], ['weekly', 'Weekly'], ['monthly', 'Monthly'],
  ['quarterly', 'Quarterly'], ['yearly', 'Yearly'], ['custom', 'Named days'],
];

const blankStep = (n) => ({
  key: '',
  name: `Step ${n}`,
  type: 'approval',
  assigneeRule: { kind: 'supervisor', users: [], roles: [], quorum: 'any' },
  parallelGroup: null,
  join: 'all',
  optional: false,
  slaHours: '',
  onReject: 'sendBack',
  requireNote: false,
});

export default function AdminTaskWorkflows() {
  const viewOnly = useViewOnly();
  const [tab, setTab] = useTabParam('workflows', TABS.map(([k]) => k));

  const [workflows, setWorkflows] = useState([]);
  const [templates, setTemplates] = useState([]);
  const [recurring, setRecurring] = useState([]);
  // The HRMS events a template can be wired to — read from the server rather
  // than copied here, so a new event appears in the form without a change.
  const [triggers, setTriggers] = useState([]);
  const [users, setUsers] = useState([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState('');

  // the builder
  const [open, setOpen] = useState(null);        // the workflow being edited
  const [steps, setSteps] = useState([]);
  const [problems, setProblems] = useState([]);
  const [simulation, setSimulation] = useState(null);
  const [saving, setSaving] = useState(false);

  const load = useCallback(async (first = false) => {
    if (first) setLoading(true); else setRefreshing(true);
    setError('');
    try {
      const [w, t, r, m] = await Promise.all([
        T.listWorkflows({ active: 'all' }).then((x) => x.workflows).catch(() => []),
        T.listTemplates({ active: 'all' }).then((x) => x.templates).catch(() => []),
        T.listRecurring({ active: 'all' }).then((x) => x.recurring).catch(() => []),
        T.taskMeta().then((x) => x.triggers || []).catch(() => []),
      ]);
      setWorkflows(w);
      setTemplates(t);
      setRecurring(r);
      setTriggers(m);
    } catch (err) {
      setError(err.response?.data?.message || 'Could not load');
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useEffect(() => { load(true); }, [load]);
  useEffect(() => {
    api.get('/admin/users?active=true&excludeExecutives=true')
      .then((r) => setUsers(r.data.users)).catch(() => {});
  }, []);

  // ===== the builder =====

  const openWorkflow = async (wf) => {
    try {
      const { workflow, problems: p } = await T.getWorkflow(wf._id);
      setOpen(workflow);
      setSteps((workflow.draft || []).map((s) => ({
        ...s,
        slaHours: s.slaHours ?? '',
        assigneeRule: {
          kind: 'supervisor', users: [], roles: [], quorum: 'any',
          ...(s.assigneeRule || {}),
          users: (s.assigneeRule?.users || []).map((u) => String(u._id || u)),
        },
      })));
      setProblems(p || []);
      setSimulation(null);
    } catch (err) {
      toast.error(err.response?.data?.message || 'Could not open');
    }
  };

  const newWorkflow = async () => {
    const name = await promptDialog({ message: 'What is this workflow called?', confirmText: 'Create' });
    if (!name) return;
    try {
      const { workflow } = await T.createWorkflow({ name, steps: [blankStep(1)] });
      toast.success('Created — it runs nothing until you publish it');
      await load();
      await openWorkflow(workflow);
    } catch (err) {
      toast.error(err.response?.data?.message || 'Could not create');
    }
  };

  const patchStep = (i, patch) => setSteps((list) => list.map((s, j) => (j === i ? { ...s, ...patch } : s)));
  const patchRule = (i, patch) => setSteps((list) => list.map((s, j) => (
    j === i ? { ...s, assigneeRule: { ...s.assigneeRule, ...patch } } : s
  )));

  const moveStep = (i, delta) => setSteps((list) => {
    const j = i + delta;
    if (j < 0 || j >= list.length) return list;
    const next = [...list];
    [next[i], next[j]] = [next[j], next[i]];
    return next.map((s, k) => ({ ...s, order: k }));
  });

  /**
   * Toggle "runs alongside the step above".
   *
   * A parallel group is just a shared name, so joining one means taking the name
   * of the step above (making one up if it has none) and leaving one means
   * clearing it. Expressed as a switch rather than as a name field because
   * nobody thinks in group ids — they think "these two happen together".
   */
  const toggleParallel = (i) => setSteps((list) => {
    if (i === 0) return list;
    const above = list[i - 1];
    const next = [...list];
    if (next[i].parallelGroup && next[i].parallelGroup === above.parallelGroup) {
      next[i] = { ...next[i], parallelGroup: null };
      return next;
    }
    const group = above.parallelGroup || `g${i}`;
    next[i - 1] = { ...above, parallelGroup: group, join: above.join || 'all' };
    next[i] = { ...next[i], parallelGroup: group, join: above.join || 'all' };
    return next;
  });

  const saveDraft = async () => {
    setSaving(true);
    try {
      const payload = steps.map((s, i) => ({
        ...s,
        order: i,
        slaHours: s.slaHours === '' ? undefined : Number(s.slaHours),
        waitMinutes: s.waitMinutes === '' ? undefined : Number(s.waitMinutes),
      }));
      const { workflow, problems: p } = await T.updateWorkflow(open._id, { steps: payload });
      setOpen(workflow);
      setProblems(p || []);
      toast.success('Draft saved');
      await load();
    } catch (err) {
      toast.error(err.response?.data?.message || 'Could not save');
    } finally {
      setSaving(false);
    }
  };

  const publish = async () => {
    if (!(await confirmDialog({
      message: `Publish "${open.name}"? New tasks will pick this up. Tasks already running carry their own copy of the steps and are not touched.`,
      confirmText: 'Publish',
    }))) return;
    setSaving(true);
    try {
      await saveDraftQuiet();
      const r = await T.publishWorkflow(open._id);
      toast.success(r.message);
      await load();
      await openWorkflow(open);
    } catch (err) {
      toast.error(err.response?.data?.message || 'Could not publish');
    } finally {
      setSaving(false);
    }
  };

  /** Save without a toast — publishing does this first so it publishes what is on screen. */
  const saveDraftQuiet = async () => {
    const payload = steps.map((s, i) => ({
      ...s, order: i,
      slaHours: s.slaHours === '' ? undefined : Number(s.slaHours),
      waitMinutes: s.waitMinutes === '' ? undefined : Number(s.waitMinutes),
    }));
    await T.updateWorkflow(open._id, { steps: payload });
  };

  const simulate = async () => {
    setSaving(true);
    try {
      await saveDraftQuiet();
      const r = await T.simulateWorkflow(open._id, {});
      setSimulation(r);
      setProblems(r.problems || []);
    } catch (err) {
      toast.error(err.response?.data?.message || 'Could not simulate');
    } finally {
      setSaving(false);
    }
  };

  // The read-only picture of what is being built, drawn by the same rail the
  // task page uses — so the builder and the live task cannot disagree.
  const preview = useMemo(() => steps.map((s, i) => ({
    key: s.key || `draft-${i}`,
    name: s.name,
    type: s.type,
    status: 'Waiting',
    parallelGroup: s.parallelGroup,
    join: s.join,
    optional: s.optional,
    actors: [],
  })), [steps]);

  if (open) {
    return (
      <div>
        <PageHeader title={open.name}
          subtitle={open.activeVersion ? `Published version ${open.activeVersion}` : 'Never published — it runs nothing yet'}>
          <button type="button" onClick={() => { setOpen(null); setSimulation(null); }}
            className="px-3 py-2 text-sm border rounded-lg hover:bg-gray-50" style={{ minHeight: 40 }}>
            Back
          </button>
          {!viewOnly && (
            <>
              <button type="button" onClick={simulate} disabled={saving}
                className="inline-flex items-center gap-1.5 px-3 py-2 text-sm border rounded-lg hover:bg-gray-50 disabled:opacity-60"
                style={{ minHeight: 40 }}>
                <FiEye size={14} /> Who would be asked?
              </button>
              <button type="button" onClick={saveDraft} disabled={saving}
                className="px-3 py-2 text-sm border rounded-lg hover:bg-gray-50 disabled:opacity-60" style={{ minHeight: 40 }}>
                Save draft
              </button>
              <button type="button" onClick={publish} disabled={saving || problems.length > 0}
                className="inline-flex items-center gap-1.5 px-4 py-2 text-sm bg-gray-900 text-white rounded-lg hover:bg-gray-700 disabled:opacity-50"
                style={{ minHeight: 40 }}>
                <FiUploadCloud size={14} /> Publish
              </button>
            </>
          )}
        </PageHeader>

        {problems.length > 0 && (
          <div className="mb-4 rounded-lg border border-amber-200 bg-amber-50 p-3">
            <div className="flex items-center gap-2 text-sm font-medium text-amber-900 mb-1">
              <FiAlertTriangle size={15} /> This cannot be published yet
            </div>
            <ul className="list-disc list-inside text-sm text-amber-800 space-y-0.5">
              {problems.map((p) => <li key={p}>{p}</li>)}
            </ul>
          </div>
        )}

        <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
          {/* ===== the steps ===== */}
          <div className="lg:col-span-2 space-y-3">
            {steps.map((s, i) => (
              <div key={i} className="bg-white rounded-lg border border-gray-200 p-3">
                <div className="flex flex-wrap items-center gap-2 mb-3">
                  <span className="text-xs text-gray-400 tabular-nums w-5">{i + 1}</span>
                  <input value={s.name} onChange={(e) => patchStep(i, { name: e.target.value })}
                    placeholder="What is this step called?"
                    className="flex-1 min-w-[140px] border rounded-lg px-3 py-2 text-sm font-medium" style={{ minHeight: 40 }} />
                  <select value={s.type} onChange={(e) => patchStep(i, { type: e.target.value })}
                    className="border rounded-lg px-2 py-2 text-sm" style={{ minHeight: 40 }}>
                    {NODE_TYPES.map(([v, l]) => <option key={v} value={v}>{l.split(' — ')[0]}</option>)}
                  </select>
                  <button type="button" onClick={() => moveStep(i, -1)} disabled={i === 0}
                    className="p-2 rounded-lg text-gray-400 hover:bg-gray-100 disabled:opacity-30"
                    aria-label="Move up" style={{ minHeight: 40, minWidth: 40 }}>
                    <FiChevronUp size={14} />
                  </button>
                  <button type="button" onClick={() => moveStep(i, 1)} disabled={i === steps.length - 1}
                    className="p-2 rounded-lg text-gray-400 hover:bg-gray-100 disabled:opacity-30"
                    aria-label="Move down" style={{ minHeight: 40, minWidth: 40 }}>
                    <FiChevronDown size={14} />
                  </button>
                  <button type="button" onClick={() => setSteps((l) => l.filter((_, j) => j !== i))}
                    className="p-2 rounded-lg text-gray-400 hover:text-red-600 hover:bg-red-50"
                    aria-label="Remove" style={{ minHeight: 40, minWidth: 40 }}>
                    <FiTrash2 size={14} />
                  </button>
                </div>

                {i > 0 && (
                  <label className="flex items-center gap-2 mb-2 text-sm text-gray-600" style={{ minHeight: 28 }}>
                    <input type="checkbox"
                      checked={!!s.parallelGroup && s.parallelGroup === steps[i - 1].parallelGroup}
                      onChange={() => toggleParallel(i)}
                      className="h-4 w-4 rounded border-gray-300" />
                    Runs at the same time as the step above
                    {s.parallelGroup && s.parallelGroup === steps[i - 1].parallelGroup && (
                      <select value={s.join || 'all'}
                        onChange={(e) => {
                          const join = e.target.value;
                          setSteps((l) => l.map((x) => (x.parallelGroup === s.parallelGroup ? { ...x, join } : x)));
                        }}
                        className="ml-2 border rounded-lg px-2 py-1 text-xs" style={{ minHeight: 32 }}>
                        <option value="all">everyone must approve</option>
                        <option value="any">any one is enough</option>
                        <option value="majority">a majority decides</option>
                      </select>
                    )}
                  </label>
                )}

                {s.type === 'condition' ? (
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                    <div>
                      <label className="block text-xs text-gray-500">Test this field</label>
                      <input value={s.condition?.field || ''}
                        onChange={(e) => patchStep(i, { condition: { ...(s.condition || {}), field: e.target.value } })}
                        placeholder="e.g. customFields.amount or priority"
                        className="mt-1 w-full border rounded-lg px-3 py-2 text-sm" style={{ minHeight: 40 }} />
                    </div>
                    <div className="flex gap-2">
                      <div className="flex-1">
                        <label className="block text-xs text-gray-500">Operator</label>
                        <select value={s.condition?.operator || 'eq'}
                          onChange={(e) => patchStep(i, { condition: { ...(s.condition || {}), operator: e.target.value } })}
                          className="mt-1 w-full border rounded-lg px-2 py-2 text-sm" style={{ minHeight: 40 }}>
                          {OPERATORS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
                        </select>
                      </div>
                      <div className="flex-1">
                        <label className="block text-xs text-gray-500">Value</label>
                        <input value={s.condition?.value ?? ''}
                          onChange={(e) => patchStep(i, { condition: { ...(s.condition || {}), value: e.target.value } })}
                          className="mt-1 w-full border rounded-lg px-3 py-2 text-sm" style={{ minHeight: 40 }} />
                      </div>
                    </div>
                    <div>
                      <label className="block text-xs text-gray-500">If true, go to</label>
                      <select value={s.condition?.onTrue || ''}
                        onChange={(e) => patchStep(i, { condition: { ...(s.condition || {}), onTrue: e.target.value } })}
                        className="mt-1 w-full border rounded-lg px-2 py-2 text-sm" style={{ minHeight: 40 }}>
                        <option value="">the next step</option>
                        {steps.filter((x, j) => j !== i && x.key).map((x) => (
                          <option key={x.key} value={x.key}>{x.name}</option>
                        ))}
                      </select>
                    </div>
                    <div>
                      <label className="block text-xs text-gray-500">If false, go to</label>
                      <select value={s.condition?.onFalse || ''}
                        onChange={(e) => patchStep(i, { condition: { ...(s.condition || {}), onFalse: e.target.value } })}
                        className="mt-1 w-full border rounded-lg px-2 py-2 text-sm" style={{ minHeight: 40 }}>
                        <option value="">the next step</option>
                        {steps.filter((x, j) => j !== i && x.key).map((x) => (
                          <option key={x.key} value={x.key}>{x.name}</option>
                        ))}
                      </select>
                    </div>
                    {!steps.some((x) => x.key) && (
                      <p className="sm:col-span-2 text-xs text-amber-600">
                        Save the draft once so the steps have keys — a branch can then point at one.
                      </p>
                    )}
                  </div>
                ) : s.type === 'wait' ? (
                  <div>
                    <label className="block text-xs text-gray-500">Hold for (minutes)</label>
                    <input type="number" min="1" value={s.waitMinutes ?? ''}
                      onChange={(e) => patchStep(i, { waitMinutes: e.target.value })}
                      className="mt-1 w-40 border rounded-lg px-3 py-2 text-sm" style={{ minHeight: 40 }} />
                  </div>
                ) : (
                  <div className="space-y-2">
                    <div className="flex flex-wrap gap-2">
                      <div className="flex-1 min-w-[180px]">
                        <label className="block text-xs text-gray-500">Who acts on it</label>
                        <select value={s.assigneeRule.kind}
                          onChange={(e) => patchRule(i, { kind: e.target.value })}
                          className="mt-1 w-full border rounded-lg px-2 py-2 text-sm" style={{ minHeight: 40 }}>
                          {ACTOR_KINDS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
                        </select>
                      </div>
                      <div className="w-40">
                        <label className="block text-xs text-gray-500">Deadline (hours)</label>
                        <input type="number" min="0" value={s.slaHours}
                          onChange={(e) => patchStep(i, { slaHours: e.target.value })}
                          placeholder="none"
                          className="mt-1 w-full border rounded-lg px-3 py-2 text-sm" style={{ minHeight: 40 }} />
                      </div>
                    </div>

                    {s.assigneeRule.kind === 'user' && (
                      <SearchableSelect multiple value={s.assigneeRule.users}
                        onChange={(e) => patchRule(i, {
                          users: Array.from(e.target.selectedOptions || [], (o) => o.value),
                        })}
                        className="w-full border rounded-lg px-3 py-2 text-sm">
                        {users.map((u) => (
                          <option key={u._id} value={String(u._id)}>{u.firstName} {u.lastName}</option>
                        ))}
                      </SearchableSelect>
                    )}
                    {s.assigneeRule.kind === 'role' && (
                      <input value={(s.assigneeRule.roles || []).join(', ')}
                        onChange={(e) => patchRule(i, { roles: e.target.value.split(',').map((r) => r.trim()).filter(Boolean) })}
                        placeholder="HRManager, Manager"
                        className="w-full border rounded-lg px-3 py-2 text-sm" style={{ minHeight: 40 }} />
                    )}
                    {s.assigneeRule.kind === 'permission' && (
                      <input value={s.assigneeRule.permission || ''}
                        onChange={(e) => patchRule(i, { permission: e.target.value })}
                        placeholder="e.g. payroll.manage"
                        className="w-full border rounded-lg px-3 py-2 text-sm" style={{ minHeight: 40 }} />
                    )}
                    {s.assigneeRule.kind === 'department' && (
                      <input value={s.assigneeRule.department || ''}
                        onChange={(e) => patchRule(i, { department: e.target.value })}
                        placeholder="Department name"
                        className="w-full border rounded-lg px-3 py-2 text-sm" style={{ minHeight: 40 }} />
                    )}

                    <div className="flex flex-wrap gap-4">
                      {['user', 'role', 'permission', 'department'].includes(s.assigneeRule.kind) && (
                        <label className="flex items-center gap-1.5 text-sm text-gray-600" style={{ minHeight: 28 }}>
                          <input type="checkbox" checked={s.assigneeRule.quorum === 'all'}
                            onChange={(e) => patchRule(i, { quorum: e.target.checked ? 'all' : 'any' })}
                            className="h-4 w-4 rounded border-gray-300" />
                          All of them must answer
                        </label>
                      )}
                      <label className="flex items-center gap-1.5 text-sm text-gray-600" style={{ minHeight: 28 }}>
                        <input type="checkbox" checked={!!s.optional}
                          onChange={(e) => patchStep(i, { optional: e.target.checked })}
                          className="h-4 w-4 rounded border-gray-300" />
                        Optional
                      </label>
                      <label className="flex items-center gap-1.5 text-sm text-gray-600" style={{ minHeight: 28 }}>
                        <input type="checkbox" checked={!!s.requireNote}
                          onChange={(e) => patchStep(i, { requireNote: e.target.checked })}
                          className="h-4 w-4 rounded border-gray-300" />
                        Must leave a remark
                      </label>
                      <label className="flex items-center gap-1.5 text-sm text-gray-600" style={{ minHeight: 28 }}>
                        Rejecting
                        <select value={s.onReject || 'sendBack'}
                          onChange={(e) => patchStep(i, { onReject: e.target.value })}
                          className="border rounded-lg px-2 py-1 text-xs" style={{ minHeight: 32 }}>
                          <option value="sendBack">sends the task back</option>
                          <option value="previousStep">reopens the step before</option>
                          <option value="fail">cancels the task</option>
                        </select>
                      </label>
                    </div>
                  </div>
                )}
              </div>
            ))}

            {!viewOnly && (
              <button type="button" onClick={() => setSteps((l) => [...l, blankStep(l.length + 1)])}
                className="inline-flex items-center gap-1.5 px-4 py-2 text-sm border border-dashed border-gray-300 rounded-lg hover:bg-gray-50 w-full justify-center"
                style={{ minHeight: 44 }}>
                <FiPlus size={14} /> Add a step
              </button>
            )}
          </div>

          {/* ===== the picture, and the simulation ===== */}
          <div className="space-y-4">
            <div className="bg-white rounded-lg border border-gray-200 p-4">
              <div className="text-sm font-medium text-gray-700 mb-3">The route</div>
              <WorkflowRail steps={preview} />
            </div>

            {simulation && (
              <div className="bg-white rounded-lg border border-gray-200 p-4">
                <div className="text-sm font-medium text-gray-700 mb-2">Who would actually be asked</div>
                <div className="space-y-2">
                  {simulation.steps.map((s) => (
                    <div key={s.key} className="text-sm">
                      <div className="flex items-center gap-2">
                        <span className="text-gray-800">{s.name}</span>
                        {s.result && <span className="text-xs text-gray-400">→ {s.result}</span>}
                      </div>
                      {s.actors?.length > 0 && (
                        <div className="text-xs text-gray-500 ml-0.5">
                          {s.actors.map((a) => a.name).join(', ')}
                        </div>
                      )}
                      {s.warning && (
                        <div className="text-xs text-amber-700 bg-amber-50 border border-amber-100 rounded px-2 py-1 mt-1">
                          {s.warning}
                        </div>
                      )}
                    </div>
                  ))}
                </div>
                <p className="mt-3 text-xs text-gray-400">
                  Run against a made-up task with you as its supervisor. A step nobody matches would be skipped
                  on a real task too.
                </p>
              </div>
            )}

            {(open.versions || []).length > 0 && (
              <div className="bg-white rounded-lg border border-gray-200 p-4">
                <div className="text-sm font-medium text-gray-700 mb-2">Published versions</div>
                <ul className="space-y-1 text-sm">
                  {[...open.versions].reverse().map((v) => (
                    <li key={v.version} className="flex items-center gap-2">
                      <span className={v.version === open.activeVersion ? 'font-medium text-gray-900' : 'text-gray-600'}>
                        v{v.version}
                      </span>
                      {v.version === open.activeVersion && (
                        <span className="text-xs px-1.5 py-0.5 rounded bg-green-100 text-green-800" style={{ minHeight: 18 }}>
                          live
                        </span>
                      )}
                      <span className="text-xs text-gray-400 ml-auto">
                        {(v.steps || []).length} steps · {v.publishedByName || 'somebody'}
                      </span>
                    </li>
                  ))}
                </ul>
                <p className="mt-2 text-xs text-gray-400">
                  A published version is never edited. Tasks keep running the version they started on.
                </p>
              </div>
            )}
          </div>
        </div>
      </div>
    );
  }

  return (
    <div>
      <PageHeader title="Task workflows" subtitle="How work is routed, templated and repeated">
        {refreshing && <span className="text-xs text-gray-400">Updating…</span>}
        {!viewOnly && tab === 'workflows' && (
          <button type="button" onClick={newWorkflow}
            className="inline-flex items-center gap-1.5 px-4 py-2 bg-gray-900 text-white rounded-lg hover:bg-gray-700 text-sm"
            style={{ minHeight: 40 }}>
            <FiPlus size={14} /> New workflow
          </button>
        )}
      </PageHeader>

      <div className="topbar-scroll flex gap-1 border-b border-gray-200 mb-4 overflow-x-auto">
        {TABS.map(([key, label]) => (
          <button key={key} type="button" onClick={() => setTab(key)}
            className={`px-4 py-2 text-sm font-medium whitespace-nowrap border-b-2 -mb-px ${
              tab === key ? 'border-gray-900 text-gray-900' : 'border-transparent text-gray-500 hover:text-gray-700'}`}
            style={{ minHeight: 40 }}>
            {label}
          </button>
        ))}
      </div>

      {error && (
        <div className="mb-4 text-sm text-red-700 bg-red-50 border border-red-200 px-3 py-2 rounded-lg">{error}</div>
      )}

      {tab === 'workflows' && (
        <div className="bg-white shadow rounded-lg overflow-hidden">
          <table className="min-w-full divide-y divide-gray-200 text-sm">
            <thead className="bg-gray-50">
              <tr>
                <th className="px-4 py-3 text-left font-medium text-gray-700">Workflow</th>
                <th className="px-4 py-3 text-left font-medium text-gray-700">Steps</th>
                <th className="px-4 py-3 text-left font-medium text-gray-700">Published</th>
                <th className="px-4 py-3 text-right font-medium text-gray-700">Tasks on it</th>
                <th className="px-4 py-3 text-right font-medium text-gray-700"> </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {loading ? (
                <tr><td colSpan={5} className="px-4 py-4"><div className="skeleton h-4 rounded" /></td></tr>
              ) : workflows.length === 0 ? (
                <tr><td colSpan={5} className="px-4 py-8 text-center text-gray-500">
                  No workflows yet. A task without one is approved by its supervisor and completed.
                </td></tr>
              ) : workflows.map((w) => (
                <tr key={w._id} className={w.active ? '' : 'opacity-60'}>
                  <td className="px-4 py-3">
                    <button type="button" onClick={() => openWorkflow(w)}
                      className="font-medium text-gray-900 hover:underline text-left">{w.name}</button>
                    {w.description && <div className="text-xs text-gray-500">{w.description}</div>}
                    {!w.active && <span className="text-xs text-gray-400">inactive</span>}
                  </td>
                  <td className="px-4 py-3 text-gray-600">{w.stepCount}</td>
                  <td className="px-4 py-3">
                    {w.activeVersion
                      ? <span className="text-gray-700">v{w.activeVersion}</span>
                      : <span className="text-amber-600 text-xs">draft only — runs nothing</span>}
                  </td>
                  <td className="px-4 py-3 text-right tabular-nums text-gray-600">{w.taskCount}</td>
                  <td className="px-4 py-3 text-right whitespace-nowrap">
                    <button type="button" onClick={() => openWorkflow(w)}
                      className="text-blue-600 hover:underline mr-3">Edit</button>
                    {!viewOnly && (
                      <button type="button"
                        onClick={async () => {
                          if (!(await confirmDialog({
                            message: `Delete "${w.name}"?`, tone: 'danger', confirmText: 'Delete',
                          }))) return;
                          try {
                            await T.deleteWorkflow(w._id);
                            toast.success('Deleted');
                            await load();
                          } catch (err) { toast.error(err.response?.data?.message || 'Could not delete'); }
                        }}
                        className="text-red-600 hover:underline">Delete</button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {tab === 'templates' && (
        <TemplateList templates={templates} workflows={workflows} triggers={triggers} viewOnly={viewOnly} onChanged={load} loading={loading} />
      )}

      {tab === 'recurring' && (
        <RecurringList rules={recurring} templates={templates} viewOnly={viewOnly} onChanged={load} loading={loading} />
      )}
    </div>
  );
}

/** Templates — a task worth creating more than once. */
function TemplateList({ templates, workflows, triggers, viewOnly, onChanged, loading }) {
  const [editing, setEditing] = useState(undefined);

  const save = async (body) => {
    try {
      if (editing?._id) await T.updateTemplate(editing._id, body);
      else await T.createTemplate(body);
      toast.success('Saved');
      setEditing(undefined);
      await onChanged();
    } catch (err) {
      toast.error(err.response?.data?.message || 'Could not save');
    }
  };

  return (
    <div>
      {!viewOnly && (
        <button type="button" onClick={() => setEditing(null)}
          className="mb-3 inline-flex items-center gap-1.5 px-4 py-2 text-sm border rounded-lg hover:bg-gray-50"
          style={{ minHeight: 40 }}>
          <FiPlus size={14} /> New template
        </button>
      )}
      <div className="bg-white shadow rounded-lg overflow-hidden">
        <table className="min-w-full divide-y divide-gray-200 text-sm">
          <thead className="bg-gray-50">
            <tr>
              <th className="px-4 py-3 text-left font-medium text-gray-700">Template</th>
              <th className="px-4 py-3 text-left font-medium text-gray-700">Type</th>
              <th className="px-4 py-3 text-left font-medium text-gray-700">Workflow</th>
              <th className="px-4 py-3 text-left font-medium text-gray-700">Fires on</th>
              <th className="px-4 py-3 text-right font-medium text-gray-700">Used</th>
              <th className="px-4 py-3 text-right font-medium text-gray-700"> </th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100">
            {loading ? (
              <tr><td colSpan={6} className="px-4 py-4"><div className="skeleton h-4 rounded" /></td></tr>
            ) : templates.length === 0 ? (
              <tr><td colSpan={6} className="px-4 py-8 text-center text-gray-500">No templates yet.</td></tr>
            ) : templates.map((t) => (
              <tr key={t._id} className={t.active ? '' : 'opacity-60'}>
                <td className="px-4 py-3">
                  <span className="font-medium text-gray-900">{t.name}</span>
                  {t.system && <span className="ml-2 text-xs text-violet-600">wired to an event</span>}
                  {t.description && <div className="text-xs text-gray-500">{t.description}</div>}
                </td>
                <td className="px-4 py-3 text-gray-600">{t.taskType}</td>
                <td className="px-4 py-3 text-gray-600">{t.workflow?.name || '—'}</td>
                <td className="px-4 py-3 text-gray-600">{t.trigger || 'manual'}</td>
                <td className="px-4 py-3 text-right tabular-nums text-gray-600">{t.usageCount || 0}</td>
                <td className="px-4 py-3 text-right whitespace-nowrap">
                  {!viewOnly && (
                    <>
                      <button type="button" onClick={() => setEditing(t)}
                        className="text-blue-600 hover:underline mr-3">Edit</button>
                      {!t.system && (
                        <button type="button"
                          onClick={async () => {
                            if (!(await confirmDialog({ message: `Delete "${t.name}"?`, tone: 'danger', confirmText: 'Delete' }))) return;
                            try { await T.deleteTemplate(t._id); toast.success('Deleted'); await onChanged(); }
                            catch (err) { toast.error(err.response?.data?.message || 'Could not delete'); }
                          }}
                          className="text-red-600 hover:underline">Delete</button>
                      )}
                    </>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {editing !== undefined && (
        <TemplateModal template={editing} workflows={workflows} triggers={triggers} onSave={save} onClose={() => setEditing(undefined)} />
      )}
    </div>
  );
}

/** A template's own form. Deliberately the essentials — the rest is inherited. */
function TemplateModal({ template, workflows, triggers = [], onSave, onClose }) {
  const [f, setF] = useState(() => ({
    name: template?.name || '',
    description: template?.description || '',
    titleTemplate: template?.titleTemplate || '',
    taskType: template?.taskType || 'General',
    priority: template?.priority || 'Medium',
    startAfterDays: template?.startAfterDays ?? 0,
    dueAfterDays: template?.dueAfterDays ?? 3,
    workflow: template?.workflow?._id || template?.workflow || '',
    trigger: template?.trigger || '',
    active: template?.active !== false,
    checklistText: (template?.checklist || []).map((c) => c.text).join('\n'),
  }));
  const [saving, setSaving] = useState(false);

  return (
    <div className="fixed inset-0 bg-black/40 flex items-start justify-center px-4 z-50 overflow-y-auto py-8">
      <div className="bg-white rounded-xl shadow-lg w-full max-w-lg p-6">
        <div className="flex items-center justify-between mb-4">
          <h2 className="card-title">{template ? 'Edit template' : 'New template'}</h2>
          <button type="button" onClick={onClose} className="text-gray-400 hover:text-gray-600"><FiX size={18} /></button>
        </div>
        <form className="space-y-3" onSubmit={async (e) => {
          e.preventDefault();
          setSaving(true);
          try {
            await onSave({
              ...f,
              startAfterDays: Number(f.startAfterDays) || 0,
              dueAfterDays: Number(f.dueAfterDays) || 0,
              workflow: f.workflow || undefined,
              checklist: f.checklistText.split('\n').map((t) => t.trim()).filter(Boolean)
                .map((text, i) => ({ text, mandatory: true, order: i })),
            });
          } finally { setSaving(false); }
        }}>
          <div>
            <label className="block text-sm text-gray-700">Name *</label>
            <input required value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })}
              className="mt-1 block w-full border rounded-lg px-3 py-2" />
          </div>
          <div>
            <label className="block text-sm text-gray-700">Task title</label>
            <input value={f.titleTemplate} onChange={(e) => setF({ ...f, titleTemplate: e.target.value })}
              placeholder="Onboarding — {employee}"
              className="mt-1 block w-full border rounded-lg px-3 py-2" />
            <p className="mt-1 text-xs text-gray-400">
              {'{employee}'}, {'{code}'}, {'{department}'}, {'{month}'} and {'{date}'} are filled in when a task is made.
            </p>
          </div>
          <div>
            <label className="block text-sm text-gray-700">Description</label>
            <textarea rows={2} value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })}
              className="mt-1 block w-full border rounded-lg px-3 py-2" />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-sm text-gray-700">Type</label>
              <input value={f.taskType} onChange={(e) => setF({ ...f, taskType: e.target.value })}
                className="mt-1 block w-full border rounded-lg px-3 py-2" />
            </div>
            <div>
              <label className="block text-sm text-gray-700">Priority</label>
              <select value={f.priority} onChange={(e) => setF({ ...f, priority: e.target.value })}
                className="mt-1 block w-full border rounded-lg px-3 py-2">
                {['Low', 'Medium', 'High', 'Urgent'].map((p) => <option key={p}>{p}</option>)}
              </select>
            </div>
            <div>
              <label className="block text-sm text-gray-700">Starts after (days)</label>
              <input type="number" value={f.startAfterDays} onChange={(e) => setF({ ...f, startAfterDays: e.target.value })}
                className="mt-1 block w-full border rounded-lg px-3 py-2" />
            </div>
            <div>
              <label className="block text-sm text-gray-700">Due after (days)</label>
              <input type="number" value={f.dueAfterDays} onChange={(e) => setF({ ...f, dueAfterDays: e.target.value })}
                className="mt-1 block w-full border rounded-lg px-3 py-2" />
            </div>
          </div>
          <div>
            <label className="block text-sm text-gray-700">Create one automatically when</label>
            <select value={f.trigger} onChange={(e) => setF({ ...f, trigger: e.target.value })}
              className="mt-1 block w-full border rounded-lg px-3 py-2">
              <option value="">Never — only when somebody asks for it</option>
              {triggers.map((t) => <option key={t.key} value={t.key}>{t.label}</option>)}
            </select>
            <p className="mt-1 text-xs text-gray-400">
              A template wired to an event makes its task the moment that event happens —
              a new joiner, an accepted resignation — with nobody having to remember.
            </p>
          </div>
          <div>
            <label className="block text-sm text-gray-700">Workflow</label>
            <SearchableSelect value={f.workflow} onChange={(e) => setF({ ...f, workflow: e.target.value })}
              className="mt-1 block w-full border rounded-lg px-3 py-2">
              <option value="">None</option>
              {workflows.filter((w) => w.activeVersion).map((w) => (
                <option key={w._id} value={w._id}>{w.name} (v{w.activeVersion})</option>
              ))}
            </SearchableSelect>
          </div>
          <div>
            <label className="block text-sm text-gray-700">Checklist</label>
            <textarea rows={4} value={f.checklistText} onChange={(e) => setF({ ...f, checklistText: e.target.value })}
              placeholder={'One item per line\nDocuments collected\nEmail created'}
              className="mt-1 block w-full border rounded-lg px-3 py-2 text-sm" />
          </div>
          <label className="flex items-center gap-2 text-sm text-gray-700" style={{ minHeight: 28 }}>
            <input type="checkbox" checked={f.active} onChange={(e) => setF({ ...f, active: e.target.checked })}
              className="h-4 w-4 rounded border-gray-300" />
            Active
          </label>
          <div className="flex justify-end gap-2 pt-1">
            <button type="button" onClick={onClose}
              className="px-4 py-2 text-sm border rounded-lg hover:bg-gray-50" style={{ minHeight: 40 }}>Cancel</button>
            <button type="submit" disabled={saving}
              className="px-4 py-2 text-sm bg-gray-900 text-white rounded-lg hover:bg-gray-700 disabled:opacity-60"
              style={{ minHeight: 40 }}>{saving ? 'Saving…' : 'Save'}</button>
          </div>
        </form>
      </div>
    </div>
  );
}

/** Recurring schedules — a task that should exist again and again. */
function RecurringList({ rules, templates, viewOnly, onChanged, loading }) {
  const [editing, setEditing] = useState(undefined);

  const fmt = (d) => (d ? new Date(d).toLocaleDateString('en-IN', {
    day: 'numeric', month: 'short', year: 'numeric',
  }) : '—');

  return (
    <div>
      {!viewOnly && (
        <button type="button" onClick={() => setEditing(null)}
          className="mb-3 inline-flex items-center gap-1.5 px-4 py-2 text-sm border rounded-lg hover:bg-gray-50"
          style={{ minHeight: 40 }}>
          <FiPlus size={14} /> New schedule
        </button>
      )}
      <div className="bg-white shadow rounded-lg overflow-hidden">
        <table className="min-w-full divide-y divide-gray-200 text-sm">
          <thead className="bg-gray-50">
            <tr>
              <th className="px-4 py-3 text-left font-medium text-gray-700">Schedule</th>
              <th className="px-4 py-3 text-left font-medium text-gray-700">Creates</th>
              <th className="px-4 py-3 text-left font-medium text-gray-700">How often</th>
              <th className="px-4 py-3 text-left font-medium text-gray-700">Next</th>
              <th className="px-4 py-3 text-right font-medium text-gray-700">Made</th>
              <th className="px-4 py-3 text-right font-medium text-gray-700"> </th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100">
            {loading ? (
              <tr><td colSpan={6} className="px-4 py-4"><div className="skeleton h-4 rounded" /></td></tr>
            ) : rules.length === 0 ? (
              <tr><td colSpan={6} className="px-4 py-8 text-center text-gray-500">No recurring tasks set up.</td></tr>
            ) : rules.map((r) => (
              <tr key={r._id} className={r.active ? '' : 'opacity-60'}>
                <td className="px-4 py-3 font-medium text-gray-900">
                  {r.name}
                  {!r.active && <span className="ml-2 text-xs text-gray-400">paused</span>}
                </td>
                <td className="px-4 py-3 text-gray-600">{r.template?.name || '—'}</td>
                <td className="px-4 py-3 text-gray-600">
                  {r.frequency}{r.interval > 1 ? ` (every ${r.interval})` : ''}
                </td>
                <td className="px-4 py-3 text-gray-600">{fmt(r.nextOccurrence)}</td>
                <td className="px-4 py-3 text-right tabular-nums text-gray-600">{r.generatedCount || 0}</td>
                <td className="px-4 py-3 text-right whitespace-nowrap">
                  {!viewOnly && (
                    <>
                      <button type="button"
                        onClick={async () => {
                          try {
                            await T.runRecurringNow(r._id);
                            toast.success('Created the next one');
                            await onChanged();
                          } catch (err) { toast.error(err.response?.data?.message || 'Nothing was due'); }
                        }}
                        className="text-blue-600 hover:underline mr-3">Run now</button>
                      <button type="button" onClick={() => setEditing(r)}
                        className="text-gray-600 hover:underline mr-3">Edit</button>
                      <button type="button"
                        onClick={async () => {
                          if (!(await confirmDialog({
                            message: `Delete "${r.name}"? The tasks it has already made stay.`,
                            tone: 'danger', confirmText: 'Delete',
                          }))) return;
                          try { await T.deleteRecurring(r._id); toast.success('Deleted'); await onChanged(); }
                          catch (err) { toast.error(err.response?.data?.message || 'Could not delete'); }
                        }}
                        className="text-red-600 hover:underline">Delete</button>
                    </>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {editing !== undefined && (
        <RecurringModal rule={editing} templates={templates}
          onClose={() => setEditing(undefined)}
          onSave={async (body) => {
            try {
              if (editing?._id) await T.updateRecurring(editing._id, body);
              else await T.createRecurring(body);
              toast.success('Saved');
              setEditing(undefined);
              await onChanged();
            } catch (err) {
              toast.error(err.response?.data?.message || 'Could not save');
            }
          }} />
      )}
    </div>
  );
}

function RecurringModal({ rule, templates, onSave, onClose }) {
  const [f, setF] = useState(() => ({
    name: rule?.name || '',
    template: rule?.template?._id || rule?.template || '',
    frequency: rule?.frequency || 'monthly',
    interval: rule?.interval || 1,
    dayOfMonth: rule?.dayOfMonth || 1,
    daysOfWeek: rule?.daysOfWeek || [1],
    atTime: rule?.atTime || '09:00',
    startsOn: rule?.startsOn ? String(rule.startsOn).slice(0, 10) : new Date().toISOString().slice(0, 10),
    endsOn: rule?.endsOn ? String(rule.endsOn).slice(0, 10) : '',
    leadDays: rule?.leadDays || 0,
    active: rule?.active !== false,
  }));
  const [saving, setSaving] = useState(false);

  return (
    <div className="fixed inset-0 bg-black/40 flex items-start justify-center px-4 z-50 overflow-y-auto py-8">
      <div className="bg-white rounded-xl shadow-lg w-full max-w-md p-6">
        <div className="flex items-center justify-between mb-4">
          <h2 className="card-title">{rule ? 'Edit schedule' : 'New schedule'}</h2>
          <button type="button" onClick={onClose} className="text-gray-400 hover:text-gray-600"><FiX size={18} /></button>
        </div>
        <form className="space-y-3" onSubmit={async (e) => {
          e.preventDefault();
          setSaving(true);
          try {
            await onSave({
              ...f,
              interval: Number(f.interval) || 1,
              dayOfMonth: Number(f.dayOfMonth) || 1,
              leadDays: Number(f.leadDays) || 0,
              endsOn: f.endsOn || undefined,
            });
          } finally { setSaving(false); }
        }}>
          <div>
            <label className="block text-sm text-gray-700">Name *</label>
            <input required value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })}
              placeholder="Monthly attendance audit"
              className="mt-1 block w-full border rounded-lg px-3 py-2" />
          </div>
          <div>
            <label className="block text-sm text-gray-700">Creates this template *</label>
            <SearchableSelect value={f.template} onChange={(e) => setF({ ...f, template: e.target.value })}
              className="mt-1 block w-full border rounded-lg px-3 py-2">
              <option value="">Choose…</option>
              {templates.filter((t) => t.active !== false).map((t) => (
                <option key={t._id} value={t._id}>{t.name}</option>
              ))}
            </SearchableSelect>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-sm text-gray-700">How often</label>
              <select value={f.frequency} onChange={(e) => setF({ ...f, frequency: e.target.value })}
                className="mt-1 block w-full border rounded-lg px-3 py-2">
                {FREQUENCIES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
              </select>
            </div>
            <div>
              <label className="block text-sm text-gray-700">Every</label>
              <input type="number" min="1" value={f.interval} onChange={(e) => setF({ ...f, interval: e.target.value })}
                className="mt-1 block w-full border rounded-lg px-3 py-2" />
            </div>
            {['monthly', 'quarterly', 'yearly'].includes(f.frequency) && (
              <div>
                <label className="block text-sm text-gray-700">Day of month</label>
                <input type="number" min="1" max="31" value={f.dayOfMonth}
                  onChange={(e) => setF({ ...f, dayOfMonth: e.target.value })}
                  className="mt-1 block w-full border rounded-lg px-3 py-2" />
                <p className="mt-1 text-xs text-gray-400">31 lands on the last day of a short month.</p>
              </div>
            )}
            <div>
              <label className="block text-sm text-gray-700">At</label>
              <input type="time" value={f.atTime} onChange={(e) => setF({ ...f, atTime: e.target.value })}
                className="mt-1 block w-full border rounded-lg px-3 py-2" />
            </div>
            <div>
              <label className="block text-sm text-gray-700">Starts</label>
              <input type="date" required value={f.startsOn} onChange={(e) => setF({ ...f, startsOn: e.target.value })}
                className="mt-1 block w-full border rounded-lg px-3 py-2" />
            </div>
            <div>
              <label className="block text-sm text-gray-700">Ends (optional)</label>
              <input type="date" value={f.endsOn} onChange={(e) => setF({ ...f, endsOn: e.target.value })}
                className="mt-1 block w-full border rounded-lg px-3 py-2" />
            </div>
            <div>
              <label className="block text-sm text-gray-700">Appear this many days early</label>
              <input type="number" min="0" value={f.leadDays} onChange={(e) => setF({ ...f, leadDays: e.target.value })}
                className="mt-1 block w-full border rounded-lg px-3 py-2" />
            </div>
          </div>
          <label className="flex items-center gap-2 text-sm text-gray-700" style={{ minHeight: 28 }}>
            <input type="checkbox" checked={f.active} onChange={(e) => setF({ ...f, active: e.target.checked })}
              className="h-4 w-4 rounded border-gray-300" />
            Active
          </label>
          <div className="flex justify-end gap-2 pt-1">
            <button type="button" onClick={onClose}
              className="px-4 py-2 text-sm border rounded-lg hover:bg-gray-50" style={{ minHeight: 40 }}>Cancel</button>
            <button type="submit" disabled={saving}
              className="px-4 py-2 text-sm bg-gray-900 text-white rounded-lg hover:bg-gray-700 disabled:opacity-60"
              style={{ minHeight: 40 }}>{saving ? 'Saving…' : 'Save'}</button>
          </div>
        </form>
      </div>
    </div>
  );
}
