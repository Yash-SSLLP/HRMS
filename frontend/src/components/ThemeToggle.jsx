// Dark/light theme switch, shared by the portal top bar and the login screen so
// both look and behave identically: a segmented track with a sliding white knob,
// an amber sun on the light side and an indigo moon on the dark side (the active
// icon lights up), and a circular-reveal transition of the whole page.
//
// The reveal uses the View Transitions API — the new theme wipes in as a circle
// expanding from the button. Falls back to an instant flip where the API is
// missing or the user prefers reduced motion.
import { flushSync } from 'react-dom';
import { FiSun, FiMoon } from 'react-icons/fi';
import { useThemeStore } from '../store/themeStore';

export default function ThemeToggle({ className = '' }) {
  const mode = useThemeStore((s) => s.mode);
  const toggleMode = useThemeStore((s) => s.toggle);

  const handleToggle = (e) => {
    const canAnimate =
      typeof document !== 'undefined' &&
      document.startViewTransition &&
      !window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (!canAnimate) { toggleMode(); return; }

    // Originate the reveal from the toggle's centre (not the raw cursor point) so
    // it's consistent wherever the button is clicked — and works for keyboard
    // activation, where clientX/Y would be 0,0.
    const rect = e.currentTarget.getBoundingClientRect();
    const x = rect.left + rect.width / 2;
    const y = rect.top + rect.height / 2;
    const endRadius = Math.hypot(Math.max(x, window.innerWidth - x), Math.max(y, window.innerHeight - y));
    const transition = document.startViewTransition(() => {
      // flushSync so the .dark class is on <html> before the "new" snapshot.
      flushSync(() => toggleMode());
    });
    transition.ready.then(() => {
      document.documentElement.animate(
        { clipPath: [`circle(0px at ${x}px ${y}px)`, `circle(${endRadius}px at ${x}px ${y}px)`] },
        { duration: 550, easing: 'cubic-bezier(.65, 0, .35, 1)', pseudoElement: '::view-transition-new(root)' }
      );
    }).catch(() => {});
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
