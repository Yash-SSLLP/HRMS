// Dark/light theme switch, shared by the portal top bar and the login screen so
// both look and behave identically: a segmented track with a sliding white knob,
// an amber sun on the light side and an indigo moon on the dark side (the active
// icon lights up), and a circular-reveal transition of the whole page.
//
// The reveal is a circle expanding from the button, done three ways so it looks
// the same on as many browsers as possible:
//
//   1. View Transitions API (Chrome 111+, and the only one that wipes in the
//      real new page — text, borders and all).
//   2. A hand-rolled reveal for older engines: an overlay painted in the
//      incoming theme's page colour, clip-path'd from a point out to the far
//      corner. It cannot show the new CONTENT mid-wipe, but the page is mostly
//      background so it reads as the same effect. Needs only clip-path and
//      element.animate, both of which predate View Transitions by years — which
//      matters because this used to fall straight through to an instant flip on
//      any Chrome before 111.
//   3. Instant, when the user prefers reduced motion or the browser has neither.
import { flushSync } from 'react-dom';
import { FiSun, FiMoon } from 'react-icons/fi';
import { useThemeStore } from '../store/themeStore';

const DURATION = 550;
const EASING = 'cubic-bezier(.65, 0, .35, 1)';

/**
 * The page background the theme is about to switch TO.
 *
 * Read from the stylesheet rather than hard-coded, by flipping the class on
 * <html>, sampling `--bg`, and flipping it straight back. Nothing is painted in
 * between — the browser only repaints at the end of the task — so this cannot
 * flash. Reading it beats duplicating the two hex values here, which would
 * silently drift the first time index.css was re-themed.
 * @param {boolean} goingDark
 * @returns {string} A CSS colour, falling back to the current one.
 */
function incomingBg(goingDark) {
  const root = document.documentElement;
  const had = root.classList.contains('dark');
  root.classList.toggle('dark', goingDark);
  const bg = getComputedStyle(root).getPropertyValue('--bg').trim();
  root.classList.toggle('dark', had);
  return bg || (goingDark ? '#0e0f13' : '#f3f5f9');
}

export default function ThemeToggle({ className = '' }) {
  const mode = useThemeStore((s) => s.mode);
  const toggleMode = useThemeStore((s) => s.toggle);

  const handleToggle = (e) => {
    const reduced = typeof window !== 'undefined'
      && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (typeof document === 'undefined' || reduced) { toggleMode(); return; }

    // Originate the reveal from the toggle's centre (not the raw cursor point) so
    // it's consistent wherever the button is clicked — and works for keyboard
    // activation, where clientX/Y would be 0,0.
    const rect = e.currentTarget.getBoundingClientRect();
    const x = rect.left + rect.width / 2;
    const y = rect.top + rect.height / 2;
    const endRadius = Math.hypot(Math.max(x, window.innerWidth - x), Math.max(y, window.innerHeight - y));
    const frames = {
      clipPath: [`circle(0px at ${x}px ${y}px)`, `circle(${endRadius}px at ${x}px ${y}px)`],
    };

    // ---- 1. View Transitions: the real thing ----
    if (document.startViewTransition) {
      const transition = document.startViewTransition(() => {
        // flushSync so the .dark class is on <html> before the "new" snapshot.
        flushSync(() => toggleMode());
      });
      transition.ready.then(() => {
        document.documentElement.animate(frames, {
          duration: DURATION, easing: EASING, pseudoElement: '::view-transition-new(root)',
        });
      }).catch(() => {});
      return;
    }

    // ---- 2. Older engines: reveal an overlay in the incoming colour ----
    const overlay = document.createElement('div');
    const canReveal = typeof overlay.animate === 'function'
      && typeof window.CSS !== 'undefined'
      && typeof window.CSS.supports === 'function'
      && window.CSS.supports('clip-path', 'circle(10px at 10px 10px)');
    if (!canReveal) { toggleMode(); return; }

    overlay.style.cssText = [
      'position:fixed', 'top:0', 'left:0', 'right:0', 'bottom:0',
      // Above everything the app draws, including modals and the chat dock.
      'z-index:2147483647',
      // Never swallow a click: the page underneath stays live throughout.
      'pointer-events:none',
      `background:${incomingBg(mode !== 'dark')}`,
    ].join(';');
    document.body.appendChild(overlay);

    const anim = overlay.animate(frames, { duration: DURATION, easing: EASING, fill: 'forwards' });

    /**
     * Swap the theme underneath the fully-grown overlay, then drop it. At this
     * point the overlay covers the viewport in the incoming colour, so the real
     * page changing beneath it is invisible.
     *
     * Both steps are SYNCHRONOUS and idempotent, and each half of that matters:
     *
     *  - No requestAnimationFrame. A tab that is not compositing — backgrounded,
     *    minimised, occluded — never runs the callback, which would strand the
     *    overlay over the page as a permanently blank screen. flushSync has
     *    already committed the new theme by the time this line runs, and the
     *    browser paints once at the end of the task, so removing it here shows
     *    the new theme with no flash.
     *  - The `done` latch. Three things race to call this (onfinish, oncancel,
     *    the timeout backstop) and a second call would toggle the theme straight
     *    back again.
     */
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      flushSync(() => toggleMode());
      overlay.remove();
    };
    anim.onfinish = finish;
    anim.oncancel = finish;
    // The backstop for an animation that never reports finishing at all, which
    // is exactly what a throttled background tab does.
    setTimeout(finish, DURATION + 400);
  };

  const label = mode === 'dark' ? 'Switch to light mode' : 'Switch to dark mode';

  return (
    // Wrapper carries any positioning from the caller, so the button keeps its
    // own `relative` (the sliding knob is absolutely positioned inside it).
    <span className={`inline-flex shrink-0 ${className}`}>
      <button
        type="button"
        onClick={handleToggle}
        title={label}
        aria-label={label}
        aria-pressed={mode === 'dark'}
        className="relative shrink-0 rounded-full transition-colors duration-200"
        style={{
          width: 64, height: 30,
          background: mode === 'dark' ? '#3b4457' : '#e5e7eb',
          boxShadow: 'inset 0 1px 2px rgba(0,0,0,.12)',
        }}
      >
        {/* sliding white knob — centered under the active half */}
        <span
          className="absolute rounded-full bg-white transition-transform duration-200"
          style={{
            top: 3, left: 4, width: 24, height: 24,
            boxShadow: '0 1px 3px rgba(0,0,0,.28)',
            transform: mode === 'dark' ? 'translateX(32px)' : 'translateX(0)',
          }}
        />
        {/* icons in two equal halves so each lines up with the knob */}
        <span className="relative grid h-full grid-cols-2 items-center justify-items-center" style={{ zIndex: 1 }}>
          <FiSun size={15} strokeWidth={2.4} color={mode === 'dark' ? '#94a3b8' : '#f59e0b'} />
          <FiMoon size={14} strokeWidth={2.4} color={mode === 'dark' ? '#6366f1' : '#94a3b8'} />
        </span>
      </button>
    </span>
  );
}
