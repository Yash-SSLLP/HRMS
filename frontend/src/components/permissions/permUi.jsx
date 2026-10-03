/**
 * Small pieces shared by every Permissions tab (2026-10-03 redesign): the
 * person avatar (their uploaded photo, initials until it loads or when there is
 * none) and the role chip.
 * Styling is the `.prm-*` block in index.css.
 */
import AuthImage from '../AuthImage';
import { roleLabel } from '../../config/roles';

/**
 * Role chips are the ONE place a colour carries information on these screens:
 * which kind of account this is. Tints only (`bg-*-50` + `text-*-700`), never a
 * filled chip, so a column of them reads as labels rather than as buttons — and
 * every hue here has a dark-mode remap in index.css.
 */
export const ROLE_TONES = {
  SuperAdmin: 'bg-violet-50 text-violet-700 border-violet-200',
  HRManager: 'bg-teal-50 text-teal-700 border-teal-200',
  CEO: 'bg-amber-50 text-amber-800 border-amber-200',
  MD: 'bg-amber-50 text-amber-800 border-amber-200',
  Manager: 'bg-indigo-50 text-indigo-700 border-indigo-200',
  LDManager: 'bg-sky-50 text-sky-700 border-sky-200',
  AccountsManager: 'bg-emerald-50 text-emerald-700 border-emerald-200',
  // gray, not slate: index.css remaps the gray family for dark mode and not
  // slate, so a slate chip stayed a white slab on the dark page.
  God: 'bg-gray-100 text-gray-700 border-gray-300',
  HRConsultancy: 'bg-orange-50 text-orange-700 border-orange-200',
  Employee: 'bg-gray-100 text-gray-600 border-gray-200',
};

export const initials = (u) => `${(u?.firstName || '')[0] || ''}${(u?.lastName || '')[0] || ''}`.toUpperCase() || '?';
export const fullName = (u) => `${u?.firstName || ''} ${u?.lastName || ''}`.trim();

export function RoleChip({ role }) {
  return (
    <span className={`inline-block px-2 py-0.5 text-[11px] font-semibold rounded-md border whitespace-nowrap ${ROLE_TONES[role] || ROLE_TONES.Employee}`}>
      {roleLabel(role)}
    </span>
  );
}

/**
 * The person's uploaded photo — the same URL (and so the same cached fetch) the
 * top bar and the dashboard use; `?p=` is the stored path, so a new upload is a
 * new key. Initials while it loads, and for anyone without one.
 * @param {{user: object, size?: 'sm'|'md'|'lg'}} props
 */
export function PersonAvatar({ user, size = 'md' }) {
  const cls = `prm-avatar${size === 'lg' ? ' is-lg' : size === 'sm' ? ' is-sm' : ''}`;
  const fallback = <span className={cls} aria-hidden="true">{initials(user)}</span>;
  const id = user?._id || user?.id;
  if (!user?.photo || !id) return fallback;
  return (
    <AuthImage
      url={`/auth/users/${id}/avatar?p=${encodeURIComponent(user.photo)}`}
      alt=""
      className={cls}
      fallback={fallback}
    />
  );
}
