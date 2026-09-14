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
const { refreshAccessToken } = require('./googleOAuth');

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

/**
 * Get a valid short-lived OAuth access token for the COMPANY credential
 * (GOOGLE_OAUTH_REFRESH_TOKEN), refreshing when the cached one is missing or
 * within 60s of expiry. Shared by the Calendar service and the company-mailbox
 * path of the Gmail service; a person's own connected mailbox goes through
 * services/googleOAuth.refreshAccessToken with their own token instead.
 * @returns {Promise<string>} A bearer access token.
 * @throws {Error} If the token refresh request fails. `err.permanent` is set on
 *   invalid_grant — the token is expired, revoked, or was issued to different
 *   credentials, and a human has to re-authorise (scripts/getGoogleRefreshToken.js).
 * @sideEffects Network call to Google's OAuth token endpoint; updates the shared cache.
 */
async function getAccessToken() {
  return refreshAccessToken(process.env.GOOGLE_OAUTH_REFRESH_TOKEN, 'company');
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

module.exports = { isConfigured, createMeetEvent, getAccessToken };
