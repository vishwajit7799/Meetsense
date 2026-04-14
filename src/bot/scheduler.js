import { pool } from '../db/index.js';
import { runBot } from './runner.js';

const scheduledJobs = new Map(); // meetingId → timeoutId

/**
 * Schedule a bot to join a meeting 2 minutes before it starts.
 * Safe to call multiple times — deduplicates automatically.
 */
export async function scheduleBotForMeeting(meeting) {
  if (scheduledJobs.has(meeting.id)) return; // already scheduled

  const now       = Date.now();
  const startMs   = new Date(meeting.start_time).getTime();
  const joinMs    = startMs - 2 * 60 * 1000; // 2 min early
  const delayMs   = Math.max(0, joinMs - now);

  if (startMs < now) {
    console.log(`⏭️  Skipping past meeting: "${meeting.subject}"`);
    return;
  }

  const minutesUntil = Math.round(delayMs / 60000);
  console.log(`⏰ Bot scheduled for "${meeting.subject}" in ${minutesUntil} min`);

  const timeoutId = setTimeout(async () => {
    scheduledJobs.delete(meeting.id);
    await runBot(meeting);
  }, delayMs);

  scheduledJobs.set(meeting.id, timeoutId);
}

/**
 * On server restart, reschedule all pending meetings that haven't started yet
 */
export async function rescheduleOnStartup() {
  const { rows } = await pool.query(
    `SELECT m.*, u.email as user_email
     FROM meetings m
     JOIN users u ON u.id = m.user_id
     WHERE m.status = 'pending'
     AND m.start_time > NOW() - INTERVAL '10 minutes'`
  );
  console.log(`🔁 Rescheduling ${rows.length} pending meeting(s) from previous session`);
  for (const meeting of rows) {
    await scheduleBotForMeeting(meeting);
  }
}
