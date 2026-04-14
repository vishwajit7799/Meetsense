import { pool } from '../db/index.js';
import { getValidGoogleToken } from '../auth/google.js';
import { scheduleBotForMeeting } from '../bot/scheduler.js';

export async function syncGoogleCalendar(user) {
  try {
    const token = await getValidGoogleToken(user);
    const now = new Date().toISOString();
    const end = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();

    const res = await fetch(
      `https://www.googleapis.com/calendar/v3/calendars/primary/events?timeMin=${now}&timeMax=${end}&singleEvents=true&orderBy=startTime&maxResults=20`,
      { headers: { Authorization: `Bearer ${token}` } }
    );
    const data = await res.json();
    const events = data.items || [];

    for (const event of events) {
      const meetingUrl = extractMeetingUrl(event);
      if (!meetingUrl) continue;

      const start = new Date(event.start.dateTime || event.start.date);
      const end   = new Date(event.end.dateTime   || event.end.date);

      const result = await pool.query(
        `INSERT INTO meetings (user_id, external_id, subject, start_time, end_time, meeting_url, platform, status)
         VALUES ($1,$2,$3,$4,$5,$6,$7,'pending')
         ON CONFLICT (user_id, external_id) DO UPDATE
         SET subject=$3, start_time=$4, end_time=$5, meeting_url=$6
         WHERE meetings.status='pending'
         RETURNING *`,
        [user.id, event.id, event.summary || 'Meeting', start, end, meetingUrl, detectPlatform(meetingUrl)]
      );

      if (result.rows.length > 0) {
        await scheduleBotForMeeting(result.rows[0]);
      }
    }
  } catch (err) {
    console.error(`Google calendar sync failed for ${user.email}:`, err.message);
  }
}

function extractMeetingUrl(event) {
  if (event.hangoutLink) return event.hangoutLink;
  const text = `${event.description || ''} ${event.location || ''}`;
  const patterns = [
    /https:\/\/meet\.google\.com\/[a-z-]{9,}/,
    /https:\/\/teams\.microsoft\.com\/l\/meetup-join\/[^\s"<>]+/,
    /https:\/\/[\w.]*zoom\.us\/j\/[^\s"<>]+/,
  ];
  for (const p of patterns) {
    const m = text.match(p);
    if (m) return m[0];
  }
  return null;
}

function detectPlatform(url) {
  if (url.includes('meet.google.com'))    return 'meet';
  if (url.includes('teams.microsoft.com')) return 'teams';
  if (url.includes('zoom.us'))            return 'zoom';
  return 'unknown';
}
