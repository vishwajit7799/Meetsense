import { chromium } from 'playwright';
import { pool } from '../db/index.js';
import { summarizeMeeting } from '../summarizer/gemini.js';
import { sendSummaryEmail } from '../email/sender.js';

/**
 * Main bot entry point.
 * Detects the meeting platform and routes to the right join strategy.
 */
export async function runBot(meeting) {
  console.log(`\n🤖 Bot starting for: "${meeting.subject}"`);
  const { id, meeting_url, subject, start_time, end_time, user_id } = meeting;

  await pool.query(`UPDATE meetings SET status='joining', bot_joined_at=NOW() WHERE id=$1`, [id]);

  const platform = detectPlatform(meeting_url);
  console.log(`   Platform: ${platform} | URL: ${meeting_url.substring(0, 60)}...`);

  let transcript = '';
  let browser = null;

  try {
    browser = await chromium.launch({
      headless: true,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu',
        '--use-fake-ui-for-media-stream',  // auto-grant mic/camera permissions
        '--use-fake-device-for-media-stream',
        '--disable-web-security',
      ],
    });

    const context = await browser.newContext({
      permissions: ['microphone', 'camera'],
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124.0.0.0 Safari/537.36',
    });

    const page = await context.newPage();

    if (platform === 'teams') {
      transcript = await joinTeamsMeeting(page, meeting_url, subject);
    } else if (platform === 'zoom') {
      transcript = await joinZoomMeeting(page, meeting_url, subject);
    } else if (platform === 'meet') {
      transcript = await joinGoogleMeet(page, meeting_url, subject);
    } else {
      throw new Error(`Unsupported platform: ${platform}`);
    }

    console.log(`   ✅ Bot left meeting. Transcript: ${transcript.length} chars`);

    await pool.query(
      `UPDATE meetings SET status='transcribed', transcript=$1, bot_left_at=NOW() WHERE id=$2`,
      [transcript, id]
    );

    // Summarize and email
    await processMeetingResults(meeting, transcript);

  } catch (err) {
    console.error(`   ❌ Bot error for "${subject}":`, err.message);
    await pool.query(`UPDATE meetings SET status='failed' WHERE id=$1`, [id]);
  } finally {
    if (browser) await browser.close();
  }
}

// ─────────────────────────────────────────────────────────
// TEAMS BOT
// ─────────────────────────────────────────────────────────
async function joinTeamsMeeting(page, url, subject) {
  const transcript = [];
  const seen = new Set();

  console.log('   🔵 Joining Teams meeting...');
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });

  // Teams may redirect to web client — click "Continue on this browser"
  await dismissTeamsAppPrompt(page);

  // Fill in the bot's display name
  await page.waitForSelector('[data-tid="prejoin-display-name-input"], input[placeholder*="name"], input[placeholder*="Name"]', { timeout: 20000 })
    .then(el => el.fill(process.env.BOT_NAME || 'MeetSense Notetaker'))
    .catch(() => {});

  // Turn off mic and camera (we're just listening)
  await toggleOffMediaButtons(page);

  // Join the meeting
  await page.click('[data-tid="prejoin-join-button"], button:has-text("Join now"), button:has-text("Join")', { timeout: 15000 })
    .catch(() => {});

  console.log('   ✅ Joined Teams — listening for captions...');
  await pool.query(`UPDATE meetings SET status='in_progress' WHERE id=(SELECT id FROM meetings WHERE meeting_url LIKE $1 LIMIT 1)`, [`%${url.substring(url.length - 20)}%`]);

  // Enable live captions: More > Turn on live captions
  await enableTeamsCaptions(page);

  // Scrape captions until meeting ends
  await scrapeCaptionsUntilEnd(page, transcript, seen, {
    captionSelector: '[data-tid="closed-captions-text"], .ts-caption-text, [class*="caption"]',
    speakerSelector: '[data-tid="closed-captions-speaker-name"], [class*="captionSpeaker"]',
    endSignal: async () => isTeamsMeetingEnded(page),
    maxDurationMs: 4 * 60 * 60 * 1000, // 4 hour max
  });

  return formatTranscript(transcript);
}

async function dismissTeamsAppPrompt(page) {
  const selectors = [
    'button:has-text("Continue on this browser")',
    'a:has-text("Join on the web instead")',
    '[data-tid="joinOnWeb"]',
  ];
  for (const sel of selectors) {
    await page.click(sel, { timeout: 5000 }).catch(() => {});
  }
}

async function toggleOffMediaButtons(page) {
  const micSelectors = ['[data-tid="toggle-mute"]', 'button[aria-label*="Mute"]', 'button[aria-label*="microphone"]'];
  const camSelectors = ['[data-tid="toggle-video"]', 'button[aria-label*="camera"]', 'button[aria-label*="Camera off"]'];
  for (const sel of [...micSelectors, ...camSelectors]) {
    await page.click(sel, { timeout: 3000 }).catch(() => {});
  }
}

async function enableTeamsCaptions(page) {
  await page.waitForTimeout(5000); // wait for meeting UI to fully load
  // Open "More actions" menu
  await page.click('[data-tid="callingButtons-showMoreBtn"], button[aria-label*="More"], button[aria-label*="more actions"]', { timeout: 10000 })
    .catch(() => {});
  await page.waitForTimeout(1000);
  // Click "Turn on live captions"
  await page.click('button:has-text("Turn on live captions"), [data-tid="captions-toggle-button"]', { timeout: 5000 })
    .catch(() => {});
  console.log('   📝 Live captions enabled');
}

async function isTeamsMeetingEnded(page) {
  const endIndicators = [
    '[data-tid="hangup-btn"]',
    'div:has-text("The meeting has ended")',
    'div:has-text("You left the meeting")',
  ];
  for (const sel of endIndicators) {
    try {
      const el = await page.$(sel);
      if (sel.includes('text') && el) return true;
    } catch {}
  }
  // Check if page redirected away from meeting
  return page.url().includes('thank-you') || page.url().includes('end');
}

// ─────────────────────────────────────────────────────────
// ZOOM BOT
// ─────────────────────────────────────────────────────────
async function joinZoomMeeting(page, url, subject) {
  const transcript = [];
  const seen = new Set();

  console.log('   🟡 Joining Zoom meeting via web client...');

  // Force web client by appending /wc/
  const webUrl = url.includes('/wc/') ? url : url.replace('/j/', '/wc/').concat('?prefer=1');
  await page.goto(webUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });

  // Enter display name
  await page.waitForSelector('#input-for-name, [placeholder*="name"]', { timeout: 15000 })
    .then(el => el.fill(process.env.BOT_NAME || 'MeetSense Notetaker'))
    .catch(() => {});

  // Click Join
  await page.click('button.preview-join-button, button:has-text("Join")', { timeout: 10000 })
    .catch(() => {});

  console.log('   ✅ Joined Zoom — listening for captions...');

  // Enable CC in Zoom
  await page.waitForTimeout(5000);
  await page.click('[aria-label*="closed caption"], button:has-text("CC"), [class*="cc-btn"]', { timeout: 8000 })
    .catch(() => {});

  await scrapeCaptionsUntilEnd(page, transcript, seen, {
    captionSelector: '#zoom-caption-container span, [class*="subtitle"], [class*="caption-text"]',
    speakerSelector: '[class*="caption-author"], [class*="caption-speaker"]',
    endSignal: async () => page.url().includes('postattendee') || page.url().includes('leavewebinar'),
    maxDurationMs: 4 * 60 * 60 * 1000,
  });

  return formatTranscript(transcript);
}

// ─────────────────────────────────────────────────────────
// GOOGLE MEET BOT
// ─────────────────────────────────────────────────────────
async function joinGoogleMeet(page, url, subject) {
  const transcript = [];
  const seen = new Set();

  console.log('   🟢 Joining Google Meet...');
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });

  // Dismiss sign-in prompts — join as guest
  await page.click('button:has-text("Join as a guest"), [jsname="Qx7uuf"]', { timeout: 8000 }).catch(() => {});
  await page.waitForSelector('input[placeholder*="name"], [jsname*="name"]', { timeout: 10000 })
    .then(el => el.fill(process.env.BOT_NAME || 'MeetSense Notetaker'))
    .catch(() => {});

  // Mute mic and turn off camera
  await page.click('[data-is-muted="false"][aria-label*="microphone"], [jsname="BOHaEe"]', { timeout: 5000 }).catch(() => {});
  await page.click('[data-is-muted="false"][aria-label*="camera"], [jsname="R3Kmgb"]', { timeout: 5000 }).catch(() => {});

  // Join
  await page.click('button:has-text("Ask to join"), button:has-text("Join now"), [data-promo-anchor-id="join_button"]', { timeout: 10000 }).catch(() => {});

  console.log('   ✅ Joined Google Meet — listening for captions...');

  // Enable captions: CC button at the bottom
  await page.waitForTimeout(4000);
  await page.click('[aria-label*="captions"], [aria-label*="Captions"], [jsname="r8qRAd"]', { timeout: 8000 }).catch(() => {});

  await scrapeCaptionsUntilEnd(page, transcript, seen, {
    captionSelector: '[jsname="tgaKEf"], [class*="caption"] span, .a4cQT',
    speakerSelector: '[class*="captionSpeaker"], [jsname="bUMd7b"]',
    endSignal: async () => page.url().includes('lookingForSomething') || !(await page.$('[jsname="CQylAd"]')),
    maxDurationMs: 4 * 60 * 60 * 1000,
  });

  return formatTranscript(transcript);
}

// ─────────────────────────────────────────────────────────
// SHARED CAPTION SCRAPER
// ─────────────────────────────────────────────────────────
async function scrapeCaptionsUntilEnd(page, transcript, seen, options) {
  const { captionSelector, speakerSelector, endSignal, maxDurationMs } = options;
  const startTime = Date.now();
  let lastSpeaker = '';

  while (Date.now() - startTime < maxDurationMs) {
    // Check if meeting ended
    if (await endSignal()) {
      console.log('   🏁 Meeting ended — bot leaving');
      break;
    }

    try {
      // Get current caption text
      const captionEl = await page.$(captionSelector);
      const speakerEl = await page.$(speakerSelector);

      if (captionEl) {
        const text    = (await captionEl.textContent())?.trim();
        const speaker = speakerEl ? (await speakerEl.textContent())?.trim() : lastSpeaker;

        if (text && text.length > 3) {
          const key = `${speaker}:${text}`;
          if (!seen.has(key)) {
            seen.add(key);
            if (speaker) lastSpeaker = speaker;
            transcript.push({ speaker: speaker || lastSpeaker || 'Participant', text, ts: new Date().toISOString() });
          }
        }
      }
    } catch {}

    await page.waitForTimeout(800); // poll every 800ms
  }
}

// ─────────────────────────────────────────────────────────
// POST-MEETING: SUMMARIZE + EMAIL
// ─────────────────────────────────────────────────────────
async function processMeetingResults(meeting, transcript) {
  if (!transcript || transcript.length < 100) {
    console.log('   ⚠️  Transcript too short — skipping summary');
    return;
  }

  try {
    console.log('   🧠 Sending to Gemini for summarization...');
    const summary = await summarizeMeeting(transcript, {
      subject:   meeting.subject,
      startTime: meeting.start_time,
      endTime:   meeting.end_time,
    });

    await pool.query(
      `UPDATE meetings SET summary=$1, status='completed' WHERE id=$2`,
      [summary, meeting.id]
    );

    // Get user email
    const { rows } = await pool.query(`SELECT email, name FROM users WHERE id=$1`, [meeting.user_id]);
    if (rows.length > 0) {
      await sendSummaryEmail(rows[0].email, rows[0].name, meeting, summary);
      console.log(`   📧 Summary emailed to ${rows[0].email}`);
    }
  } catch (err) {
    console.error('   ❌ Post-meeting processing failed:', err.message);
  }
}

// ─────────────────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────────────────
function detectPlatform(url) {
  if (url.includes('teams.microsoft.com'))  return 'teams';
  if (url.includes('zoom.us'))              return 'zoom';
  if (url.includes('meet.google.com'))      return 'meet';
  return 'unknown';
}

function formatTranscript(entries) {
  return entries
    .map(e => `[${new Date(e.ts).toLocaleTimeString()}] ${e.speaker}: ${e.text}`)
    .join('\n');
}
