// navigation/navRef.js — imperative navigation from outside React.
// Exposes a NavigationContainerRef so non-component code (a tapped push
// notification) can navigate, plus helpers that translate a backend
// notification's logical `link`/`type` into a concrete tab/screen destination.
import { createNavigationContainerRef } from '@react-navigation/native';

// Shared ref attached to the NavigationContainer in App.js.
export const navRef = createNavigationContainerRef();

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
  switch (link) {
    case 'chat':
      return { tab: 'Chat' };
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
    case 'leave':
      return { tab: 'Home' };
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
