# Volish — English Speaking Assessment

An Arabic-interface adaptive English speaking assessment app. Evaluates the user's English level (CEFR A1–C2) through a text-based conversational interview (via speech-to-text) and provides a detailed report including IELTS estimate, 4-category scores, strengths, weaknesses, and corrections.

## Stack

- **Frontend**: Single-file HTML/CSS/JS (`index.html`) — no build step
- **Backend**: Node.js + Express (`server.js`) serving static files and three API routes
- **AI**: Google Gemini API (default model: `gemini-3.5-flash`) via `/api/turn`, `/api/analyze`, `/api/plan`
- **Speech**: Web Speech API (browser-native STT + TTS) — text fallback when unsupported
- **DB/Auth**: Supabase (reports, sessions, turns, progress_snapshots, learning_plans, api_rate_limits)

## How to run

```bash
npm install
node server.js   # or: npm start
```

Runs on port **5000**.

## Required environment variables

| Variable | Description |
|---|---|
| `GEMINI_API_KEY` | **Required.** Google AI Studio key — without it every API route returns 500. |
| `GEMINI_MODEL` | Optional — override the model (default: `gemini-3.5-flash`) |
| `SUPABASE_URL` | Required for persistent rate limiting |
| `SUPABASE_SERVICE_ROLE_KEY` | Required for persistent rate limiting (server-side only, never exposed to browser) |
| `ALLOWED_ORIGINS` | Optional — comma-separated allow-list for the API's Origin check |

## API routes

- `POST /api/turn` — evaluates one answer and returns the next adaptive question
- `POST /api/analyze` — produces the full CEFR report from the complete conversation
- `POST /api/plan` — generates a one-week study plan from a completed report

## Known limitation (important — must match marketing copy)

V1 evaluates a **text transcript only** (via browser speech-to-text). There is no real pronunciation/audio analysis. Any marketing copy claiming "listens to your tone" or citing accuracy stats must reflect this.

## Project structure

```
index.html        Main app (all UI + client JS)
server.js         Express server
api/
  turn.js         Per-turn adaptive question generator
  analyze.js      Final holistic report generator
  plan.js         One-week study plan generator
lib/
  rateLimit.js    Supabase-backed rate limiter
package.json
```

## User preferences

- Keep the single-file frontend structure (`index.html`) — no bundler/framework migration
- Maintain RTL Arabic interface with existing Volish design system
