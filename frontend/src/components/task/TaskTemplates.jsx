/**
 * Templates, the directory, and the repeating schedules.
 *
 * NEW 2026-09-21. Three lists that are all "tasks I am not setting right now":
 *
 *   MINE        saved from a task row, or written here. Using one opens the
 *               assign form already filled in.
 *   DIRECTORY   shared starter templates, grouped by department — the
 *               ready-to-use library a new manager can work from on day one
 *               instead of facing an empty page. Copying one gives you your own.
 *   REPEATING   the schedules that mint tasks by themselves. Pausable, and the
 *               only place to see what is going to arrive tomorrow.
 */
import { useCallback, useEffect, useState } from 'react';
import { toast } from 'react-toastify';
import {
  FiBookmark, FiGrid, FiRepeat, FiPlay, FiPause, FiTrash2, FiCopy,
  FiZap, FiClock, FiAward,
} from 'react-icons/fi';
import { confirmDialog } from '../dialogs';
import * as T from '../../api/tasks';
import { FREQUENCY_LABELS, PRIORITY_CHIPS, repeatLabel, dueLabel } from '../../utils/taskLifecycle';

const SUB_TABS = [
  ['mine', 'My templates', FiBookmark],
  ['directory', 'Directory', FiGrid],
  ['recurring', 'Repeating', FiRepeat],
];

export default function TaskTemplates({ meta, viewOnly, onUse }) {
  const [sub, setSub] = useState('mine');
  const [templates, setTemplates] = useState([]);
  const [departments, setDepartments] = useState([]);
  const [schedules, setSchedules] = useState([]);
  const [loading, setLoading] = useState(true);
  const [department, setDepartment] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [tpl, rec] = await Promise.all([T.listTemplates(), T.listRecurring()]);
      setTemplates(tpl.templates || []);
      setDepartments(tpl.departments || []);
      setSchedules(rec.schedules || []);
    } catch (err) {
      toast.error(err?.response?.data?.message || 'Could not load the templates.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const use = useCallback(async (id) => {
    try {
      const { prefill } = await T.templatePrefill(id);
      onUse?.(prefill);
    } catch (err) {
      toast.error(err?.response?.data?.message || 'Could not open that template.');
    }
  }, [onUse]);

  const copy = useCallback(async (id) => {
    try {
      await T.copyTemplate(id);
      toast.success('Copied into your templates.');
      load();
    } catch (err) {
      toast.error(err?.response?.data?.message || 'Could not copy that template.');
    }
  }, [load]);

  const removeTemplate = useCallback(async (tpl) => {
    const yes = await confirmDialog({
      title: 'Remove this template?',
      message: `"${tpl.name}" will no longer be offered. Tasks already set from it are untouched.`,
      confirmText: 'Remove',
      tone: 'danger',
    });
    if (!yes) return;
    try {
      await T.deleteTemplate(tpl._id);
      toast.success('Removed.');
      load();
    } catch (err) {
      toast.error(err?.response?.data?.message || 'Could not remove that template.');
    }
  }, [load]);

  const toggleSchedule = useCallback(async (s) => {
    try {
      await T.updateRecurring(s._id, { isActive: !s.isActive });
      toast.success(s.isActive ? 'Paused.' : 'Running again.');
      load();
    } catch (err) {
      toast.error(err?.response?.data?.message || 'Could not change that schedule.');
    }
  }, [load]);

  const stopSchedule = useCallback(async (s) => {
    const yes = await confirmDialog({
      title: 'Stop this schedule?',
      message: `No more "${s.title}" tasks will be raised. The ones already out there stay exactly as they are.`,
      confirmText: 'Stop it',
      tone: 'danger',
    });
    if (!yes) return;
    try {
      await T.deleteRecurring(s._id);
      toast.success('Stopped.');
      load();
    } catch (err) {
      toast.error(err?.response?.data?.message || 'Could not stop that schedule.');
    }
  }, [load]);

  const shownDepartments = department
    ? departments.filter((d) => d.name === department)
    : departments;

  return (
    <div>
      <div className="mb-4 flex gap-1.5">
        {SUB_TABS.map(([key, label, Icon]) => (
          <button
            key={key}
            type="button"
            onClick={() => setSub(key)}
            className={`min-h-[34px] inline-flex items-center gap-1.5 rounded-lg border px-3 text-xs font-medium transition ${
              sub === key
                ? 'accent-border bg-gray-100 accent-text'
                : 'border-gray-200 text-gray-600 hover:border-gray-300'
            }`}
          >
            <Icon size={13} /> {label}
          </button>
        ))}
      </div>

      {loading ? (
        <div className="space-y-2">
          {[0, 1, 2].map((i) => <div key={i} className="h-16 animate-pulse rounded-xl bg-gray-100" />)}
        </div>
      ) : sub === 'mine' ? (
        templates.length === 0 ? (
          <Empty
            title="No templates yet"
            body='Press "Template" on any task you have set and it will be saved here, ready to use again.'
          />
        ) : (
          <div className="grid gap-2 sm:grid-cols-2">
            {templates.map((t) => (
              <TemplateCard
                key={t._id}
                tpl={t}
                onUse={() => use(t._id)}
                onRemove={viewOnly ? undefined : () => removeTemplate(t)}
                viewOnly={viewOnly}
              />
            ))}
          </div>
        )
      ) : sub === 'directory' ? (
        departments.length === 0 ? (
          <Empty
            title="The directory is empty"
            body="Nothing has been shared with the company yet. Your own templates are on the first tab."
          />
        ) : (
          <>
            <div className="mb-3 flex flex-wrap gap-1.5">
              <button
                type="button"
                onClick={() => setDepartment('')}
                className={`min-h-[30px] rounded-lg border px-3 text-xs font-medium ${
                  !department ? 'border-green-600 bg-green-600 text-white' : 'border-gray-200 text-gray-600'
                }`}
              >
                Everything
              </button>
              {departments.map((d) => (
                <button
                  key={d.name}
                  type="button"
                  onClick={() => setDepartment(d.name === department ? '' : d.name)}
                  className={`min-h-[30px] rounded-lg border px-3 text-xs font-medium ${
                    department === d.name ? 'border-green-600 bg-green-600 text-white' : 'border-gray-200 text-gray-600'
                  }`}
                >
                  {d.name} · {d.count}
                </button>
              ))}
            </div>
            <div className="space-y-4">
              {shownDepartments.map((d) => (
                <div key={d.name}>
                  <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-gray-400">{d.name}</h3>
                  <div className="grid gap-2 sm:grid-cols-2">
                    {d.items.map((t) => (
                      <TemplateCard
                        key={t._id}
                        tpl={t}
                        onUse={() => use(t._id)}
                        onCopy={viewOnly ? undefined : () => copy(t._id)}
                        viewOnly={viewOnly}
                      />
                    ))}
                  </div>
                </div>
              ))}
            </div>
          </>
        )
      ) : (
        schedules.length === 0 ? (
          <Empty
            title="Nothing repeats yet"
            body='Tick "Repeat" when you assign a task and the schedule will appear here.'
          />
        ) : (
          <div className="space-y-2">
            {schedules.map((s) => (
              <div key={s._id} className="rounded-xl border border-gray-200 bg-white px-3 py-2.5">
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div className="min-w-[12rem] flex-1">
                    <p className="text-sm font-medium text-gray-900">{s.title}</p>
                    <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-gray-500">
                      <span className="inline-flex items-center gap-1">
                        <FiRepeat size={11} />
                        {repeatLabel({ frequency: s.frequency, weekdays: s.weekdays, monthDay: s.monthDay })}
                        {s.time ? ` at ${s.time}` : ''}
                      </span>
                      {s.who && <span>{s.who}</span>}
                      {s.category && <span>{s.category}</span>}
                      {s.generatedCount > 0 && <span>{s.generatedCount} raised so far</span>}
                    </div>
                    {s.isActive && s.nextDueDate && (
                      <p className="mt-1 inline-flex items-center gap-1 text-xs text-gray-400">
                        <FiClock size={11} /> next: {dueLabel(s.nextDueDate, 'PENDING').text}
                      </p>
                    )}
                  </div>

                  <div className="flex shrink-0 items-center gap-1.5">
                    <span className={`min-h-[22px] rounded-lg px-2 py-0.5 text-xs font-medium ${
                      s.isActive ? 'bg-green-50 text-green-700' : 'bg-gray-100 text-gray-500'
                    }`}>
                      {s.isActive ? 'Running' : 'Paused'}
                    </span>
                    {!viewOnly && (
                      <>
                        <button type="button" onClick={() => toggleSchedule(s)}
                          title={s.isActive ? 'Pause' : 'Resume'}
                          className="min-h-[32px] min-w-[32px] rounded-lg border border-gray-200 px-2 text-gray-500 hover:border-gray-400 hover:text-blue-600">
                          {s.isActive ? <FiPause size={13} /> : <FiPlay size={13} />}
                        </button>
                        <button type="button" onClick={() => stopSchedule(s)} title="Stop it for good"
                          className="rounded-lg border border-gray-200 px-2 text-gray-500 hover:border-red-300 hover:text-red-600 min-h-[32px] min-w-[32px]">
                          <FiTrash2 size={13} />
                        </button>
                      </>
                    )}
                  </div>
                </div>
              </div>
            ))}
          </div>
        )
      )}
    </div>
  );
}

function TemplateCard({ tpl, onUse, onCopy, onRemove, viewOnly }) {
  return (
    <div className="flex flex-col rounded-xl border border-gray-200 bg-white px-3 py-2.5">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium text-gray-900">{tpl.name}</p>
          {tpl.title !== tpl.name && (
            <p className="truncate text-xs text-gray-500">{tpl.title}</p>
          )}
        </div>
        {tpl.priority && tpl.priority !== 'Medium' && (
          <span className={`min-h-[20px] shrink-0 rounded-lg px-2 py-0.5 text-[11px] font-medium ${PRIORITY_CHIPS[tpl.priority]}`}>
            {tpl.priority}
          </span>
        )}
      </div>

      <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-gray-400">
        {tpl.category && <span>{tpl.category}</span>}
        {tpl.repeat?.frequency && tpl.repeat.frequency !== 'ONCE' && (
          <span>{FREQUENCY_LABELS[tpl.repeat.frequency]}</span>
        )}
        {Number.isFinite(tpl.dueInDays) && <span>{tpl.dueInDays} day job</span>}
        {tpl.points > 0 && (
          <span className="inline-flex items-center gap-0.5"><FiAward size={10} /> {tpl.points}</span>
        )}
        {tpl.useCount > 0 && <span>used {tpl.useCount}×</span>}
      </div>

      {!viewOnly && (
        <div className="mt-2.5 flex items-center gap-1.5 border-t border-gray-100 pt-2">
          <button type="button" onClick={onUse}
            className="inline-flex items-center gap-1 rounded-lg bg-green-600 px-3 text-xs font-medium text-white hover:bg-green-700 min-h-[30px]">
            <FiZap size={11} /> Use it
          </button>
          {onCopy && (
            <button type="button" onClick={onCopy} title="Save a copy I can edit"
              className="inline-flex items-center gap-1 rounded-lg border border-gray-200 px-2.5 text-xs text-gray-600 hover:border-gray-400 hover:text-blue-600 min-h-[30px]">
              <FiCopy size={11} /> Copy
            </button>
          )}
          {onRemove && (
            <button type="button" onClick={onRemove} title="Remove"
              className="ml-auto rounded-lg border border-gray-200 px-2 text-gray-400 hover:border-red-300 hover:text-red-600 min-h-[30px] min-w-[30px]">
              <FiTrash2 size={11} />
            </button>
          )}
        </div>
      )}
    </div>
  );
}

function Empty({ title, body }) {
  return (
    <div className="rounded-2xl border border-dashed border-gray-200 px-6 py-12 text-center">
      <p className="text-sm font-medium text-gray-700">{title}</p>
      <p className="mt-1 text-xs text-gray-500">{body}</p>
    </div>
  );
}
