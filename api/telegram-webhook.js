// api/telegram-webhook.js
// Telegram bot webhook — نفس منطق التقييم التكيّفي بـ api/turn.js و
// api/analyze.js، لكن مباشرة داخل نفس الدالة (بدون HTTP call لـ/api/turn)
// عشان ما يصطدم بحد rate limit اللي بـ lib/rateLimit.js (محسوب حسب IP،
// وكل مستخدمين البوت راح يشاركون نفس IP لو استدعينا عبر HTTP عادي).

const { callGeminiWithRetry, parseGeminiJson } = require('../lib/geminiCall');

const LEVELS = ['A1', 'A2', 'B1', 'B2', 'C1', 'C2'];
const MAX_TURNS = 9;

const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const WEBHOOK_SECRET = process.env.TELEGRAM_WEBHOOK_SECRET;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-3.5-flash';

const OPENING_QUESTION = {
  en: "Hi! Let's start — tell me a little about yourself and what you did today.",
  ar: 'هلا! خلنا نبدأ — حدثني شوي عن نفسك وش سويت اليوم.',
  type: 'talk',
  topicCategory: 'intro_daily_life'
};

const IELTS_BY_CEFR = { A1: '2.0–3.0', A2: '3.5–4.0', B1: '4.5–5.5', B2: '6.0–6.5', C1: '7.0–8.0', C2: '8.5–9.0' };
const LEVEL_AR = { A1: 'مبتدئ', A2: 'مبتدئ متقدم', B1: 'متوسط', B2: 'متوسط متقدم', C1: 'متقدم', C2: 'محترف' };

// ---------- Supabase REST (service role) ----------
async function sbGet(chatId) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/telegram_sessions?chat_id=eq.${chatId}&select=*`, {
    headers: { apikey: SERVICE_ROLE_KEY, Authorization: `Bearer ${SERVICE_ROLE_KEY}` }
  });
  const rows = await res.json();
  return rows[0] || null;
}

async function sbUpsert(session) {
  await fetch(`${SUPABASE_URL}/rest/v1/telegram_sessions`, {
    method: 'POST',
    headers: {
      apikey: SERVICE_ROLE_KEY,
      Authorization: `Bearer ${SERVICE_ROLE_KEY}`,
      'Content-Type': 'application/json',
      Prefer: 'resolution=merge-duplicates'
    },
    body: JSON.stringify({ ...session, updated_at: new Date().toISOString() })
  });
}

// ---------- Telegram API ----------
async function tgSend(chatId, text) {
  await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text })
  });
}

async function tgGetFileUrl(fileId) {
  const res = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/getFile?file_id=${fileId}`);
  const data = await res.json();
  return `https://api.telegram.org/file/bot${BOT_TOKEN}/${data.result.file_path}`;
}

// ---------- تحويل الصوت لنص عبر Gemini (يدعم صوت مباشرة كـ input) ----------
async function transcribeVoice(fileUrl) {
  const audioRes = await fetch(fileUrl);
  const buf = Buffer.from(await audioRes.arrayBuffer());
  const base64Audio = buf.toString('base64');

  const geminiRes = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${GEMINI_API_KEY}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{
          role: 'user',
          parts: [
            { text: 'Transcribe this English speech to plain text. Output ONLY the transcript, nothing else.' },
            { inlineData: { mimeType: 'audio/ogg', data: base64Audio } }
          ]
        }]
      })
    }
  );
  const data = await geminiRes.json();
  const text = data?.candidates?.[0]?.content?.parts?.[0]?.text || '';
  return text.trim();
}

// ---------- نفس منطق turn.js ----------
async function runTurn(session) {
  const isCalibration = session.turn_number <= 2;
  const isLastTurn = session.turn_number >= MAX_TURNS;
  const approxLevel = LEVELS[Math.max(0, Math.min(5, session.current_level_index))];

  const transcript = session.history.map((h, i) =>
    `Turn ${i + 1} [${h.type}${h.topicCategory ? '/' + h.topicCategory : ''}]: ${h.question}\nStudent: ${h.answer}`
  ).join('\n\n');

  const calibrationInstructions = isCalibration
    ? `\n- IMPORTANT: this is a CALIBRATION turn. Ask the next question at a moderate, universally-approachable difficulty regardless of approxLevel. Still classify "turnCefrEstimate" as accurately as possible.`
    : `\n- This is a normal adaptive turn (calibration is complete). Adapt difficulty using the rules below as usual.`;

  const systemPrompt = `You are an expert English speaking examiner running a live adaptive spoken interview, calibrating difficulty to the CEFR scale (A1-C2) turn by turn.

Rules:
- The student's current estimated level is ${approxLevel}. Judge ONLY the most recent answer (the last turn in the transcript).
- Classify the most recent answer's own CEFR level (turnCefrEstimate) based on grammar accuracy, vocabulary range, coherence, and how well it answers what was asked. Do NOT judge pronunciation/accent — text transcript only.
- Also output "direction": "harder" | "same" | "easier" relative to the question's difficulty.
- If approxLevel is A1/A2: keep questions short/concrete, add gentle encouragement in quickReply.
- If approxLevel is C1/C2: escalate faster, ask genuine follow-ups rooted in the student's actual last answer.
- Vary topic categories: intro_daily_life, opinion_reasoning, narrative_experience, hypothetical_planning, argumentative_debate (C1+ only).
- Natural spoken English, not textbook-formal.${calibrationInstructions}
${isLastTurn ? '- This is the FINAL turn. Set "isFinal": true and "nextQuestion": null.' : '- Set "isFinal": false and provide "nextQuestion".'}

Respond with ONLY valid JSON:
{
  "turnCefrEstimate": "one of A1|A2|B1|B2|C1|C2",
  "direction": "harder|same|easier",
  "quickReplyEn": "short natural reaction, max 12 words",
  "quickReplyAr": "Gulf Arabic equivalent",
  "isFinal": ${isLastTurn},
  "nextQuestion": ${isLastTurn ? 'null' : '{"en": "...", "ar": "...", "type": "talk", "topicCategory": "..."}'}
}`;

  const { ok, data } = await callGeminiWithRetry({
    apiKey: GEMINI_API_KEY,
    model: GEMINI_MODEL,
    systemPrompt,
    userText: 'Interview transcript so far:\n\n' + transcript,
    generationConfig: { maxOutputTokens: 1200, responseMimeType: 'application/json', thinkingConfig: { thinkingLevel: 'low' } }
  });
  if (!ok) throw new Error('Gemini turn call failed');
  return parseGeminiJson(data).parsed;
}

// ---------- نفس منطق analyze.js ----------
async function runAnalyze(session) {
  const validLevels = session.turn_levels.filter(l => LEVELS.includes(l));
  const used = validLevels.slice(-5);
  const indices = used.map(l => LEVELS.indexOf(l)).sort((a, b) => a - b);
  let medianIndex = 2;
  if (indices.length) {
    const mid = Math.floor(indices.length / 2);
    medianIndex = indices.length % 2 !== 0 ? indices[mid] : Math.round((indices[mid - 1] + indices[mid]) / 2);
  }
  const finalLevel = LEVELS[medianIndex];

  const transcript = session.history.map((h, i) =>
    `Turn ${i + 1} [${h.type}]: ${h.question}\nStudent: ${h.answer}`
  ).join('\n\n');

  const systemPrompt = `You are an expert English examiner writing the FINAL report for a spoken interview already scored. The determined CEFR level is ${finalLevel} — do not change it, just build the qualitative report around it.

Judge across exactly 4 categories: grammar, vocabulary, fluency, listening_comprehension. Text transcript only — never comment on pronunciation.

Respond with ONLY valid JSON:
{
  "summary_ar": "2-3 sentence overall summary in Arabic",
  "categoryScores": [
    {"name_ar": "القواعد", "score": 0-100, "note_ar": "..."},
    {"name_ar": "المفردات", "score": 0-100, "note_ar": "..."},
    {"name_ar": "الطلاقة والتواصل", "score": 0-100, "note_ar": "..."},
    {"name_ar": "الاستماع والفهم", "score": 0-100, "note_ar": "..."}
  ],
  "strengths_ar": ["up to 3, Arabic"],
  "weaknesses_ar": ["up to 3, Arabic"],
  "recommendation_ar": "1-2 sentence practical recommendation in Arabic"
}`;

  const { ok, data } = await callGeminiWithRetry({
    apiKey: GEMINI_API_KEY,
    model: GEMINI_MODEL,
    systemPrompt,
    userText: 'Full interview transcript:\n\n' + transcript,
    generationConfig: { maxOutputTokens: 2000, responseMimeType: 'application/json', thinkingConfig: { thinkingLevel: 'low' } }
  });
  if (!ok) throw new Error('Gemini analyze call failed');
  const parsed = parseGeminiJson(data).parsed;
  parsed.level = finalLevel;
  parsed.levelName_ar = LEVEL_AR[finalLevel];
  parsed.ieltsEstimate = IELTS_BY_CEFR[finalLevel];
  return parsed;
}

function formatReport(r) {
  const cats = r.categoryScores.map(c => `• ${c.name_ar}: ${c.score}/100 — ${c.note_ar}`).join('\n');
  return `🎯 النتيجة: ${r.level} (${r.levelName_ar})\n📊 تقدير IELTS: ${r.ieltsEstimate}\n\n${r.summary_ar}\n\n${cats}\n\n✅ نقاط القوة:\n${r.strengths_ar.map(s => '• ' + s).join('\n')}\n\n📌 تحتاج تحسين:\n${r.weaknesses_ar.map(s => '• ' + s).join('\n')}\n\n💡 التوصية: ${r.recommendation_ar}\n\nابدأ جلسة جديدة بأي وقت بـ /start`;
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(200).send('ok');

  if (WEBHOOK_SECRET && req.headers['x-telegram-bot-api-secret-token'] !== WEBHOOK_SECRET) {
    return res.status(401).end();
  }

  try {
    const message = req.body?.message;
    if (!message) return res.status(200).end();
    const chatId = message.chat.id;

    if (message.text === '/start') {
      await sbUpsert({
        chat_id: chatId, history: [], pending_question: OPENING_QUESTION,
        current_level_index: 2, turn_number: 0, turn_levels: [],
        last_direction: null, direction_streak: 0, status: 'in_progress'
      });
      await tgSend(chatId, `${OPENING_QUESTION.ar}\n\n${OPENING_QUESTION.en}`);
      return res.status(200).end();
    }

    let session = await sbGet(chatId);
    if (!session || session.status !== 'in_progress') {
      session = {
        chat_id: chatId, history: [], pending_question: OPENING_QUESTION,
        current_level_index: 2, turn_number: 0, turn_levels: [],
        last_direction: null, direction_streak: 0, status: 'in_progress'
      };
      await sbUpsert(session);
      await tgSend(chatId, `${OPENING_QUESTION.ar}\n\n${OPENING_QUESTION.en}`);
      return res.status(200).end();
    }

    let answerText;
    if (message.voice) {
      await tgSend(chatId, '🎙️ ثانية أسمع...');
      const fileUrl = await tgGetFileUrl(message.voice.file_id);
      answerText = await transcribeVoice(fileUrl);
    } else if (message.text) {
      answerText = message.text;
    } else {
      await tgSend(chatId, 'ابعث نص أو رسالة صوتية بس 🙂');
      return res.status(200).end();
    }

    const q = session.pending_question;
    session.history.push({ type: q.type, topicCategory: q.topicCategory, question: q.en, answer: answerText });
    session.turn_number += 1;

    const result = await runTurn(session);
    session.turn_levels.push(result.turnCefrEstimate);

    // تصعيب/تسهيل تقريبي: يحتاج إشارتين متتاليتين بنفس الاتجاه (مو مطابق
    // 100% لمنطق الفرونت إند الأصلي لـVolish، تقدر تظبطه لاحقًا لو تبي).
    if (session.turn_number > 2) {
      if (result.direction === session.last_direction && result.direction !== 'same') {
        session.direction_streak += 1;
        if (session.direction_streak >= 2) {
          session.current_level_index += result.direction === 'harder' ? 1 : -1;
          session.current_level_index = Math.max(0, Math.min(5, session.current_level_index));
          session.direction_streak = 0;
        }
      } else {
        session.direction_streak = 0;
      }
    }
    session.last_direction = result.direction;

    if (result.isFinal) {
      const report = await runAnalyze(session);
      session.status = 'completed';
      session.pending_question = null;
      await sbUpsert(session);
      await tgSend(chatId, formatReport(report));
    } else {
      session.pending_question = result.nextQuestion;
      await sbUpsert(session);
      await tgSend(chatId, `${result.quickReplyAr}\n\n${result.nextQuestion.ar}\n${result.nextQuestion.en}`);
    }

    return res.status(200).end();
  } catch (err) {
    console.error('telegram-webhook error', err);
    return res.status(200).end(); // نرد 200 دايمًا عشان تيليجرام ما يعيد إرسال نفس الأبديت
  }
};
