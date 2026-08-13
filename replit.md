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
