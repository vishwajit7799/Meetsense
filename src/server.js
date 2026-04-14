import 'dotenv/config';
import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import cron from 'node-cron';
import { initDB, pool } from './db/index.js';
import { getAuthUrl, exchangeCode, graphFetch } from './auth/microsoft.js';
import { syncAllUsers } from './calendar/watcher.js';
import { rescheduleOnStartup } from './bot/scheduler.js';
import { sendWelcomeEmail } from './email/sender.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, '../public')));

// ─── Simple session via signed cookie ───────────────────
const sessions = new Map(); // sessionId → userId (in-memory; use Redis for prod)
function createSession(userId) {
  const id = crypto.randomUUID();
  sessions.set(id, userId);
  return id;
}
function getSession(req) {
  const sid = req.headers['x-session-id'] || req.query.sid;
  return sid ? sessions.get(sid) : null;
}

// ─── AUTH ROUTES ─────────────────────────────────────────
app.get('/auth/login', async (req, res) => {
  const state = crypto.randomUUID();
  const url   = await getAuthUrl(state);
  res.redirect(url);
});

app.get('/auth/callback', async (req, res) => {
  const { code, error } = req.query;
  if (error) return res.redirect('/?error=' + encodeURIComponent(error));

  try {
    const result = await exchangeCode(code);
    const { accessToken, refreshToken, expiresOn, account } = result;

    // Fetch user profile from Graph
    const profile = await graphFetch(accessToken, '/me?$select=id,displayName,mail,userPrincipalName');
    const email   = profile.mail || profile.userPrincipalName;
    const name    = profile.displayName;
    const msId    = profile.id;

    // Upsert user
    const { rows } = await pool.query(
      `INSERT INTO users (email, name, ms_user_id, access_token, refresh_token, token_expiry)
       VALUES ($1,$2,$3,$4,$5,$6)
       ON CONFLICT (email) DO UPDATE
       SET name=$2, ms_user_id=$3, access_token=$4, refresh_token=$5, token_expiry=$6
       RETURNING id, email, name`,
      [email, name, msId, accessToken, refreshToken, expiresOn]
    );

    const user = rows[0];
    const isNew = result.fromCache === false;

    if (isNew) {
      await sendWelcomeEmail(user.email, user.name).catch(() => {});
    }

    // Trigger first calendar sync immediately
    syncAllUsers().catch(() => {});

    const sid = createSession(user.id);
    res.redirect(`/dashboard?sid=${sid}&name=${encodeURIComponent(user.name || '')}`);

  } catch (err) {
    console.error('Auth callback error:', err.message);
    res.redirect('/?error=auth_failed');
  }
});

app.get('/auth/logout', (req, res) => {
  const sid = req.query.sid;
  if (sid) sessions.delete(sid);
  res.redirect('/');
});

// ─── API ROUTES ───────────────────────────────────────────
app.get('/api/me', async (req, res) => {
  const userId = getSession(req);
  if (!userId) return res.status(401).json({ error: 'Not authenticated' });
  const { rows } = await pool.query('SELECT id, email, name, created_at FROM users WHERE id=$1', [userId]);
  res.json(rows[0] || null);
});

app.get('/api/meetings', async (req, res) => {
  const userId = getSession(req);
  if (!userId) return res.status(401).json({ error: 'Not authenticated' });
  const { rows } = await pool.query(
    `SELECT id, subject, start_time, end_time, status, summary, created_at
     FROM meetings WHERE user_id=$1
     ORDER BY start_time DESC LIMIT 50`,
    [userId]
  );
  res.json(rows);
});

app.get('/api/meetings/:id', async (req, res) => {
  const userId = getSession(req);
  if (!userId) return res.status(401).json({ error: 'Not authenticated' });
  const { rows } = await pool.query(
    `SELECT * FROM meetings WHERE id=$1 AND user_id=$2`,
    [req.params.id, userId]
  );
  if (!rows.length) return res.status(404).json({ error: 'Not found' });
  res.json(rows[0]);
});

app.get('/api/stats', async (req, res) => {
  const userId = getSession(req);
  if (!userId) return res.status(401).json({ error: 'Not authenticated' });
  const { rows } = await pool.query(
    `SELECT
       COUNT(*) FILTER (WHERE status='completed') AS completed,
       COUNT(*) FILTER (WHERE status='pending' OR status='joining' OR status='in_progress') AS upcoming,
       COUNT(*) AS total
     FROM meetings WHERE user_id=$1`,
    [userId]
  );
  res.json(rows[0]);
});

// ─── CRON: sync calendars every 5 minutes ─────────────────
cron.schedule('*/5 * * * *', () => {
  syncAllUsers().catch(err => console.error('Cron sync error:', err.message));
});

// ─── STARTUP ──────────────────────────────────────────────
const PORT = process.env.PORT || 3000;

(async () => {
  await initDB();
  await rescheduleOnStartup();
  await syncAllUsers().catch(() => {});
  app.listen(PORT, () => {
    console.log(`\n🚀 MeetSense running on http://localhost:${PORT}`);
    console.log(`   Connect your calendar: http://localhost:${PORT}/auth/login`);
  });
})();
