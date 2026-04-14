# MeetSense 🤖

> Open-source AI meeting notetaker. Automatically joins your Teams, Zoom and Google Meet calls, transcribes them, and emails you a clean summary — powered by Gemini 2.0 Flash (free).

[![Deploy to Render](https://render.com/images/deploy-to-render-button.svg)](https://render.com/deploy?repo=https://github.com/yourusername/meetsense)
![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)
![Node.js](https://img.shields.io/badge/Node.js-20+-brightgreen)
![Free to use](https://img.shields.io/badge/cost-free-blue)

---

## What it does

1. **Connect once** — sign in with your Microsoft 365 account (Outlook calendar)
2. **Bot joins automatically** — 2 minutes before each meeting, a headless Chrome bot joins as "MeetSense Notetaker"
3. **Transcribes in real time** — scrapes live captions with speaker attribution
4. **Summarises with AI** — Gemini 2.0 Flash generates structured notes: key points, decisions, action items
5. **Emails you the summary** — arrives in your inbox within 2 minutes of the meeting ending

Works with **Microsoft Teams**, **Zoom**, and **Google Meet**.

---

## Screenshots

| Landing page | Dashboard | Email summary |
|---|---|---|
| ![Landing](docs/landing.png) | ![Dashboard](docs/dashboard.png) | ![Email](docs/email.png) |

---

## Tech stack

| Layer | Technology |
|---|---|
| Backend | Node.js 20, Express |
| Bot engine | Playwright (headless Chromium) |
| Calendar | Microsoft Graph API (Calendars.Read — no admin consent needed) |
| AI summarisation | Google Gemini 2.0 Flash (free tier) |
| Database | PostgreSQL |
| Email | Nodemailer (Gmail SMTP) |
| Deployment | Docker + Render (free tier) |

---

## Quick start (local)

### Prerequisites
- Node.js 20+
- PostgreSQL database (free: [Neon](https://neon.tech) or [Supabase](https://supabase.com))
- Microsoft Azure App Registration (5 min setup — see below)
- Google Gemini API key (free — [get it here](https://aistudio.google.com/app/apikey))
- Gmail account with App Password enabled

### 1. Clone and install

```bash
git clone https://github.com/yourusername/meetsense.git
cd meetsense
npm install
npx playwright install chromium
```

### 2. Configure environment

```bash
cp .env.example .env
# Edit .env with your values
```

### 3. Set up Microsoft Azure App Registration

> This takes about 5 minutes. No admin consent required.

1. Go to [portal.azure.com](https://portal.azure.com) → **App registrations** → **New registration**
2. Name: `MeetSense` | Account type: **Accounts in any organizational directory and personal Microsoft accounts**
3. Redirect URI: `http://localhost:3000/auth/callback` (Web)
4. Click **Register** → copy the **Application (client) ID** → `MICROSOFT_CLIENT_ID`
5. Go to **Certificates & secrets** → **New client secret** → copy the value → `MICROSOFT_CLIENT_SECRET`
6. Go to **API permissions** → **Add permission** → **Microsoft Graph** → **Delegated**:
   - `User.Read`
   - `Calendars.Read`
   - `offline_access`
7. Click **Grant admin consent** (or ask your IT admin — these are read-only permissions)

### 4. Run

```bash
npm start
# Open http://localhost:3000
# Click "Connect Microsoft 365"
```

---

## Deploy to Render (one click)

Click the **Deploy to Render** button at the top of this README. Render will:
- Provision a free PostgreSQL database
- Build the Docker image
- Ask you to fill in your environment variables

Then update your Azure App redirect URI to your Render URL:
`https://your-app.onrender.com/auth/callback`

---

## How the bot works

MeetSense uses a **headless Chromium browser** (via Playwright) to join meetings as a guest participant — the same technique used by tools like read.ai, Otter.ai and Fireflies.

```
Calendar sync (every 5 min)
  └── Detects upcoming meeting with Teams/Zoom/Meet link
      └── Schedules bot to join 2 min before start
          └── Playwright opens meeting URL in headless Chrome
              └── Bot joins as "MeetSense Notetaker" (visible in participant list)
                  └── Scrapes live captions + speaker names throughout meeting
                      └── Meeting ends → transcript assembled
                          └── Gemini summarises → email sent to user
```

**Important:** The bot is always visible in the participant list. It does not silently record. All participants can see it and remove it if they choose.

---

## Project structure

```
meetsense/
├── src/
│   ├── server.js          # Express app, routes, cron jobs
│   ├── auth/
│   │   └── microsoft.js   # OAuth flow, token refresh
│   ├── bot/
│   │   ├── runner.js      # Playwright bot — joins meetings, scrapes captions
│   │   └── scheduler.js   # Times bot launch relative to meeting start
│   ├── calendar/
│   │   └── watcher.js     # Polls Outlook calendar via Graph API
│   ├── summarizer/
│   │   └── gemini.js      # Gemini API summarisation
│   ├── email/
│   │   └── sender.js      # Nodemailer email delivery
│   └── db/
│       └── index.js       # PostgreSQL schema + pool
├── public/
│   ├── index.html         # Landing page
│   └── dashboard.html     # User dashboard
├── .github/
│   └── workflows/ci.yml   # GitHub Actions CI
├── Dockerfile
├── render.yaml            # One-click Render deploy
├── .env.example           # Environment variable template
└── .gitignore             # Keeps secrets out of Git
```

---

## Security

- **No secrets in code** — all credentials via environment variables
- **`.env` excluded from Git** via `.gitignore`
- **Read-only calendar access** — `Calendars.Read` permission only, no write access
- **Visible bot** — always appears in participant list, never hidden
- **Your data stays yours** — self-hosted, no third-party data sharing

---

## Contributing

PRs welcome! Areas where help would be great:
- Better caption selector maintenance as platform UIs update
- Support for more meeting platforms (Webex, etc.)
- Real-time transcript streaming to dashboard
- Slack/Teams channel delivery option

---

## License

MIT — free to use, fork, and build on.

---

Built by [Vishwajit](https://github.com/yourusername) · Powered by [Playwright](https://playwright.dev) + [Gemini](https://aistudio.google.com)
