import { execSync, spawn } from 'child_process';
import { writeFileSync, unlinkSync, existsSync, mkdirSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

const GROQ_API_URL = 'https://api.groq.com/openai/v1/audio/transcriptions';
const CHUNK_DURATION_SECS = 30; // transcribe every 30 seconds
const AUDIO_DIR = join(tmpdir(), 'meetsense-audio');

// Ensure audio temp directory exists
if (!existsSync(AUDIO_DIR)) mkdirSync(AUDIO_DIR, { recursive: true });

/**
 * Sets up PulseAudio virtual sink so headless Chrome can output audio
 * Returns the sink name to use when launching Chrome
 */
export function setupVirtualAudio(meetingId) {
  const sinkName = `meetsense_${meetingId.replace(/-/g, '_')}`;
  try {
    // Create a null sink (virtual speaker) — audio goes here instead of real speaker
    execSync(`pactl load-module module-null-sink sink_name=${sinkName} sink_properties=device.description=${sinkName}`, { stdio: 'pipe' });
    // Create a monitor source so ffmpeg can read from it
    execSync(`pactl set-default-source ${sinkName}.monitor`, { stdio: 'pipe' });
    console.log(`🎙️  Virtual audio sink created: ${sinkName}`);
    return sinkName;
  } catch (err) {
    console.warn('PulseAudio setup warning (may already exist):', err.message);
    return sinkName;
  }
}

/**
 * Tears down the virtual audio sink after meeting ends
 */
export function teardownVirtualAudio(sinkName) {
  try {
    execSync(`pactl unload-module module-null-sink`, { stdio: 'pipe' });
  } catch {}
}

/**
 * Starts ffmpeg recording from the virtual audio sink
 * Calls onChunk(audioFilePath) every CHUNK_DURATION_SECS seconds
 * Returns a stop() function
 */
export function startAudioCapture(sinkName, meetingId, onChunk) {
  const segments = [];
  let chunkIndex = 0;
  let ffmpegProcess = null;
  let stopped = false;

  function recordChunk() {
    if (stopped) return;

    const outPath = join(AUDIO_DIR, `${meetingId}_chunk_${chunkIndex++}.wav`);
    segments.push(outPath);

    ffmpegProcess = spawn('ffmpeg', [
      '-f', 'pulse',
      '-i', `${sinkName}.monitor`,
      '-t', String(CHUNK_DURATION_SECS),
      '-ar', '16000',       // 16kHz — Whisper's preferred sample rate
      '-ac', '1',           // mono
      '-y',                 // overwrite
      outPath
    ], { stdio: 'pipe' });

    ffmpegProcess.on('close', (code) => {
      if (stopped) return;
      if (code === 0 && existsSync(outPath)) {
        onChunk(outPath);
      }
      // Start next chunk immediately
      if (!stopped) recordChunk();
    });

    ffmpegProcess.on('error', (err) => {
      console.error('ffmpeg error:', err.message);
    });
  }

  recordChunk();

  return {
    stop: () => {
      stopped = true;
      if (ffmpegProcess) {
        ffmpegProcess.kill('SIGTERM');
      }
      return segments;
    }
  };
}

/**
 * Transcribes a WAV audio chunk using Groq Whisper API
 * Returns transcript text or empty string on failure
 */
export async function transcribeChunk(audioFilePath) {
  if (!existsSync(audioFilePath)) return '';

  try {
    const { readFileSync } = await import('fs');
    const audioData = readFileSync(audioFilePath);

    // Build multipart form data
    const boundary = `----FormBoundary${Date.now()}`;
    const fileName = audioFilePath.split('/').pop();

    const header = Buffer.from(
      `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="file"; filename="${fileName}"\r\n` +
      `Content-Type: audio/wav\r\n\r\n`
    );
    const modelField = Buffer.from(
      `\r\n--${boundary}\r\n` +
      `Content-Disposition: form-data; name="model"\r\n\r\n` +
      `whisper-large-v3-turbo\r\n` +
      `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="response_format"\r\n\r\n` +
      `verbose_json\r\n` +
      `--${boundary}--\r\n`
    );

    const body = Buffer.concat([header, audioData, modelField]);

    const res = await fetch(GROQ_API_URL, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${process.env.GROQ_API_KEY}`,
        'Content-Type': `multipart/form-data; boundary=${boundary}`,
        'Content-Length': body.length,
      },
      body,
    });

    if (!res.ok) {
      const err = await res.text();
      console.error('Groq Whisper error:', err);
      return '';
    }

    const data = await res.json();

    // verbose_json gives us segments with timestamps
    if (data.segments) {
      return data.segments
        .map(s => `[${formatTime(s.start)}] ${s.text.trim()}`)
        .join('\n');
    }

    return data.text || '';
  } catch (err) {
    console.error('Transcription error:', err.message);
    return '';
  } finally {
    // Clean up audio file after transcription
    try { unlinkSync(audioFilePath); } catch {}
  }
}

function formatTime(seconds) {
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${s.toString().padStart(2, '0')}`;
}
