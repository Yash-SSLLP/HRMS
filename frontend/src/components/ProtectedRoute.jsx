// Route guard used by App.jsx to wrap the /admin and /employee portal trees.
// Redirects anonymous users to /login and users whose role isn't allowed to
// their own home portal; otherwise renders the wrapped route content.
import { Navigate, useLocation } from 'react-router-dom';
import { useAuthStore } from '../store/authStore';
import { canUseAdminPortal } from '../config/permissions';

/**
 * @param {object} props
 * @param {React.ReactNode} props.children  route element to render when allowed
 * @param {string[]} [props.roles]  roles permitted to access this route
 * @param {boolean} [props.admin]  this is the /admin tree — a Manager may enter
 *   it only once a SuperAdmin has granted them at least one capability
 */
export default function ProtectedRoute({ children, roles, admin = false }) {
  const user = useAuthStore((s) => s.user);
  const token = useAuthStore((s) => s.token);
  const location = useLocation();

  // Not signed in → login (remember where they were headed for post-login return).
  if (!token || !user) {
    return <Navigate to="/login" state={{ from: location }} replace />;
  }

  // A SuperAdmin set this password, so at least two people know it: it is a way
  // back in, not a password to keep. Held here rather than only redirecting after
  // login, because the auth store is persisted — without this, typing /admin in
  // the address bar on the next page load would walk straight past the gate.
  if (user.mustChangePassword && location.pathname !== '/change-password') {
    return <Navigate to="/change-password" replace />;
  }

  const roleAllowed = !roles || roles.includes(user.role);
  // The admin tree lists Manager among its roles so a GRANTED manager can enter,
  // but the role by itself isn't enough — most Managers hold no capability.
  const allowed = roleAllowed && (!admin || canUseAdminPortal(user));

  if (!allowed) {
    // Bounce to the portal this account does belong in. Anyone who can't open
    // /admin goes to /employee — sending them to '/admin' (the old fallback for
    // every non-Employee role) bounced a Manager from /admin back to /admin,
    // which is an infinite redirect.
    const home = canUseAdminPortal(user) ? '/admin' : '/employee';
    return <Navigate to={home} replace />;
  }

  return children;
}
