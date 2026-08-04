# Volish — English Speaking Assessment

An Arabic-interface adaptive English speaking assessment app. Evaluates the user's English level (CEFR A1–C2) through a natural voice conversation and provides a detailed report including IELTS estimate, 4-category scores, strengths, weaknesses, and corrections.

## Stack

- **Frontend**: Single-file HTML/CSS/JS (`index.html`) — no build step
- **Backend**: Node.js + Express (`server.js`) serving static files and two API routes
- **AI**: OpenRouter API (default model: `anthropic/claude-sonnet-4.5`) via `/api/turn` and `/api/analyze`
- **Speech**: Web Speech API (browser-native STT + TTS)

## How to run

```bash
npm install
node server.js   # or: npm start
```

Runs on port **5000**.

## Required environment variable

| Variable | Description |
|---|---|
| `OPENROUTER_API_KEY` | OpenRouter API key (required for the AI backend) |
| `OPENROUTER_MODEL` | Optional — override the LLM model (default: `anthropic/claude-sonnet-4.5`) |
| `SITE_URL` | Optional — sets the HTTP-Referer header sent to OpenRouter |

## API routes

- `POST /api/turn` — evaluates one answer and returns the next adaptive question
- `POST /api/analyze` — produces the full CEFR report from the complete conversation

## Phase 2 UX features (implemented)

- **Warmup / mic test screen** — 5-second sound check before the assessment starts
- **Phase-based progress indicator** — بداية / استكشاف / تعمق instead of question count
- **Silence detection** — gentle encouragement after 8 seconds of no speech
- **Short-answer hint** — subtle prompt when the answer is fewer than 4 words
- **Session rescue** — progress saved to localStorage on network failure; resume banner shown on return

## Project structure

```
index.html        Main app (all UI + client JS)
server.js         Express server
api/
  turn.js         Per-turn adaptive question generator
  analyze.js      Final holistic report generator
package.json
```

## User preferences

- Keep the single-file frontend structure (`index.html`) — no bundler/framework migration
- Maintain RTL Arabic interface with existing Volish design system
