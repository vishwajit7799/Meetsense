import { pool } from '../db/index.js';
import { getValidMsToken, graphFetch } from '../auth/microsoft.js';
import { scheduleBotForMeeting } from '../bot/scheduler.js';

export async function syncOutlookCalendar(user) {
  if (!user.ms_access_token) return;
  try {
    const token = await getValidMsToken(user);
    const now = new Date().toISOString();
    const end = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();

    const data = await graphFetch(token,
      `/me/calendarView?startDateTime=${now}&endDateTime=${end}&$select=id,subject,start,end,onlineMeeting,bodyPreview,location&$top=20`
    );

    for (const event of (data.value || [])) {
      const meetingUrl = extractMeetingUrl(event);
      if (!meetingUrl) continue;

      const start = new Date(event.start.dateTime + (event.start.timeZone === 'UTC' ? 'Z' : ''));
      const end   = new Date(event.end.dateTime   + (event.end.timeZone   === 'UTC' ? 'Z' : ''));

      const result = await pool.query(
        `INSERT INTO meetings (user_id, external_id, subject, start_time, end_time, meeting_url, platform, status)
         VALUES ($1,$2,$3,$4,$5,$6,$7,'pending')
         ON CONFLICT (user_id, external_id) DO UPDATE
         SET subject=$3, start_time=$4, end_time=$5, meeting_url=$6
         WHERE meetings.status='pending'
         RETURNING *`,
        [user.id, event.id, event.subject || 'Meeting', start, end, meetingUrl, detectPlatform(meetingUrl)]
      );

      if (result.rows.length > 0) {
        await scheduleBotForMeeting(result.rows[0]);
      }
    }
  } catch (err) {
    console.error(`Outlook calendar sync failed for ${user.email}:`, err.message);
  }
}

function extractMeetingUrl(event) {
  if (event.onlineMeeting?.joinUrl) return event.onlineMeeting.joinUrl;
  const text = `${event.bodyPreview || ''} ${event.location?.displayName || ''}`;
  const patterns = [
    /https:\/\/teams\.microsoft\.com\/l\/meetup-join\/[^\s"<>]+/,
    /https:\/\/[\w.]*zoom\.us\/j\/[^\s"<>]+/,
    /https:\/\/meet\.google\.com\/[a-z-]{9,}/,
  ];
  for (const p of patterns) {
    const m = text.match(p);
    if (m) return m[0];
  }
  return null;
}

function detectPlatform(url) {
  if (url.includes('teams.microsoft.com'))  return 'teams';
  if (url.includes('zoom.us'))              return 'zoom';
  if (url.includes('meet.google.com'))      return 'meet';
  return 'unknown';
}
