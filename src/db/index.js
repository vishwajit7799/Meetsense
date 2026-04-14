import pg from 'pg';
const { Pool } = pg;

export const pool = new Pool({ connectionString: process.env.DATABASE_URL });

export async function initDB() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      email       TEXT UNIQUE NOT NULL,
      name        TEXT,
      ms_user_id  TEXT UNIQUE,
      access_token  TEXT,
      refresh_token TEXT,
      token_expiry  TIMESTAMPTZ,
      created_at  TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS meetings (
      id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id       UUID REFERENCES users(id) ON DELETE CASCADE,
      ms_event_id   TEXT NOT NULL,
      subject       TEXT,
      start_time    TIMESTAMPTZ,
      end_time      TIMESTAMPTZ,
      meeting_url   TEXT,
      status        TEXT DEFAULT 'pending',
      transcript    TEXT,
      summary       TEXT,
      bot_joined_at TIMESTAMPTZ,
      bot_left_at   TIMESTAMPTZ,
      created_at    TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE(user_id, ms_event_id)
    );

    CREATE INDEX IF NOT EXISTS idx_meetings_user_status
      ON meetings(user_id, status);
    CREATE INDEX IF NOT EXISTS idx_meetings_start_time
      ON meetings(start_time);
  `);
  console.log('✅ Database initialised');
}
