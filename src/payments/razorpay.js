import Razorpay from 'razorpay';
import { pool } from '../db/index.js';

const razorpay = new Razorpay({
  key_id:     process.env.RAZORPAY_KEY_ID,
  key_secret: process.env.RAZORPAY_KEY_SECRET,
});

// ₹100/month plan — create this once in Razorpay dashboard
// then put the plan_id in RAZORPAY_PLAN_ID env var
export async function createSubscription(userId, userEmail) {
  const subscription = await razorpay.subscriptions.create({
    plan_id:        process.env.RAZORPAY_PLAN_ID,
    total_count:    12, // 12 months
    quantity:       1,
    customer_notify: 1,
    notes: {
      user_id: userId,
      email:   userEmail,
    },
  });

  await pool.query(
    `UPDATE users SET subscription_id=$1, subscription_status='pending' WHERE id=$2`,
    [subscription.id, userId]
  );

  return subscription;
}

export async function handleWebhook(payload, signature) {
  // Verify webhook signature
  const crypto = await import('crypto');
  const expected = crypto.default
    .createHmac('sha256', process.env.RAZORPAY_KEY_SECRET)
    .update(JSON.stringify(payload))
    .digest('hex');

  if (expected !== signature) {
    throw new Error('Invalid webhook signature');
  }

  const event = payload.event;
  const data  = payload.payload?.subscription?.entity;

  if (!data) return;

  if (event === 'subscription.activated' || event === 'subscription.charged') {
    // Payment successful — activate user
    await pool.query(
      `UPDATE users SET
         subscription_status='active',
         subscription_end=NOW() + INTERVAL '1 month'
       WHERE subscription_id=$1`,
      [data.id]
    );
    console.log(`✅ Subscription activated: ${data.id}`);
  }

  if (event === 'subscription.cancelled' || event === 'subscription.expired') {
    await pool.query(
      `UPDATE users SET subscription_status='cancelled' WHERE subscription_id=$1`,
      [data.id]
    );
    console.log(`❌ Subscription cancelled: ${data.id}`);
  }

  if (event === 'subscription.halted') {
    // Payment failed after retries
    await pool.query(
      `UPDATE users SET subscription_status='payment_failed' WHERE subscription_id=$1`,
      [data.id]
    );
  }
}

export function isSubscribed(user) {
  return user.subscription_status === 'active' &&
    (!user.subscription_end || new Date(user.subscription_end) > new Date());
}
