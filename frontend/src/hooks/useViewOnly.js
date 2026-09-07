import { useAuthStore } from '../store/authStore';
import { isViewOnly as isViewOnlyUser } from '../config/permissions';

/**
 * Can the signed-in account change anything at all?
 *
 * `true` for the God audit login and for a CEO/MD still in the default
 * view-only mode. Use it to decide whether to RENDER a write control:
 *
 *   const viewOnly = useViewOnly();
 *   {!viewOnly && <button onClick={remove}>Delete</button>}
 *
 * WHY A HOOK RATHER THAN THE HELPER DIRECTLY. Every page already reaches for
 * `useAuthStore` and then re-derives the same boolean, and a page that derives
 * it slightly differently is exactly how a write button survives an audit. One
 * import, one boolean, one place to change if the rule ever moves.
 *
 * THIS IS THE PRESENTATION LAYER ONLY. Two enforcement layers sit under it and
 * neither depends on a page remembering to call this: the request interceptor
 * in api/client.js refuses the call before it leaves the browser, and `protect`
 * in backend/middleware/authMiddleware.js refuses it before any route runs. So
 * forgetting this hook makes a button useless and confusing, never dangerous.
 *
 * @returns {boolean}
 */
export function useViewOnly() {
  return useAuthStore((s) => isViewOnlyUser(s.user));
}

export default useViewOnly;
