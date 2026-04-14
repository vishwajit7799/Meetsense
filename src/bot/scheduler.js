import { pool } from '../db/index.js';
import { runBot } from './runner.js';

const scheduled = new Map();

export async function scheduleBotForMeeting(meeting) {
  if (scheduled.has(meeting.id)) return;

  const now     = Date.now();
  const startMs = new Date(meeting.start_time).getTime();
  const joinMs  = startMs - 2 * 60 * 1000;
  const delay   = Math.max(0, joinMs - now);

  if (startMs < now - 10 * 60 * 1000) return; // skip if started >10min ago

  console.log(`⏰ Bot scheduled: "${meeting.subject}" in ${Math.round(delay/60000)}min`);

  const tid = setTimeout(async () => {
    scheduled.delete(meeting.id);
    await runBot(meeting);
  }, delay);

  scheduled.set(meeting.id, tid);
}

export async function rescheduleOnStartup() {
  const { rows } = await pool.query(
    `SELECT m.*, u.email as user_email
     FROM meetings m JOIN users u ON u.id = m.user_id
     WHERE m.status = 'pending'
     AND m.start_time > NOW() - INTERVAL '10 minutes'`
  );
  console.log(`🔁 Rescheduling ${rows.length} pending meetings`);
  for (const m of rows) await scheduleBotForMeeting(m);
}
