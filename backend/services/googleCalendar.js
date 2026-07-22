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

function isConfigured() {
  return Boolean(
    process.env.GOOGLE_OAUTH_CLIENT_ID &&
      process.env.GOOGLE_OAUTH_CLIENT_SECRET &&
      process.env.GOOGLE_OAUTH_REFRESH_TOKEN
  );
}

// Cache the short-lived access token until shortly before it expires.
let cached = { token: null, expiresAt: 0 };

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
    throw new Error(`Google OAuth token refresh failed: ${json.error_description || json.error || res.status}`);
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

module.exports = { isConfigured, createMeetEvent, getAccessToken };
