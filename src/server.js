import 'dotenv/config';
import express from 'express';
import session from 'express-session';
import passport from 'passport';
import path from 'path';
import { fileURLToPath } from 'url';
import cron from 'node-cron';

import { initDB, pool } from './db/index.js';
import { setupGoogleAuth, getValidGoogleToken } from './auth/google.js';
import { getMsAuthUrl, exchangeMsCode, graphFetch } from './auth/microsoft.js';
import { syncGoogleCalendar } from './calendar/google.js';
import { syncOutlookCalendar } from './calendar/outlook.js';
import { rescheduleOnStartup } from './bot/scheduler.js';
import { createSubscription, handleWebhook, isSubscribed } from './payments/razorpay.js';
import { sendSummaryEmail, sendWelcomeEmail } from './email/sender.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();

// ── Middleware ─────────────────────────────────────────
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(session({
  secret: process.env.SESSION_SECRET || 'meetsense-secret',
  resave: false,
  saveUninitialized: false,
  cookie: { secure: process.env.NODE_ENV === 'production', maxAge: 30 * 24 * 60 * 60 * 1000 }
}));
app.use(passport.initialize());
app.use(passport.session());
setupGoogleAuth();
app.use(express.static(path.join(__dirname, '../public')));

// ── Auth helpers ───────────────────────────────────────
const requireAuth = (req, res, next) => {
  if (req.isAuthenticated()) return next();
  res.status(401).json({ error: 'Not authenticated' });
};

const requireSubscription = (req, res, next) => {
  if (isSubscribed(req.user)) return next();
  res.status(402).json({ error: 'Subscription required', redirect: '/pricing' });
};

const requireAdmin = (req, res, next) => {
  if (req.user?.email === process.env.ADMIN_EMAIL) return next();
  res.status(403).json({ error: 'Forbidden' });
};

// ── Google OAuth ───────────────────────────────────────
app.get('/auth/google',
  passport.authenticate('google', {
    scope: ['profile', 'email', 'https://www.googleapis.com/auth/calendar.readonly'],
    accessType: 'offline', prompt: 'consent'
  })
);

app.get('/auth/google/callback',
  passport.authenticate('google', { failureRedirect: '/?error=auth_failed' }),
  async (req, res) => {
    const isNew = !req.user.subscription_status || req.user.created_at > new Date(Date.now() - 5000);
    if (isNew) await sendWelcomeEmail(req.user.email, req.user.name).catch(() => {});
    syncGoogleCalendar(req.user).catch(() => {});
    res.redirect('/dashboard');
  }
);

// ── Microsoft OAuth ────────────────────────────────────
app.get('/auth/microsoft', async (req, res) => {
  if (!req.isAuthenticated()) return res.redirect('/');
  const url = await getMsAuthUrl(req.user.id);
  res.redirect(url);
});

app.get('/auth/microsoft/callback', async (req, res) => {
  if (!req.isAuthenticated()) return res.redirect('/');
  const { code } = req.query;
  try {
    const result  = await exchangeMsCode(code);
    const profile = await graphFetch(result.accessToken, '/me?$select=id,displayName,mail,userPrincipalName');
    await pool.query(
      `UPDATE users SET
         ms_user_id=$1, ms_access_token=$2,
         ms_refresh_token=$3, ms_token_expiry=$4
       WHERE id=$5`,
      [profile.id, result.accessToken, result.refreshToken, result.expiresOn, req.user.id]
    );
    syncOutlookCalendar({ ...req.user, ms_access_token: result.accessToken }).catch(() => {});
    res.redirect('/dashboard?ms=connected');
  } catch (err) {
    res.redirect('/dashboard?error=ms_auth_failed');
  }
});

app.get('/auth/logout', (req, res) => {
  req.logout(() => res.redirect('/'));
});

// ── User API ───────────────────────────────────────────
app.get('/api/me', requireAuth, (req, res) => {
  const { id, email, name, avatar, subscription_status, subscription_end, ms_user_id } = req.user;
  res.json({ id, email, name, avatar, subscription_status, subscription_end, ms_connected: !!ms_user_id });
});

app.get('/api/meetings', requireAuth, async (req, res) => {
  const { rows } = await pool.query(
    `SELECT id, subject, start_time, end_time, platform, status, summary, created_at
     FROM meetings WHERE user_id=$1 ORDER BY start_time DESC LIMIT 50`,
    [req.user.id]
  );
  res.json(rows);
});

app.get('/api/meetings/:id', requireAuth, async (req, res) => {
  const { rows } = await pool.query(
    'SELECT * FROM meetings WHERE id=$1 AND user_id=$2',
    [req.params.id, req.user.id]
  );
  if (!rows.length) return res.status(404).json({ error: 'Not found' });
  res.json(rows[0]);
});

app.get('/api/stats', requireAuth, async (req, res) => {
  const { rows } = await pool.query(
    `SELECT
       COUNT(*) FILTER (WHERE status='completed') AS completed,
       COUNT(*) FILTER (WHERE status IN ('pending','joining','in_progress')) AS upcoming,
       COUNT(*) AS total
     FROM meetings WHERE user_id=$1`,
    [req.user.id]
  );
  res.json(rows[0]);
});

// ── Payments ───────────────────────────────────────────
app.post('/api/subscribe', requireAuth, async (req, res) => {
  try {
    const sub = await createSubscription(req.user.id, req.user.email);
    res.json({ subscription_id: sub.id, short_url: sub.short_url });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Razorpay webhook — must be raw body
app.post('/api/webhook/razorpay', express.raw({ type: 'application/json' }), async (req, res) => {
  try {
    const sig = req.headers['x-razorpay-signature'];
    await handleWebhook(JSON.parse(req.body), sig);
    res.json({ ok: true });
  } catch (err) {
    console.error('Webhook error:', err.message);
    res.status(400).json({ error: err.message });
  }
});

// ── Support chatbot ────────────────────────────────────
app.post('/api/support', async (req, res) => {
  const { name, email, message } = req.body;
  if (!name || !email || !message) return res.status(400).json({ error: 'All fields required' });

  try {
    const nodemailer = await import('nodemailer');
    const transporter = nodemailer.default.createTransport({
      host: process.env.SMTP_HOST,
      port: parseInt(process.env.SMTP_PORT),
      auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS }
    });

    await transporter.sendMail({
      from:    process.env.EMAIL_FROM,
      to:      process.env.ADMIN_EMAIL,
      subject: `[MeetSense Support] Message from ${name}`,
      html: `
        <p><strong>From:</strong> ${name} &lt;${email}&gt;</p>
        <p><strong>Message:</strong></p>
        <p>${message.replace(/\n/g, '<br>')}</p>
        <hr>
        <p style="color:#888;font-size:12px">Sent via MeetSense support chatbot</p>
      `,
      replyTo: email,
    });

    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: 'Failed to send message' });
  }
});

// ── Admin API ──────────────────────────────────────────
app.get('/api/admin/stats', requireAuth, requireAdmin, async (req, res) => {
  const { rows } = await pool.query(`
    SELECT
      COUNT(*) AS total_users,
      COUNT(*) FILTER (WHERE subscription_status='active') AS active_subscribers,
      COUNT(*) FILTER (WHERE subscription_status='cancelled') AS churned,
      COUNT(*) FILTER (WHERE created_at > NOW() - INTERVAL '7 days') AS new_this_week
    FROM users
  `);
  const meetings = await pool.query(`
    SELECT COUNT(*) AS total_meetings,
           COUNT(*) FILTER (WHERE status='completed') AS completed
    FROM meetings
  `);
  res.json({ users: rows[0], meetings: meetings.rows[0] });
});

app.get('/api/admin/users', requireAuth, requireAdmin, async (req, res) => {
  const { rows } = await pool.query(`
    SELECT id, email, name, subscription_status, subscription_end,
           created_at, ms_user_id IS NOT NULL as ms_connected,
           google_id IS NOT NULL as google_connected,
           (SELECT COUNT(*) FROM meetings WHERE user_id=users.id) as meeting_count
    FROM users ORDER BY created_at DESC LIMIT 100
  `);
  res.json(rows);
});

app.get('/api/admin/revenue', requireAuth, requireAdmin, async (req, res) => {
  const { rows } = await pool.query(`
    SELECT
      DATE_TRUNC('month', created_at) AS month,
      COUNT(*) AS payments,
      SUM(amount) / 100.0 AS revenue_inr
    FROM payments WHERE status='captured'
    GROUP BY 1 ORDER BY 1 DESC LIMIT 12
  `);
  res.json(rows);
});

// ── Serve frontend pages ───────────────────────────────
app.get('/dashboard', requireAuth, (req, res) => {
  res.sendFile(path.join(__dirname, '../public/dashboard.html'));
});

app.get('/pricing', (req, res) => {
  res.sendFile(path.join(__dirname, '../public/pricing.html'));
});

app.get('/admin', requireAuth, requireAdmin, (req, res) => {
  res.sendFile(path.join(__dirname, '../public/admin.html'));
});

app.get('/support', (req, res) => {
  res.sendFile(path.join(__dirname, '../public/support.html'));
});

// ── Cron: sync calendars every 5 minutes ──────────────
cron.schedule('*/5 * * * *', async () => {
  const { rows } = await pool.query(
    `SELECT * FROM users
     WHERE (google_refresh_token IS NOT NULL OR ms_refresh_token IS NOT NULL)
     AND subscription_status = 'active'`
  );
  for (const user of rows) {
    if (user.google_refresh_token) syncGoogleCalendar(user).catch(() => {});
    if (user.ms_refresh_token)     syncOutlookCalendar(user).catch(() => {});
  }
});

// ── Start ──────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
(async () => {
  await initDB();
  await rescheduleOnStartup();
  app.listen(PORT, () => {
    console.log(`\n🚀 MeetSense v2 running on http://localhost:${PORT}`);
    console.log(`   Admin: ${process.env.ADMIN_EMAIL}`);
  });
})();
