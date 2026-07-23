// Route guard used by App.jsx to wrap the /admin and /employee portal trees.
// Redirects anonymous users to /login and users whose role isn't allowed to
// their own home portal; otherwise renders the wrapped route content.
import { Navigate, useLocation } from 'react-router-dom';
import { useAuthStore } from '../store/authStore';

/**
 * @param {object} props
 * @param {React.ReactNode} props.children  route element to render when allowed
 * @param {string[]} [props.roles]  roles permitted to access this route
 */
export default function ProtectedRoute({ children, roles }) {
  const user = useAuthStore((s) => s.user);
  const token = useAuthStore((s) => s.token);
  const location = useLocation();

  // Not signed in → login (remember where they were headed for post-login return).
  if (!token || !user) {
    return <Navigate to="/login" state={{ from: location }} replace />;
  }

  // Signed in but wrong role → bounce to the portal that role belongs in.
  if (roles && !roles.includes(user.role)) {
    const home = user.role === 'Employee' ? '/employee' : '/admin';
    return <Navigate to={home} replace />;
  }

  return children;
}
