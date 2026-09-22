/**
 * The colour of one task — asked once, answered the same way everywhere.
 *
 * NEW 2026-09-22. The list, the board card, the modal and the detail header all
 * paint a task with its accent, and before this each of them worked the colour
 * out for itself. Four copies of the same `if (completed) green` is how a red
 * in one place becomes a slightly different red in another, and nobody notices
 * until two of them are on screen at once.
 *
 * THE SERVER DECIDES. `config/tasks.accentFor` runs on every row the API sends
 * and arrives as `task.accent` — `{ key, ink, bg, border, solid }` — so the
 * phone and the browser cannot drift. The palette below is a FALLBACK, for a
 * row that never went through `decorate()`: one just posted back from a form,
 * an optimistic update, a child stitched in client-side. It is a copy of
 * `config/tasks.PRIORITY_COLORS`, and if you are changing it you are changing
 * the wrong file.
 */
import { useThemeStore } from '../../store/themeStore';
import { normalisePriority, DEFAULT_PRIORITY } from '../../utils/taskLifecycle';

/** Mirrors backend/config/tasks.js — see the note above before editing. */
export const PRIORITY_COLORS = {
  Urgent: { ink: '#B42318', bg: '#FEF3F2', border: '#FDA29B', solid: '#D92D20' },
  Medium: { ink: '#B54708', bg: '#FFFAEB', border: '#FEC84B', solid: '#F79009' },
  Low: { ink: '#475467', bg: '#F2F4F7', border: '#D0D5DD', solid: '#98A2B3' },
};

export const DONE_COLOR = { ink: '#027A48', bg: '#ECFDF3', border: '#6CE9A6', solid: '#12B76A' };
export const CANCELLED_COLOR = { ink: '#667085', bg: '#F9FAFB', border: '#EAECF0', solid: '#98A2B3' };

/** The palette for a priority on its own, where there is no task to ask. */
export function priorityColor(priority) {
  const key = normalisePriority(priority) || DEFAULT_PRIORITY;
  return { key, ...(PRIORITY_COLORS[key] || PRIORITY_COLORS[DEFAULT_PRIORITY]) };
}

/** Does the row carry a usable palette, or only the shell of one? */
const served = (accent) =>
  Boolean(accent && accent.solid && accent.bg && accent.border && accent.ink);

/**
 * The accent for one task: `{ key, ink, bg, border, solid }`.
 *
 * `key` is `'Urgent' | 'Medium' | 'Low' | 'DONE' | 'CANCELLED'` — what a
 * component keys off when it needs to know WHY it is that colour (the faded
 * cancelled row, the green done card) rather than merely what the colour is.
 */
export function accentFor(task) {
  if (served(task?.accent)) {
    return { key: task.accent.key || fallbackKey(task), ...task.accent };
  }
  const key = fallbackKey(task);
  if (key === 'DONE') return { key, ...DONE_COLOR };
  if (key === 'CANCELLED') return { key, ...CANCELLED_COLOR };
  return priorityColor(task?.priority);
}

function fallbackKey(task) {
  if (task?.status === 'COMPLETED') return 'DONE';
  if (task?.status === 'CANCELLED') return 'CANCELLED';
  return normalisePriority(task?.priority) || DEFAULT_PRIORITY;
}

/**
 * The tinted row or card, as an inline style.
 *
 * `{ dark: true }` swaps the flat light hexes for the same colours mixed into
 * the surface. #FEF3F2 on a #17181d card is a white slab; 12% of #D92D20 over
 * `var(--surface)` is the same idea rendered for whatever surface it lands on,
 * which is why the mix names the token rather than a second hex.
 *
 * The border is written as one longhand set instead of `borderLeft` beside
 * `borderColor`: React warns when a shorthand and a longhand for the same
 * property are both present, and the warning is right — which of them wins
 * depends on the key order, and key order is not something a caller should
 * have to think about.
 */
export function accentStyle(task, { dark = false, rail = 4 } = {}) {
  const a = accentFor(task);
  const bg = dark ? `color-mix(in srgb, ${a.solid} 12%, var(--surface))` : a.bg;
  const line = dark ? `color-mix(in srgb, ${a.solid} 34%, var(--surface))` : a.border;
  return {
    backgroundColor: bg,
    borderStyle: 'solid',
    borderWidth: `1px 1px 1px ${rail}px`,
    borderColor: `${line} ${line} ${line} ${a.solid}`,
    // A called-off task is still readable, but it should not compete with the
    // work that is still live.
    ...(a.key === 'CANCELLED' ? { opacity: 0.6 } : null),
  };
}

/**
 * A chip painted from the same palette — the priority chip, a points pill on a
 * tinted card. Takes a `{ ink, bg, border, solid }`, not a task, because the
 * thing being tinted is often not a whole row.
 */
export function tintStyle(colour, { dark = false } = {}) {
  if (!colour) return {};
  return dark
    ? {
      backgroundColor: `color-mix(in srgb, ${colour.solid} 18%, var(--surface))`,
      borderColor: `color-mix(in srgb, ${colour.solid} 40%, var(--surface))`,
      color: colour.solid,
    }
    : { backgroundColor: colour.bg, borderColor: colour.border, color: colour.ink };
}

/**
 * Which theme we are in, reactively.
 *
 * Reading `document.documentElement.classList` would be correct and would
 * never re-render: the class is applied by an effect in App.jsx from this same
 * store, so the store is the thing that actually changes.
 */
export const useIsDark = () => useThemeStore((s) => s.mode === 'dark');

/** `accentStyle` with the theme already applied. What a row should call. */
export function useAccentStyle(task, options = {}) {
  const dark = useIsDark();
  return accentStyle(task, { ...options, dark });
}

/** `tintStyle` with the theme already applied. */
export function useTintStyle(colour) {
  const dark = useIsDark();
  return tintStyle(colour, { dark });
}
