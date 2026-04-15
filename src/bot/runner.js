import { chromium } from 'playwright';
import { pool } from '../db/index.js';
import { summarizeMeeting } from '../summarizer/gemini.js';
import { sendSummaryEmail } from '../email/sender.js';
import {
  setupVirtualAudio,
  teardownVirtualAudio,
  startAudioCapture,
  transcribeChunk,
} from './transcriber.js';

export async function runBot(meeting) {
  console.log(`\n🤖 Bot starting for: "${meeting.subject}"`);
  const { id, meeting_url, subject, start_time, end_time, user_id } = meeting;

  await pool.query(
    `UPDATE meetings SET status='joining', bot_joined_at=NOW() WHERE id=$1`, [id]
  );

  const platform = detectPlatform(meeting_url);
  console.log(`   Platform: ${platform} | URL: ${meeting_url.substring(0, 60)}...`);

  const transcriptChunks = [];
  let browser = null;
  const sinkName = setupVirtualAudio(id);

  // Start audio capture — transcribes every 30 seconds in background
  const capture = startAudioCapture(sinkName, id, async (chunkPath) => {
    console.log(`   🎙️  Transcribing audio chunk...`);
    const text = await transcribeChunk(chunkPath);
    if (text.trim()) {
      transcriptChunks.push(text);
      console.log(`   ✍️  Chunk: ${text.substring(0, 80)}...`);
    }
  });

  try {
    browser = await chromium.launch({
      headless: true,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu',
        '--alsa-output-device=pulse',
        '--use-fake-ui-for-media-stream',
        '--use-fake-device-for-media-stream',
        '--autoplay-policy=no-user-gesture-required',
        '--disable-web-security',
      ],
      env: {
        ...process.env,
        PULSE_SINK: sinkName,
        PULSE_SOURCE: `${sinkName}.monitor`,
      },
    });

    const context = await browser.newContext({
      permissions: ['microphone', 'camera'],
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124.0.0.0 Safari/537.36',
    });

    const page = await context.newPage();

    if (platform === 'meet')        await joinGoogleMeet(page, meeting_url, id);
    else if (platform === 'teams')  await joinTeamsMeeting(page, meeting_url, id);
    else if (platform === 'zoom')   await joinZoomMeeting(page, meeting_url, id);
    else throw new Error(`Unsupported platform: ${platform}`);

    await waitForMeetingEnd(page, platform, 4 * 60 * 60 * 1000);
    console.log(`   🏁 Meeting ended — bot leaving`);

  } catch (err) {
    console.error(`   ❌ Bot error:`, err.message);
    await pool.query(`UPDATE meetings SET status='failed' WHERE id=$1`, [id]);
  } finally {
    capture.stop();
    teardownVirtualAudio(sinkName);
    if (browser) await browser.close();
  }

  // Wait for last chunk to finish transcribing
  await new Promise(r => setTimeout(r, 6000));

  const fullTranscript = transcriptChunks.join('\n\n');
  console.log(`   ✅ Transcript: ${fullTranscript.length} chars`);

  await pool.query(
    `UPDATE meetings SET status='transcribed', transcript=$1, bot_left_at=NOW() WHERE id=$2`,
    [fullTranscript, id]
  );

  await processMeetingResults(meeting, fullTranscript);
}

async function joinGoogleMeet(page, url, meetingId) {
  console.log('   🟢 Joining Google Meet...');
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });

  await page.click(
    'button:has-text("Continue without signing in"), button:has-text("Join as a guest")',
    { timeout: 8000 }
  ).catch(() => {});

  const nameInput = await page.waitForSelector(
    'input[placeholder*="name"], input[aria-label*="name"], [jsname="YPqjbf"]',
    { timeout: 10000 }
  ).catch(() => null);
  if (nameInput) await nameInput.fill(process.env.BOT_NAME || 'MeetSense Notetaker');

  await page.click('[data-is-muted="false"][aria-label*="microphone"], [jsname="BOHaEe"]', { timeout: 5000 }).catch(() => {});
  await page.click('[data-is-muted="false"][aria-label*="camera"], [jsname="R3Kmgb"]', { timeout: 5000 }).catch(() => {});
  await page.click(
    'button:has-text("Ask to join"), button:has-text("Join now"), [jsname="Qx7uuf"]',
    { timeout: 15000 }
  ).catch(() => {});

  await pool.query(`UPDATE meetings SET status='in_progress' WHERE id=$1`, [meetingId]);
  console.log('   ✅ Joined Google Meet — audio capture running...');
}

async function joinTeamsMeeting(page, url, meetingId) {
  console.log('   🔵 Joining Teams meeting...');
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });

  await page.click(
    'button:has-text("Continue on this browser"), a:has-text("Join on the web instead")',
    { timeout: 8000 }
  ).catch(() => {});

  await page.waitForSelector('[data-tid="prejoin-display-name-input"], input[placeholder*="name"]', { timeout: 20000 })
    .then(el => el.fill(process.env.BOT_NAME || 'MeetSense Notetaker')).catch(() => {});

  await page.click('[data-tid="toggle-mute"]', { timeout: 5000 }).catch(() => {});
  await page.click('[data-tid="toggle-video"]', { timeout: 5000 }).catch(() => {});
  await page.click('[data-tid="prejoin-join-button"], button:has-text("Join now")', { timeout: 15000 }).catch(() => {});

  await pool.query(`UPDATE meetings SET status='in_progress' WHERE id=$1`, [meetingId]);
  console.log('   ✅ Joined Teams — audio capture running...');
}

async function joinZoomMeeting(page, url, meetingId) {
  console.log('   🟡 Joining Zoom...');
  const webUrl = url.includes('/wc/') ? url : url.replace('/j/', '/wc/').concat('?prefer=1');
  await page.goto(webUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });

  await page.waitForSelector('#input-for-name, [placeholder*="name"]', { timeout: 15000 })
    .then(el => el.fill(process.env.BOT_NAME || 'MeetSense Notetaker')).catch(() => {});
  await page.click('button.preview-join-button, button:has-text("Join")', { timeout: 10000 }).catch(() => {});

  await pool.query(`UPDATE meetings SET status='in_progress' WHERE id=$1`, [meetingId]);
  console.log('   ✅ Joined Zoom — audio capture running...');
}

async function waitForMeetingEnd(page, platform, maxMs) {
  const start = Date.now();

  // Phase 1: Wait for meeting to actually start (up to 10 min)
  // Don't check for end signals during this phase
  console.log('   ⏳ Waiting for meeting to start...');
  await page.waitForTimeout(30000); // always wait at least 30s before checking end

  // Phase 2: Now poll for genuine end signals
  console.log('   👂 Monitoring meeting...');
  while (Date.now() - start < maxMs) {
    await page.waitForTimeout(20000); // check every 20 seconds
    try {
      const url = page.url();

      if (platform === 'meet') {
        // Only treat as ended if we see a definitive post-meeting URL
        // NOT just about:blank or intermediate states
        if (url.includes('lookingForSomething')) break;

        // Check for "You've left the call" or "This meeting has ended" text
        const leftMeeting = await page.evaluate(() => {
          const body = document.body?.innerText || '';
          return body.includes("You've left") ||
                 body.includes("meeting has ended") ||
                 body.includes("call has ended") ||
                 body.includes("returned to home");
        }).catch(() => false);
        if (leftMeeting) break;
      }

      if (platform === 'teams') {
        if (url.includes('thank-you') || url.includes('/end')) break;
        const ended = await page.$('div:has-text("The meeting has ended")').catch(() => null);
        if (ended) break;
      }

      if (platform === 'zoom') {
        if (url.includes('postattendee') || url.includes('leavewebinar')) break;
      }

    } catch {
      // Page closed or navigated away — meeting likely ended
      break;
    }
  }
}

async function processMeetingResults(meeting, transcript) {
  if (!transcript || transcript.length < 50) {
    console.log('   ⚠️  Transcript too short — skipping summary');
    await pool.query(`UPDATE meetings SET status='completed' WHERE id=$1`, [meeting.id]);
    return;
  }

  try {
    console.log('   🧠 Sending to Gemini for summarisation...');
    const summary = await summarizeMeeting(transcript, {
      subject: meeting.subject,
      startTime: meeting.start_time,
      endTime: meeting.end_time,
    });

    await pool.query(
      `UPDATE meetings SET summary=$1, status='completed' WHERE id=$2`,
      [summary, meeting.id]
    );

    const { rows } = await pool.query(
      `SELECT email, name FROM users WHERE id=$1`, [meeting.user_id]
    );
    if (rows.length > 0) {
      await sendSummaryEmail(rows[0].email, rows[0].name, meeting, summary);
      console.log(`   📧 Summary emailed to ${rows[0].email}`);
    }
  } catch (err) {
    console.error('   ❌ Post-meeting error:', err.message);
    await pool.query(`UPDATE meetings SET status='completed' WHERE id=$1`, [meeting.id]);
  }
}

function detectPlatform(url) {
  if (url.includes('teams.microsoft.com')) return 'teams';
  if (url.includes('zoom.us'))             return 'zoom';
  if (url.includes('meet.google.com'))     return 'meet';
  return 'unknown';
}
