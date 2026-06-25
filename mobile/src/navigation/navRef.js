import { createNavigationContainerRef } from '@react-navigation/native';

export const navRef = createNavigationContainerRef();

// Map a notification's logical `link`/`type` to an in-app destination.
// Mirrors the backend notification `link` values ('chat', 'calendar',
// 'celebrations', …) used by the web portal.
export function routeForNotification(data = {}) {
  const link = data.link || data.type;
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
      return { tab: 'Home', screen: 'Recognition' };
    case 'leave':
      return { tab: 'Home' };
    default:
      return { tab: 'Alerts' };
  }
}

export function navigateFromNotification(data) {
  if (!navRef.isReady()) return;
  const { tab } = routeForNotification(data || {});
  try {
    navRef.navigate('Main', { screen: tab });
  } catch {
    /* navigation not mounted yet */
  }
}
