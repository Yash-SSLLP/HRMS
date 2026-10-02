/**
 * A task row that SWIPES on a touch screen (2026-09-27) — the web twin of the
 * app's components/TaskSwipe, for the portal opened on a phone.
 *
 * The user's three pairs, per stage:
 *
 *   not accepted   right → Accept          left → Reject
 *   in progress    right → Complete        left → Ask for more time
 *   in review      right → Complete        left → Send it back
 *
 * TOUCH ONLY. A mouse drags to select text and clicks a dropdown; hijacking a
 * mouse drag would make the row feel broken on a desk. A finger's horizontal
 * pull (`pointerType === 'touch'`) is the gesture; vertical scrolling is left
 * to the browser (`touch-action: pan-y`), and the axis is decided once, after
 * 8px of travel, so a scroll that wobbles sideways never moves the row.
 *
 * NOTHING HAPPENS ON THE SWIPE ITSELF. A full pull springs the row back and
 * hands the move to `onAction`, which opens the remark box. The click the
 * browser fires at the end of a swipe is swallowed, so a swipe never also
 * opens the task underneath.
 */
import { useRef, useState } from 'react';
import { FiCheck, FiCheckCircle, FiClock, FiEdit2, FiRotateCcw, FiThumbsDown, FiThumbsUp } from 'react-icons/fi';

const ICONS = { FiCheck, FiCheckCircle, FiClock, FiEdit2, FiRotateCcw, FiThumbsDown, FiThumbsUp };
/** How far the row must travel before the move counts, and how far it can. */
const THRESHOLD = 84;
const MAX = 120;
const FILL = { green: '#16a34a', red: '#dc2626', amber: '#b54708', blue: '#2563eb' };

function Pane({ action, side, pull }) {
  const Icon = ICONS[action.icon] || FiCheck;
  const ready = pull >= THRESHOLD;
  return (
    <div
      aria-hidden="true"
      className={`absolute inset-y-0 flex items-center rounded-2xl text-white ${side === 'left' ? 'left-0 justify-start pl-5' : 'right-0 justify-end pr-5'}`}
      style={{ width: MAX + 24, background: FILL[action.tone] || FILL.green, opacity: pull > 4 ? 1 : 0 }}
    >
      <span
        className="flex flex-col items-center gap-1 text-[12px] font-bold transition-transform duration-150"
        style={{ transform: `scale(${ready ? 1.08 : 0.85 + Math.min(1, pull / THRESHOLD) * 0.15})` }}
      >
        <Icon size={20} />
        {action.label}
      </span>
    </div>
  );
}

export default function SwipeRow({ actions, onAction, children }) {
  const { left, right } = actions || {};
  const [dx, setDx] = useState(0);
  const [dragging, setDragging] = useState(false);
  const gesture = useRef(null);
  const swallowClick = useRef(false);

  if (!left && !right) return children;

  const onPointerDown = (e) => {
    if (e.pointerType !== 'touch') return;
    gesture.current = { x: e.clientX, y: e.clientY, id: e.pointerId, axis: null };
  };

  const onPointerMove = (e) => {
    const g = gesture.current;
    if (!g || e.pointerId !== g.id) return;
    const ddx = e.clientX - g.x;
    const ddy = e.clientY - g.y;
    if (!g.axis) {
      if (Math.abs(ddx) < 8 && Math.abs(ddy) < 8) return;
      g.axis = Math.abs(ddx) > Math.abs(ddy) ? 'x' : 'y';
      if (g.axis === 'x') {
        setDragging(true);
        e.currentTarget.setPointerCapture?.(e.pointerId);
      }
    }
    if (g.axis !== 'x') return;
    let v = ddx;
    if (v > 0 && !right) v = 0;
    if (v < 0 && !left) v = 0;
    // A little resistance past the point where it counts.
    const abs = Math.abs(v);
    const eased = abs > THRESHOLD ? THRESHOLD + (abs - THRESHOLD) * 0.35 : abs;
    setDx(Math.sign(v) * Math.min(MAX, eased));
  };

  const finish = () => {
    const g = gesture.current;
    gesture.current = null;
    setDragging(false);
    if (!g || g.axis !== 'x') { setDx(0); return; }
    swallowClick.current = true;
    setTimeout(() => { swallowClick.current = false; }, 350);
    const act = dx >= THRESHOLD ? right : dx <= -THRESHOLD ? left : null;
    setDx(0);
    if (act) setTimeout(() => onAction?.(act.key), 140);
  };

  return (
    <div className="swipe-row relative rounded-2xl" style={{ touchAction: 'pan-y' }}>
      {right && <Pane action={right} side="left" pull={Math.max(0, dx)} />}
      {left && <Pane action={left} side="right" pull={Math.max(0, -dx)} />}
      <div
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={finish}
        onPointerCancel={finish}
        onClickCapture={(e) => {
          if (swallowClick.current) { e.stopPropagation(); e.preventDefault(); }
        }}
        className="relative"
        style={{
          transform: dx ? `translateX(${dx}px)` : undefined,
          transition: dragging ? 'none' : 'transform 220ms cubic-bezier(.2,.8,.2,1)',
        }}
      >
        {children}
      </div>
    </div>
  );
}
