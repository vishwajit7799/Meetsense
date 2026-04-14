const GEMINI_URL = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent';

const SYSTEM_PROMPT = `You are an expert meeting analyst. Given a meeting transcript with timestamps and speaker names, produce a structured HTML summary.

Output exactly this structure (HTML only, no markdown, no backticks):

<div class="summary">
  <div class="meta">
    <strong>Meeting:</strong> {title}<br>
    <strong>Date:</strong> {date}<br>
    <strong>Duration:</strong> {duration}<br>
    <strong>Attendees:</strong> {comma-separated speaker names from transcript}
  </div>

  <h3>Key discussion points</h3>
  <ul>{3-6 bullet points of main topics discussed}</ul>

  <h3>Decisions made</h3>
  <ul>{concrete decisions, or <li>None recorded</li>}</ul>

  <h3>Action items</h3>
  <ul>{format each as: <li><strong>Owner:</strong> task description</li> — use "Team" if owner unclear, or <li>None identified</li>}</ul>

  <h3>Open questions</h3>
  <ul>{unresolved items or follow-ups, or <li>None</li>}</ul>
</div>

Be specific. Extract real names, numbers, dates mentioned. Keep bullets concise — one idea per bullet.`;

export async function summarizeMeeting(transcript, meta = {}) {
  const { subject = 'Meeting', startTime, endTime } = meta;

  const duration = startTime && endTime
    ? formatDuration(new Date(endTime) - new Date(startTime))
    : 'Unknown';

  const dateStr = startTime
    ? new Date(startTime).toLocaleDateString('en-IN', { dateStyle: 'long' })
    : 'Unknown';

  const prompt = `Meeting: ${subject}
Date: ${dateStr}
Duration: ${duration}

TRANSCRIPT:
${transcript}`;

  const res = await fetch(`${GEMINI_URL}?key=${process.env.GEMINI_API_KEY}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      system_instruction: { parts: [{ text: SYSTEM_PROMPT }] },
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: { maxOutputTokens: 2048, temperature: 0.2 },
    }),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Gemini API error ${res.status}: ${err}`);
  }

  const data = await res.json();
  const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!text) throw new Error('Gemini returned empty response');
  return text;
}

function formatDuration(ms) {
  const mins  = Math.round(ms / 60000);
  const hours = Math.floor(mins / 60);
  const rem   = mins % 60;
  return hours > 0 ? `${hours}h ${rem}m` : `${mins} min`;
}
