// navigation/navRef.js — imperative navigation from outside React.
// Exposes a NavigationContainerRef so non-component code (a tapped push
// notification) can navigate, plus helpers that translate a backend
// notification's logical `link`/`type` into a concrete tab/screen destination.
import { createNavigationContainerRef } from '@react-navigation/native';
import { useAuth } from '../store/auth';

// Shared ref attached to the NavigationContainer in App.js.
export const navRef = createNavigationContainerRef();

// Home-stack screens reached from a stored web path (the backend puts the web
// portal's URL in `link`, e.g. '/employee/payslips'). Matched on the trailing
// segment so the /employee/… and /admin/… variants of a module both resolve:
// the app has one screen per module, and someone tapping an admin-side alert
// still wants that module rather than the notifications list.
//
// Only paths with a real mobile equivalent belong here. Admin-only web pages
// with no counterpart (password resets, complaints admin, '/admin/exits') are
// deliberately absent — routing those to the nearest employee screen would show
// the tapper their OWN record instead of the one the alert is about.
const PATH_SCREENS = {
  '/payslips': 'Payslips',
  '/payroll': 'Payslips',
  '/cashbook': 'Cashbook',
  '/expenses': 'Expenses',
  '/tasks': 'Tasks',
  '/shifts': 'Roster',
  '/exit': 'Resignation',
  '/approvals': 'MyApprovals',
};

// Home-stack screens reached from a bare slug, which arrives either as `link`
// ('leave', 'interviews', …) or, when the backend set no link, as `type`
// ('payroll', 'interview', 'cashbook', …). Both spellings are listed because
// the two fields do not use the same vocabulary.
const SLUG_SCREENS = {
  leave: 'Leave',
  interviews: 'MyInterviews',
  interview: 'MyInterviews',
  payroll: 'Payslips',
  payslip: 'Payslips',
  cashbook: 'Cashbook',
  expense: 'Expenses',
  attendance: 'Attendance',
  regularization: 'Regularization',
  regularizations: 'Regularization',
  announcement: 'Announcements',
  announcements: 'Announcements',
  change_request: 'ChangeRequest',
  'change-requests': 'ChangeRequest',
  task: 'Tasks',
  tasks: 'Tasks',
};

/**
 * Map a notification's logical `link`/`type` to an in-app destination.
 * Mirrors the backend notification `link` values ('chat', 'calendar',
 * 'celebrations', …) used by the web portal.
 * @param {object} [data] Notification payload ({ link, type, ... }).
 * @returns {{tab: string, screen?: string, params?: object}} Target route.
 */
export function routeForNotification(data = {}) {
  const link = data.link || data.type;
  // Course/learning links (web paths like /employee/learning/<id> or
  // /admin/courses?panel=…). Deep-link straight to the course when an id is present.
  if (data.type === 'course' || (typeof link === 'string' && (link.includes('/learning') || link.includes('/courses')))) {
    const m = typeof link === 'string' && link.match(/\/learning\/([a-f0-9]{24})/i);
    if (m) return { tab: 'Home', screen: 'CoursePlayer', params: { courseId: m[1] } };
    return { tab: 'Home', screen: 'Learning' };
  }
  // Web-path links ('/employee/expenses', '/admin/payroll', …).
  if (typeof link === 'string' && link.startsWith('/')) {
    const path = link.split('?')[0].replace(/\/+$/, '');
    const hit = Object.keys(PATH_SCREENS).find((suffix) => path.endsWith(suffix));
    if (hit) return { tab: 'Home', screen: PATH_SCREENS[hit] };
  }
  // Slug links, then the notification's `type` as a fallback — a payslip alert
  // carries type 'payroll' and no link at all, so without the second lookup it
  // would fall through to the notifications list.
  const slug = SLUG_SCREENS[link] || SLUG_SCREENS[data.type];
  if (slug) return { tab: 'Home', screen: slug };

  switch (link) {
    case 'chat':
      // The Chat tab only exists while the module is switched on. An old push
      // notification tapped after it was turned off would otherwise navigate to
      // a route that isn't registered.
      return useAuth.getState().features?.chatEnabled ? { tab: 'Chat' } : { tab: 'Alerts' };
    case 'calendar':
    case 'event':
    case 'holiday':
      return { tab: 'Calendar' };
    case 'celebrations':
    case 'birthday':
    case 'anniversary':
      return { tab: 'Calendar' };
    case 'recognition':
      // Monthly Rewards & Recognition — the winners show as a banner on the
      // dashboard (the old peer-recognition screen was removed).
      return { tab: 'Home' };
    // 'leave' is handled by SLUG_SCREENS above (it opens the Leave screen now,
    // not the bare dashboard), so it deliberately has no case here.
    default:
      return { tab: 'Alerts' };
  }
}

/**
 * Navigate to the destination for a tapped notification, if the navigator is
 * mounted. No-op when navigation isn't ready yet.
 * @param {object} data Notification payload.
 */
export function navigateFromNotification(data) {
  if (!navRef.isReady()) return;
  const { tab, screen, params } = routeForNotification(data || {});
  try {
    navRef.navigate('Main', { screen: tab, params: screen ? { screen, params } : undefined });
  } catch {
    /* navigation not mounted yet */
  }
}
