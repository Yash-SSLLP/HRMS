/**
 * The route a task is running, drawn as a rail.
 *
 * The detail page is built around a timeline (section 41), and this is the part
 * of it that says what is still AHEAD — which the activity trail, being a record
 * of what has happened, cannot.
 *
 * WHAT IT HAS TO SHOW that a plain list of ticks cannot:
 *   - a PARALLEL GROUP is several steps running at once, so they are drawn
 *     braced together rather than stacked as though one followed the other;
 *   - a step is waiting on PEOPLE, and which of them have answered is the whole
 *     question when a group needs everybody;
 *   - a SKIPPED step is not a done step — a condition took the other branch, or
 *     nobody could be resolved to it, and hiding that would make the route look
 *     like something it was not.
 *
 * Reads the `workflow` array the detail endpoint returns (services/taskWorkflow
 * `outline`), never the raw steps, so the client has no opinion about how the
 * engine stores them.
 */
import { FiCheck, FiX, FiClock, FiMinus, FiCircle, FiGitMerge } from 'react-icons/fi';
import { STEP_STYLES } from '../../utils/taskLifecycle';
import { formatDateTime12 } from '../../utils/time';

const ICONS = {
  Approved: <FiCheck size={12} />,
  Done: <FiCheck size={12} />,
  Rejected: <FiX size={12} />,
  Pending: <FiClock size={12} />,
  Skipped: <FiMinus size={12} />,
  Waiting: <FiCircle size={12} />,
};

const DOT_TONES = {
  Approved: 'bg-green-500 text-white border-green-500',
  Done: 'bg-green-500 text-white border-green-500',
  Rejected: 'bg-red-500 text-white border-red-500',
  Pending: 'bg-amber-500 text-white border-amber-500',
  Skipped: 'bg-white text-gray-300 border-gray-200',
  Waiting: 'bg-white text-gray-300 border-gray-300',
};

/**
 * Group the flat outline into rows, where a row is either one step or a whole
 * parallel group. Order is preserved; a group takes the position of its first
 * member.
 * @param {Array} steps
 * @returns {Array<{parallel: boolean, group?: string, join?: string, steps: Array}>}
 */
function toRows(steps) {
  const rows = [];
  const seen = new Set();
  for (const s of steps) {
    if (!s.parallelGroup) { rows.push({ parallel: false, steps: [s] }); continue; }
    if (seen.has(s.parallelGroup)) continue;
    seen.add(s.parallelGroup);
    rows.push({
      parallel: true,
      group: s.parallelGroup,
      join: s.join || 'all',
      steps: steps.filter((x) => x.parallelGroup === s.parallelGroup),
    });
  }
  return rows;
}

const JOIN_TEXT = {
  all: 'everyone must approve',
  any: 'any one is enough',
  majority: 'a majority decides',
};

/** One step's dot, name, people and timing. */
function Step({ step, onDecide, canDecide, deciding }) {
  const open = step.status === 'Pending';
  const mine = canDecide && canDecide(step);
  return (
    <div className="flex gap-3">
      <div className="flex flex-col items-center shrink-0">
        <span className={`w-5 h-5 rounded-full border flex items-center justify-center ${DOT_TONES[step.status] || DOT_TONES.Waiting}`}>
          {ICONS[step.status] || ICONS.Waiting}
        </span>
      </div>
      <div className="flex-1 min-w-0 pb-4">
        <div className="flex flex-wrap items-center gap-2">
          <span className={`text-sm ${open ? 'font-medium text-gray-900' : 'text-gray-700'}`}>{step.name}</span>
          <span className={`inline-flex items-center rounded-lg px-1.5 py-0.5 text-[11px] ${STEP_STYLES[step.status] || ''}`}
            style={{ minHeight: 18 }}>
            {step.status === 'Pending' ? 'Waiting on' : step.status}
          </span>
          {step.optional && <span className="text-[11px] text-gray-400">optional</span>}
        </div>

        {(step.actors || []).length > 0 && (
          <div className="mt-1 flex flex-wrap gap-x-3 gap-y-0.5 text-xs text-gray-500">
            {step.actors.map((a) => (
              <span key={String(a.user)} className="inline-flex items-center gap-1">
                <span className={a.decision ? 'line-through text-gray-400' : ''}>{a.name}</span>
                {a.decision === 'approved' && <FiCheck className="text-green-600" size={11} />}
                {a.decision === 'rejected' && <FiX className="text-red-600" size={11} />}
              </span>
            ))}
          </div>
        )}

        {/* Somebody's remark on a decision is often the only record of WHY a
            route went the way it did — worth more room than a tooltip. */}
        {(step.actors || []).filter((a) => a.note).map((a) => (
          <div key={`${a.user}-note`} className="mt-1 text-xs text-gray-600 bg-gray-50 border border-gray-100 rounded px-2 py-1">
            <span className="text-gray-400">{a.name}:</span> {a.note}
          </div>
        ))}

        {(step.dueAt && open) && (
          <div className={`mt-1 text-xs ${new Date(step.dueAt) < new Date() ? 'text-red-600' : 'text-gray-400'}`}>
            Due {formatDateTime12(step.dueAt)}
          </div>
        )}
        {step.completedAt && !open && (
          <div className="mt-1 text-xs text-gray-400">{formatDateTime12(step.completedAt)}</div>
        )}

        {mine && (
          <div className="mt-2 flex gap-2">
            <button type="button" disabled={deciding}
              onClick={() => onDecide(step, 'approved')}
              className="px-3 py-1.5 text-xs rounded-lg bg-gray-900 text-white hover:bg-gray-700 disabled:opacity-60">
              Approve this step
            </button>
            <button type="button" disabled={deciding}
              onClick={() => onDecide(step, 'rejected')}
              className="px-3 py-1.5 text-xs rounded-lg border border-red-200 text-red-700 hover:bg-red-50 disabled:opacity-60">
              Reject
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * @param {object} props
 * @param {Array} props.steps - the `workflow` outline from GET /tasks/:id
 * @param {string} [props.name] - the workflow's name
 * @param {number} [props.version]
 * @param {(step:object, decision:string) => void} [props.onDecide]
 * @param {(step:object) => boolean} [props.canDecide] - is this step mine to answer?
 * @param {boolean} [props.deciding]
 */
export default function WorkflowRail({ steps = [], name, version, onDecide, canDecide, deciding }) {
  if (!steps.length) {
    return (
      <p className="text-sm text-gray-500">
        This task is not running a workflow — it is approved by its supervisor and completed.
      </p>
    );
  }
  const rows = toRows(steps);

  return (
    <div>
      {name && (
        <div className="mb-3 text-xs text-gray-500">
          Route: <span className="text-gray-700">{name}</span>
          {version != null && <span className="text-gray-400"> · version {version}</span>}
          {/* Saying the version out loud matters: it is the promise that editing
              the workflow cannot change this task. */}
        </div>
      )}

      <div className="relative">
        {/* The spine. Sits behind the dots and stops short of the last row so it
            does not hang past the end of the route. */}
        <div className="absolute left-[10px] top-2 bottom-6 w-px bg-gray-200" aria-hidden />
        <div className="relative">
          {rows.map((row) => (
            row.parallel ? (
              <div key={row.group} className="flex gap-3">
                <div className="flex flex-col items-center shrink-0">
                  <span className="w-5 h-5 rounded-full border border-gray-300 bg-white flex items-center justify-center text-gray-400">
                    <FiGitMerge size={12} />
                  </span>
                </div>
                <div className="flex-1 min-w-0 pb-4">
                  <div className="text-xs text-gray-500 mb-2">
                    At the same time — {JOIN_TEXT[row.join] || row.join}
                  </div>
                  <div className="border-l-2 border-gray-100 pl-3 space-y-0">
                    {row.steps.map((s) => (
                      <Step key={s.key} step={s} onDecide={onDecide} canDecide={canDecide} deciding={deciding} />
                    ))}
                  </div>
                </div>
              </div>
            ) : (
              <Step key={row.steps[0].key} step={row.steps[0]} onDecide={onDecide} canDecide={canDecide} deciding={deciding} />
            )
          ))}
        </div>
      </div>
    </div>
  );
}
