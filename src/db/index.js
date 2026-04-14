import pg from 'pg';
const { Pool } = pg;

export const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

export async function initDB() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      email                 TEXT UNIQUE NOT NULL,
      name                  TEXT,
      avatar                TEXT,
      auth_provider         TEXT DEFAULT 'google',
      google_id             TEXT UNIQUE,
      ms_user_id            TEXT UNIQUE,
      google_access_token   TEXT,
      google_refresh_token  TEXT,
      google_token_expiry   TIMESTAMPTZ,
      ms_access_token       TEXT,
      ms_refresh_token      TEXT,
      ms_token_expiry       TIMESTAMPTZ,
      subscription_status   TEXT DEFAULT 'free',
      subscription_id       TEXT,
      razorpay_customer_id  TEXT,
      subscription_end      TIMESTAMPTZ,
      created_at            TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS meetings (
      id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id       UUID REFERENCES users(id) ON DELETE CASCADE,
      external_id   TEXT,
      subject       TEXT,
      start_time    TIMESTAMPTZ,
      end_time      TIMESTAMPTZ,
      meeting_url   TEXT,
      platform      TEXT,
      status        TEXT DEFAULT 'pending',
      transcript    TEXT,
      summary       TEXT,
      bot_joined_at TIMESTAMPTZ,
      bot_left_at   TIMESTAMPTZ,
      created_at    TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE(user_id, external_id)
    );

    CREATE TABLE IF NOT EXISTS payments (
      id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id             UUID REFERENCES users(id) ON DELETE CASCADE,
      razorpay_payment_id TEXT,
      razorpay_order_id   TEXT,
      amount              INTEGER,
      currency            TEXT DEFAULT 'INR',
      status              TEXT,
      created_at          TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE INDEX IF NOT EXISTS idx_meetings_user_status ON meetings(user_id, status);
    CREATE INDEX IF NOT EXISTS idx_meetings_start ON meetings(start_time);
    CREATE INDEX IF NOT EXISTS idx_payments_user ON payments(user_id);
  `);
  console.log('✅ Database v2 ready');
}
