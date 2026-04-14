import passport from 'passport';
import { Strategy as GoogleStrategy } from 'passport-google-oauth20';
import { pool } from '../db/index.js';

export function setupGoogleAuth() {
  passport.use(new GoogleStrategy({
    clientID:     process.env.GOOGLE_CLIENT_ID,
    clientSecret: process.env.GOOGLE_CLIENT_SECRET,
    callbackURL:  `${process.env.APP_URL}/auth/google/callback`,
    scope: [
      'profile',
      'email',
      'https://www.googleapis.com/auth/calendar.readonly',
    ],
    accessType: 'offline',
    prompt: 'consent',
  }, async (accessToken, refreshToken, profile, done) => {
    try {
      const email  = profile.emails[0].value;
      const name   = profile.displayName;
      const avatar = profile.photos[0]?.value;
      const googleId = profile.id;
      const expiry = new Date(Date.now() + 3600 * 1000);

      const { rows } = await pool.query(
        `INSERT INTO users
           (email, name, avatar, auth_provider, google_id,
            google_access_token, google_refresh_token, google_token_expiry)
         VALUES ($1,$2,$3,'google',$4,$5,$6,$7)
         ON CONFLICT (email) DO UPDATE SET
           name=$2, avatar=$3, google_id=$4,
           google_access_token=$5,
           google_refresh_token=COALESCE($6, users.google_refresh_token),
           google_token_expiry=$7
         RETURNING *`,
        [email, name, avatar, googleId, accessToken, refreshToken, expiry]
      );
      return done(null, rows[0]);
    } catch (err) {
      return done(err);
    }
  }));

  passport.serializeUser((user, done) => done(null, user.id));
  passport.deserializeUser(async (id, done) => {
    const { rows } = await pool.query('SELECT * FROM users WHERE id=$1', [id]);
    done(null, rows[0] || null);
  });
}

// Refresh Google access token if expired
export async function getValidGoogleToken(user) {
  if (user.google_token_expiry && new Date(user.google_token_expiry) > new Date(Date.now() + 60000)) {
    return user.google_access_token;
  }
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id:     process.env.GOOGLE_CLIENT_ID,
      client_secret: process.env.GOOGLE_CLIENT_SECRET,
      refresh_token: user.google_refresh_token,
      grant_type:    'refresh_token',
    }),
  });
  const data = await res.json();
  const expiry = new Date(Date.now() + data.expires_in * 1000);
  await pool.query(
    'UPDATE users SET google_access_token=$1, google_token_expiry=$2 WHERE id=$3',
    [data.access_token, expiry, user.id]
  );
  return data.access_token;
}
