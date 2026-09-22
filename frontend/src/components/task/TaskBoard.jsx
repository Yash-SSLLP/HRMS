/**
 * One board — a heading, its own figures, and four columns.
 *
 * NEW 2026-09-22. The brief drew TWO of these stacked on one page:
 *
 *     Assigned to me     [ To Do ] [ In Progress ] [ Review ] [ Done ]
 *     Assigned by me     [ To Do ] [ In Progress ] [ Review ] [ Done ]
 *
 * so this component is ONE section and the page renders it twice, with
 * `scope="mine"` and `scope="delegated"`. Two instances rather than one
 * component that knows about both, because each is a separate query with its
 * own counters, its own collapse state and its own drag — and because the page
 * that wants only one of them (an employee's own board) should be able to drop
 * the other by deleting a line.
 *
 * WHAT A COLUMN IS. `GET /tasks/board` returns the four columns already
 * grouped, capped at 50 rows each, with the real count and how many did not
 * fit. Four capped queries rather than one page grouped in the browser: a
 * single 200-row page sorted by deadline is easily 200 pending tasks, which
 * leaves "Review" — the column somebody opened the board to clear — looking
 * empty. The labels are the SERVER's (`column.boardLabel`); the copy in
 * utils/taskLifecycle is only for the skeleton drawn before the answer lands.
 *
 * DRAGGING DOES NOT MOVE ANYTHING BY ITSELF, and that is the module's rule
 * rather than an unfinished feature — see `handleDrop`. It is also only ever an
 * ACCELERATOR: HTML5 drag events do not fire on a touch screen, so every move a
 * drag can make is also on the buttons inside the task, which is where the
 * phone and the keyboard make it.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { toast } from 'react-toastify';
import { FiChevronDown, FiChevronRight, FiLoader, FiInbox } from 'react-icons/fi';
import * as T from '../../api/tasks';
import { BOARD_COLUMNS, statusStyle } from '../../utils/taskLifecycle';
import TaskCard from './TaskCard';
import TaskStatTiles from './TaskStatTiles';

/**
 * A stat tile maps to the query that produces exactly the rows it counted.
 *
 * `total` is everything, so it carries no filter — clicking it is how you get
 * back to the whole board.
 */
const TILE_QUERY = {
  total: {},
  overdue: { overdue: 'true' },
  pending: { status: 'PENDING' },
  inReview: { status: 'SUBMITTED' },
  completed: { status: 'COMPLETED' },
};

/** Both sections open the first time; after that, however it was left. */
const lsKey = (scope) => `hrms.tasks.board.${scope}.open`;

const readOpen = (scope) => {
  try {
    return localStorage.getItem(lsKey(scope)) !== '0';
  } catch {
    // Private windows and locked-down profiles throw on the accessor itself.
    return true;
  }
};

/** The four columns with nothing in them — what a first load draws. */
const skeletonColumns = () =>
  BOARD_COLUMNS.map((c) => ({ key: c.key, boardLabel: c.label, count: 0, more: 0, tasks: [] }));

/**
 * An empty column, said in words rather than by pasting the label into a
 * sentence: "Nothing in In progress" is what that produces, and the four
 * columns' labels are not phrases that take a preposition.
 */
const EMPTY_LINE = {
  PENDING: 'Nothing waiting',
  IN_PROGRESS: 'Nothing in hand',
  SUBMITTED: 'Nothing to review',
  COMPLETED: 'Nothing finished yet',
};

export default function TaskBoard({
  scope = 'mine',
  title,
  params = {},
  onOpen,
  onMove,
  refreshKey = 0,
}) {
  const [open, setOpen] = useState(() => readOpen(scope));
  const [data, setData] = useState(null);
  const [counters, setCounters] = useState({});
  const [tile, setTile] = useState('');

  /**
   * THE LOADING / REFRESHING SPLIT. Only the very first load blanks the board;
   * every filter change after it leaves the columns on screen and shows a quiet
   * spinner in the heading. Setting `loading` on every fetch is the
   * refetch-collapse this portal has fixed in a dozen lists: the page jumps
   * under the reader's hands and whatever they were about to click moves.
   */
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const firstLoad = useRef(true);

  // ===== The request =====

  const query = useMemo(
    () => ({ ...params, ...(TILE_QUERY[tile] || {}), scope }),
    [params, tile, scope]
  );
  // The parent rebuilds `params` whenever anything on the page changes, so the
  // effect keys off the VALUES rather than the object's identity — otherwise a
  // re-render of the page is a fresh round trip for both boards.
  const queryKey = useMemo(() => JSON.stringify(query), [query]);

  useEffect(() => {
    // A collapsed section is four capped queries nobody asked for. The portal
    // has form here (mobile startup cost); it fetches when it is opened.
    if (!open) return undefined;

    let alive = true;
    if (firstLoad.current) setLoading(true);
    else setRefreshing(true);

    const sent = JSON.parse(queryKey);
    /**
     * With a tile filter on, the board's own counters come back COUNTING THE
     * FILTER — ask for the pending rows and `completed` is 0 — which would
     * empty the four tiles drawn beside the active one. So while a tile is
     * active the figures are fetched separately, without it. That is one extra
     * request, and only while a filter is on.
     */
    const unfiltered = tile && tile !== 'total'
      ? T.taskCounters({ ...params, scope })
      : null;

    Promise.all([
      T.taskBoard(sent),
      unfiltered,
    ])
      .then(([board, apart]) => {
        if (!alive) return;
        setData(board);
        setCounters(apart || board.counters || {});
      })
      .catch(() => {
        if (alive) toast.error('Could not load the board.');
      })
      .finally(() => {
        if (!alive) return;
        firstLoad.current = false;
        setLoading(false);
        setRefreshing(false);
      });

    return () => { alive = false; };
    // `params` and `tile` are both folded into queryKey; listing them again
    // would re-run the effect twice for one change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [queryKey, open, refreshKey]);

  const toggle = () => {
    const next = !open;
    setOpen(next);
    try {
      localStorage.setItem(lsKey(scope), next ? '1' : '0');
    } catch {
      // Remembering it is a convenience; not being able to is not an error.
    }
  };

  // ===== Drag and drop =====

  /**
   * The card being dragged, held in a ref rather than state.
   *
   * `dragover` fires continuously and has to answer "may this land here?"
   * synchronously; a state read would be a render behind. The dragged id IS
   * kept in state as well, but only so the card can fade and the target column
   * can light up.
   */
  const dragged = useRef(null);
  const [draggingId, setDraggingId] = useState('');
  const [over, setOver] = useState('');

  /**
   * Only offer a drop the SERVER would accept. `can.transitions` is computed by
   * services/taskAccess.capabilitiesFor for this viewer and this row, so a
   * column the person may not move the task into simply refuses the drop
   * instead of taking it and bouncing back with a 403.
   */
  const canDropOn = useCallback((columnKey, task = dragged.current) => {
    if (!task || columnKey === task.status) return false;
    return (task.can?.transitions || []).some((m) => m.to === columnKey);
  }, []);

  const handleDragStart = useCallback((task, e) => {
    dragged.current = task;
    setDraggingId(String(task._id));
    try {
      // Firefox will not start a drag at all unless something is on the
      // dataTransfer. The id is also the honest payload: a drop inside this
      // section is resolved from the ref, and a drop anywhere else in the
      // browser gets a harmless string rather than our whole row.
      e.dataTransfer.setData('text/plain', String(task._id));
      e.dataTransfer.effectAllowed = 'move';
    } catch {
      // Safari has been known to throw on setData outside a real drag.
    }
  }, []);

  const handleDragEnd = useCallback(() => {
    dragged.current = null;
    setDraggingId('');
    setOver('');
  }, []);

  /**
   * DROPPING DOES NOT MOVE THE CARD. It opens the update box with the new
   * status already picked.
   *
   * That is the module's rule, not an oversight: every status change carries a
   * note or a voice note, and the server refuses a silent one
   * (config/tasks.TRANSITIONS marks the moves that require one). A board that
   * moved the card and then had the save rejected would have to slide it back,
   * which is worse than never moving it. `onMove(task, status)` is the page's
   * TaskUpdateModal, pre-set.
   */
  const handleDrop = useCallback((columnKey, e) => {
    e.preventDefault();
    // Take the card off the ref BEFORE clearing the drag, and hand it to
    // `canDropOn` explicitly: handleDragEnd() nulls the ref, and a check made
    // after it silently answers "no" to every drop.
    const task = dragged.current;
    handleDragEnd();
    if (!task || !canDropOn(columnKey, task)) return;
    onMove?.(task, columnKey);
  }, [canDropOn, handleDragEnd, onMove]);

  // ===== Drawing =====

  const columns = data?.columns?.length ? data.columns : skeletonColumns();
  // The heading counts the same population the Total tile does — the section's
  // whole workload, not what the active tile has narrowed it to. Two totals on
  // one row that disagree is worse than no total at all.
  const total = data ? (counters.total ?? 0) : undefined;

  return (
    <section className="rounded-2xl border border-gray-200 bg-white shadow-sm">
      {/* ── The heading ─────────────────────────────────────── */}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2 px-4 py-3 sm:px-5">
        <button
          type="button"
          onClick={toggle}
          aria-expanded={open}
          className="inline-flex min-w-0 items-center gap-2 rounded-xl text-left"
        >
          {open ? <FiChevronDown size={16} className="shrink-0 text-gray-400" />
            : <FiChevronRight size={16} className="shrink-0 text-gray-400" />}
          <span className="truncate text-sm font-semibold text-gray-900">{title}</span>
          {typeof total === 'number' && (
            <span className="min-h-[22px] shrink-0 rounded-lg bg-gray-100 px-2 py-0.5 text-xs font-medium tabular-nums text-gray-600">
              {total}
            </span>
          )}
        </button>

        {refreshing && (
          <span className="inline-flex items-center gap-1 text-xs text-gray-400">
            <FiLoader size={12} className="animate-spin" /> updating
          </span>
        )}
      </div>

      {open && (
        <div className="border-t border-gray-100 px-4 pb-4 pt-4 sm:px-5 sm:pb-5">
          <TaskStatTiles counters={counters} active={tile} onPick={setTile} compact />

          {/* A status tile narrows the whole board to one column's worth of
              rows, which is what a filter does — but on a board it looks like
              three columns went missing, so it says so. */}
          {tile && tile !== 'total' && (
            <p className="mt-2 text-xs text-gray-500">
              Filtered — the other columns are hidden by this filter, not empty.
              Click the tile again to see the whole board.
            </p>
          )}

          {/* ── The four columns ───────────────────────────────
              Below 1024px the row scrolls sideways rather than wrapping: two
              columns over two lines is not a board. */}
          <div className="mt-4 flex gap-4 overflow-x-auto pb-1 lg:grid lg:grid-cols-4 lg:overflow-visible">
            {columns.map((col) => {
              const droppable = Boolean(draggingId) && canDropOn(col.key);
              const isOver = droppable && over === col.key;

              return (
                <div
                  key={col.key}
                  onDragOver={(e) => {
                    // preventDefault IS what makes a box a drop target, so it is
                    // called only for a move the server would allow.
                    if (!canDropOn(col.key)) return;
                    e.preventDefault();
                    e.dataTransfer.dropEffect = 'move';
                    if (over !== col.key) setOver(col.key);
                  }}
                  onDragLeave={(e) => {
                    // dragleave also fires when the pointer crosses onto a CHILD
                    // of the column, which would flicker the highlight off and on
                    // over every card.
                    if (e.currentTarget.contains(e.relatedTarget)) return;
                    if (over === col.key) setOver('');
                  }}
                  onDrop={(e) => handleDrop(col.key, e)}
                  className={`flex w-[17rem] shrink-0 flex-col rounded-2xl border transition lg:w-auto
                    ${isOver ? 'border-dashed border-gray-400 bg-gray-100'
                      : droppable ? 'border-dashed border-gray-300 bg-gray-50'
                        : 'border-gray-200 bg-gray-50'}`}
                >
                  {/* The column header, styled the same in both sections: the
                      server's label, a count pill in the status's own colour
                      (shared vocabulary — statusStyle), and what did not fit. */}
                  <div className="flex items-center gap-2 px-3 py-2.5">
                    <span className="truncate text-sm font-semibold text-gray-700">
                      {col.boardLabel || col.label}
                    </span>
                    <span
                      className={`min-h-[20px] shrink-0 rounded-lg px-1.5 py-0.5 text-[11px] font-medium tabular-nums ${statusStyle(col.key)}`}
                    >
                      {col.count ?? col.tasks.length}
                    </span>
                    {col.more > 0 && (
                      <span
                        className="ml-auto shrink-0 text-[11px] text-gray-400"
                        title={`${col.more} more than this column shows — narrow the filters to see them`}
                      >
                        +{col.more} more
                      </span>
                    )}
                  </div>

                  {/* Each column scrolls on its OWN, so a 50-card To Do does not
                      push the second board off the bottom of the page. */}
                  <div className="flex max-h-[28rem] min-h-[6rem] flex-col gap-2 overflow-y-auto px-2 pb-3">
                    {loading ? (
                      [0, 1, 2].map((i) => (
                        <div key={i} className="h-24 animate-pulse rounded-2xl bg-gray-200/70" />
                      ))
                    ) : col.tasks.length ? (
                      col.tasks.map((task) => (
                        <TaskCard
                          key={task._id}
                          task={task}
                          scope={scope}
                          onOpen={onOpen}
                          onDragStart={handleDragStart}
                          onDragEnd={handleDragEnd}
                          dragging={draggingId === String(task._id)}
                          /* Nothing to drag a finished task to, and a grab
                             cursor that leads nowhere is a promise the board
                             cannot keep. */
                          draggable={Boolean(task.can?.transitions?.length)}
                        />
                      ))
                    ) : (
                      <p className="flex flex-1 items-center justify-center gap-1.5 px-2 py-6 text-center text-xs text-gray-400">
                        <FiInbox size={13} className="shrink-0" />
                        {EMPTY_LINE[col.key] || 'Nothing here'}
                      </p>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </section>
  );
}
