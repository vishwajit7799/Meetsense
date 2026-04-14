import { graphFetch, refreshAccessToken } from '../auth/microsoft.js';
import { pool } from '../db/index.js';
import { scheduleBotForMeeting } from '../bot/scheduler.js';

/**
 * Sync upcoming calendar events for a user.
 * Runs every 5 minutes via cron.
 */
export async function syncCalendar(user) {
  try {
    const accessToken = await getValidToken(user);
    const now   = new Date();
    const end   = new Date(Date.now() + 24 * 60 * 60 * 1000); // next 24 hours

    const data = await graphFetch(
      accessToken,
      `/me/calendarView?startDateTime=${now.toISOString()}&endDateTime=${end.toISOString()}&$select=id,subject,start,end,onlineMeeting,location,bodyPreview&$top=20`
    );

    const events = data.value || [];
    console.log(`📅 [${user.email}] Found ${events.length} upcoming events`);

    for (const event of events) {
      const meetingUrl = extractMeetingUrl(event);
      if (!meetingUrl) continue; // skip non-video meetings

      await upsertMeeting(user.id, event, meetingUrl);
    }
  } catch (err) {
    console.error(`❌ Calendar sync failed for ${user.email}:`, err.message);
  }
}

/**
 * Extract Teams/Zoom/Meet URL from a calendar event
 */
function extractMeetingUrl(event) {
  // Teams meeting — official field
  if (event.onlineMeeting?.joinUrl) return event.onlineMeeting.joinUrl;

  // Search body/location for any video meeting URL
  const text = `${event.bodyPreview || ''} ${event.location?.displayName || ''}`;
  const patterns = [
    /https:\/\/teams\.microsoft\.com\/l\/meetup-join\/[^\s"<>]+/,
    /https:\/\/[\w.]*zoom\.us\/j\/[^\s"<>]+/,
    /https:\/\/meet\.google\.com\/[a-z-]{9,}/,
  ];
  for (const p of patterns) {
    const match = text.match(p);
    if (match) return match[0];
  }
  return null;
}

/**
 * Save or update a meeting in the database
 */
async function upsertMeeting(userId, event, meetingUrl) {
  const start = new Date(event.start.dateTime + (event.start.timeZone === 'UTC' ? 'Z' : ''));
  const end   = new Date(event.end.dateTime   + (event.end.timeZone   === 'UTC' ? 'Z' : ''));

  const result = await pool.query(
    `INSERT INTO meetings (user_id, ms_event_id, subject, start_time, end_time, meeting_url, status)
     VALUES ($1, $2, $3, $4, $5, $6, 'pending')
     ON CONFLICT (user_id, ms_event_id)
     DO UPDATE SET subject=$3, start_time=$4, end_time=$5, meeting_url=$6
     WHERE meetings.status = 'pending'
     RETURNING *`,
    [userId, event.id, event.subject || 'Untitled Meeting', start, end, meetingUrl]
  );

  if (result.rows.length > 0) {
    console.log(`📌 Queued: "${result.rows[0].subject}" at ${start.toLocaleTimeString()}`);
    await scheduleBotForMeeting(result.rows[0]);
  }
}

/**
 * Get a valid (non-expired) access token, refreshing if needed
 */
async function getValidToken(user) {
  if (user.token_expiry && new Date(user.token_expiry) > new Date(Date.now() + 60000)) {
    return user.access_token;
  }
  // Refresh the token
  const result = await refreshAccessToken(user.refresh_token);
  await pool.query(
    `UPDATE users SET access_token=$1, token_expiry=$2 WHERE id=$3`,
    [result.accessToken, result.expiresOn, user.id]
  );
  return result.accessToken;
}

/**
 * Sync calendars for all active users — called by cron job
 */
export async function syncAllUsers() {
  const { rows: users } = await pool.query(
    `SELECT * FROM users WHERE refresh_token IS NOT NULL`
  );
  console.log(`🔄 Syncing calendars for ${users.length} user(s)...`);
  await Promise.allSettled(users.map(syncCalendar));
}
