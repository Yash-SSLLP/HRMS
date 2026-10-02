/**
 * Google Calendar + Meet integration (zero-dependency, uses global fetch).
 *
 * Creates a Calendar event with a real Google Meet conference link and adds the
 * candidate / interviewer / HR as attendees. With sendUpdates=all, Google emails
 * every attendee the invite *including* the Meet link — so nobody has to ask for
 * a link.
 *
 * Auth is OAuth 2.0 with a long-lived refresh token (no service account, so it
 * works without Workspace domain-wide delegation). Configure via env:
 *   GOOGLE_OAUTH_CLIENT_ID
 *   GOOGLE_OAUTH_CLIENT_SECRET
 *   GOOGLE_OAUTH_REFRESH_TOKEN     (see scripts/getGoogleRefreshToken.js)
 *   GOOGLE_CALENDAR_ID             (optional, defaults to 'primary')
 *
 * When unconfigured, isConfigured() is false and callers fall back gracefully.
 */
const crypto = require('crypto');

const TOKEN_URL = 'https://oauth2.googleapis.com/token';

/**
 * Whether the Google OAuth credentials needed for Calendar/Gmail are all present.
 * @returns {boolean} True when client id, secret, and refresh token are all set.
 */
function isConfigured() {
  return Boolean(
    process.env.GOOGLE_OAUTH_CLIENT_ID &&
      process.env.GOOGLE_OAUTH_CLIENT_SECRET &&
      process.env.GOOGLE_OAUTH_REFRESH_TOKEN
  );
}

// Cache the short-lived access token until shortly before it expires.
let cached = { token: null, expiresAt: 0 };

/**
 * Get a valid short-lived OAuth access token, refreshing via the refresh-token
 * grant when the cached one is missing or within 60s of expiry. Shared by the
 * Calendar and Gmail services.
 * @returns {Promise<string>} A bearer access token.
 * @throws {Error} If the token refresh request fails.
 * @sideEffects Network call to Google's OAuth token endpoint; updates the module cache.
 */
async function getAccessToken() {
  if (cached.token && Date.now() < cached.expiresAt - 60_000) return cached.token;

  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: process.env.GOOGLE_OAUTH_CLIENT_ID,
      client_secret: process.env.GOOGLE_OAUTH_CLIENT_SECRET,
      refresh_token: process.env.GOOGLE_OAUTH_REFRESH_TOKEN,
      grant_type: 'refresh_token',
    }),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok || !json.access_token) {
    const detail = json.error_description || json.error || res.status;
    const err = new Error(`Google OAuth token refresh failed: ${detail}`);
    // `invalid_grant` means the refresh token is expired, revoked, or was issued
    // to different credentials. No amount of retrying fixes it — a human has to
    // re-authorise (scripts/getGoogleRefreshToken.js). Flag it so callers can
    // stop burning their retry budget on it. NOTE: if the Google Cloud consent
    // screen is still in "Testing", refresh tokens expire after 7 days; publish
    // the app to stop this recurring weekly.
    if (json.error === 'invalid_grant') err.permanent = true;
    throw err;
  }
  cached = { token: json.access_token, expiresAt: Date.now() + (json.expires_in || 3600) * 1000 };
  return cached.token;
}

/**
 * Create a Google Calendar event with a Meet link and invite attendees.
 * @param {{summary:string, description?:string, start:Date, end:Date, attendees?:string[]}} opts
 * @returns {Promise<{meetingLink:string, eventId:string, htmlLink:string}>}
 */
async function createMeetEvent({ summary, description, start, end, attendees = [] }) {
  if (!isConfigured()) throw new Error('Google Calendar is not configured on the server.');

  const token = await getAccessToken();
  const calendarId = encodeURIComponent(process.env.GOOGLE_CALENDAR_ID || 'primary');

  const uniqueEmails = [...new Set(attendees.filter((e) => e && /@/.test(e)).map((e) => e.trim().toLowerCase()))];

  const body = {
    summary,
    description: description || '',
    start: { dateTime: new Date(start).toISOString(), timeZone: 'Asia/Kolkata' },
    end: { dateTime: new Date(end).toISOString(), timeZone: 'Asia/Kolkata' },
    attendees: uniqueEmails.map((email) => ({ email })),
    reminders: { useDefault: true },
    conferenceData: {
      createRequest: {
        requestId: crypto.randomUUID(),
        conferenceSolutionKey: { type: 'hangoutsMeet' },
      },
    },
  };

  const url =
    `https://www.googleapis.com/calendar/v3/calendars/${calendarId}/events` +
    `?conferenceDataVersion=1&sendUpdates=all`;

  const res = await fetch(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const ev = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(`Google Calendar event creation failed: ${ev.error?.message || res.status}`);
  }

  const meetingLink =
    ev.hangoutLink ||
    ev.conferenceData?.entryPoints?.find((p) => p.entryPointType === 'video')?.uri ||
    '';

  if (!meetingLink) throw new Error('Event created but no Meet link was returned.');

  return { meetingLink, eventId: ev.id, htmlLink: ev.htmlLink };
}

/**
 * Move an existing event to a new start/end (a rescheduled interview). The Meet
 * link and attendees are untouched; with sendUpdates=all Google emails every
 * attendee the new time, exactly as it sent the original invite.
 * @param {string} eventId - the id createMeetEvent returned
 * @param {Date} start
 * @param {Date} end
 * @returns {Promise<void>}
 * @throws {Error} when unconfigured or Google refuses the update
 */
async function moveEvent(eventId, start, end) {
  if (!isConfigured()) throw new Error('Google Calendar is not configured on the server.');
  if (!eventId) throw new Error('No calendar event to move.');

  const token = await getAccessToken();
  const calendarId = encodeURIComponent(process.env.GOOGLE_CALENDAR_ID || 'primary');
  const url =
    `https://www.googleapis.com/calendar/v3/calendars/${calendarId}/events/${encodeURIComponent(eventId)}` +
    `?sendUpdates=all`;

  const res = await fetch(url, {
    method: 'PATCH',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      start: { dateTime: new Date(start).toISOString(), timeZone: 'Asia/Kolkata' },
      end: { dateTime: new Date(end).toISOString(), timeZone: 'Asia/Kolkata' },
    }),
  });
  if (!res.ok) {
    const ev = await res.json().catch(() => ({}));
    throw new Error(`Google Calendar event update failed: ${ev.error?.message || res.status}`);
  }
}

/**
 * Change an existing event in place — any of its title, description, times and
 * attendee list (a training rescheduled, renamed, or with people added or taken
 * off). The Meet link is untouched. With sendUpdates=all Google emails the
 * change: new attendees get the invite, removed ones a cancellation, everyone
 * else the update — the same channel that delivered the original invite.
 * @param {string} eventId - the id createMeetEvent returned
 * @param {{summary?:string, description?:string, start?:Date, end?:Date, attendees?:string[]}} patch
 *   only the keys present are changed; `attendees` REPLACES the list
 * @returns {Promise<void>}
 * @throws {Error} when unconfigured or Google refuses the update
 */
async function updateEvent(eventId, patch = {}) {
  if (!isConfigured()) throw new Error('Google Calendar is not configured on the server.');
  if (!eventId) throw new Error('No calendar event to update.');

  const body = {};
  if (patch.summary !== undefined) body.summary = patch.summary;
  if (patch.description !== undefined) body.description = patch.description || '';
  if (patch.start) body.start = { dateTime: new Date(patch.start).toISOString(), timeZone: 'Asia/Kolkata' };
  if (patch.end) body.end = { dateTime: new Date(patch.end).toISOString(), timeZone: 'Asia/Kolkata' };
  if (Array.isArray(patch.attendees)) {
    const unique = [...new Set(patch.attendees.filter((e) => e && /@/.test(e)).map((e) => e.trim().toLowerCase()))];
    body.attendees = unique.map((email) => ({ email }));
  }
  if (!Object.keys(body).length) return;

  const token = await getAccessToken();
  const calendarId = encodeURIComponent(process.env.GOOGLE_CALENDAR_ID || 'primary');
  const url =
    `https://www.googleapis.com/calendar/v3/calendars/${calendarId}/events/${encodeURIComponent(eventId)}` +
    `?sendUpdates=all`;
  const res = await fetch(url, {
    method: 'PATCH',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const ev = await res.json().catch(() => ({}));
    throw new Error(`Google Calendar event update failed: ${ev.error?.message || res.status}`);
  }
}

/**
 * Delete an event (a training called off, or deleted outright). Attendees get
 * Google's cancellation email. An event that is already gone (404/410) counts
 * as deleted — the goal state is reached either way.
 * @param {string} eventId
 * @returns {Promise<void>}
 * @throws {Error} when unconfigured or Google refuses for any other reason
 */
async function deleteEvent(eventId) {
  if (!isConfigured()) throw new Error('Google Calendar is not configured on the server.');
  if (!eventId) return;

  const token = await getAccessToken();
  const calendarId = encodeURIComponent(process.env.GOOGLE_CALENDAR_ID || 'primary');
  const url =
    `https://www.googleapis.com/calendar/v3/calendars/${calendarId}/events/${encodeURIComponent(eventId)}` +
    `?sendUpdates=all`;
  const res = await fetch(url, { method: 'DELETE', headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok && res.status !== 404 && res.status !== 410) {
    const ev = await res.json().catch(() => ({}));
    throw new Error(`Google Calendar event delete failed: ${ev.error?.message || res.status}`);
  }
}

module.exports = { isConfigured, createMeetEvent, moveEvent, updateEvent, deleteEvent, getAccessToken };
