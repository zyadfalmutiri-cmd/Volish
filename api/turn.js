// api/turn.js
// Vercel serverless function — evaluates the student's latest answer and
// generates the next adaptive question. Called once per conversation turn.
// Requires GEMINI_API_KEY env var (Google AI Studio, free tier).

const { checkRateLimit } = require('../lib/rateLimit');
const { callGeminiWithRetry, parseGeminiJson } = require('../lib/geminiCall');

const LEVELS = ['A1', 'A2', 'B1', 'B2', 'C1', 'C2'];
const DIRECTIONS = ['harder', 'same', 'easier'];

// تحقق سطحي من شكل رد الذكاء الاصطناعي بعد نجاح JSON.parse — عشان لو رجّع
// JSON صحيح تقنيًا لكن ناقص حقل متوقّع، نرجّع خطأ عربي واضح للفرونت إند
// بدل ما نرسل كائن ناقص يطيح الواجهة أو منطق التكيّف بالفرونت إند.
function validateTurnShape(parsed) {
  if (!parsed || typeof parsed !== 'object') return 'root is not an object';
  if (!LEVELS.includes(parsed.turnCefrEstimate)) return 'invalid turnCefrEstimate';
  if (!DIRECTIONS.includes(parsed.direction)) return 'invalid direction';
  if (typeof parsed.quickReplyEn !== 'string') return 'missing quickReplyEn';
  if (typeof parsed.quickReplyAr !== 'string') return 'missing quickReplyAr';
  if (typeof parsed.isFinal !== 'boolean') return 'missing isFinal';
  if (parsed.isFinal) {
    if (parsed.nextQuestion !== null && parsed.nextQuestion !== undefined) return 'nextQuestion must be null when isFinal is true';
  } else {
    const q = parsed.nextQuestion;
    if (!q || typeof q.en !== 'string' || typeof q.ar !== 'string' || typeof q.type !== 'string') {
      return 'malformed nextQuestion';
    }
  }
  return null; // صحيح
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  // الرايت ليمتر نفسه fail-open داخليًا (يسمح بالطلب لو صار خطأ شبكة/Supabase
  // بالاستدعاء)، لكن لفّيناه هنا كمان بـ try/catch احتياطي عشان أي استثناء
  // غير متوقع ما يطيح الفنكشن كاملة بخطأ Vercel خام بدل رسالة الخطأ العربية.
  let rateLimitOk = true;
  try {
    rateLimitOk = await checkRateLimit(req);
  } catch (rlErr) {
    console.error('turn.js: checkRateLimit threw unexpectedly, failing open', rlErr);
    rateLimitOk = true;
  }
  if (!rateLimitOk) {
    res.status(429).json({ error: 'عدد الطلبات كثير جدًا خلال وقت قصير. حاول مرة ثانية بعد دقيقة.' });
    return;
  }

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    res.status(500).json({
      error: 'GEMINI_API_KEY is not set on the server. Add it in Vercel > Project Settings > Environment Variables, then redeploy.'
    });
    return;
  }

  const model = process.env.GEMINI_MODEL || 'gemini-3.5-flash';

  try {
    const { history, currentLevelIndex, turnNumber, maxTurns, isCalibration, avoidTopics } = req.body || {};
    if (!Array.isArray(history) || history.length === 0) {
      res.status(400).json({ error: 'Missing "history" array in request body.' });
      return;
    }
    if (history.length > 40) {
      res.status(400).json({ error: 'حجم المحادثة أكبر من المسموح.' });
      return;
    }
    const rawSize = JSON.stringify(req.body || {}).length;
    if (rawSize > 30000) {
      res.status(413).json({ error: 'حجم البيانات المرسلة كبير جدًا.' });
      return;
    }

    const approxLevel = LEVELS[Math.max(0, Math.min(5, currentLevelIndex ?? 2))];
    const isLastTurn = (turnNumber >= (maxTurns || 9));

    const transcript = history.map((h, i) =>
      `Turn ${i + 1} [${h.type}${h.topicCategory ? '/' + h.topicCategory : ''}]: ${h.question}\nStudent: ${h.answer}`
    ).join('\n\n');

    // Phase 2 UX decision: "محادثة تحديد المستوى بأول 1-2 سؤال" — the first
    // couple of turns exist purely to establish a ballpark starting level,
    // before the normal turn-by-turn adaptive escalation takes over. This
    // avoids intimidating a true beginner or boring an advanced speaker
    // while the slower two-in-a-row adaptation rule is still "warming up".
    const calibrationInstructions = isCalibration ? `
- IMPORTANT: this is a CALIBRATION turn (one of the first 1-2 assessed turns). Your job right now is to help place the student's ballpark CEFR level as accurately as possible from this single answer — NOT to escalate or de-escalate difficulty yet.
- Ask the next question at a moderate, universally-approachable difficulty (a concrete, everyday question any level can attempt), regardless of the student's assumed level — do not tailor difficulty to approxLevel during calibration.
- Still classify "turnCefrEstimate" as accurately as possible — this estimate is what determines the student's real starting level, so judge it carefully and don't default to the middle out of caution.
- The "direction" field will be ignored by the caller during calibration — you may still fill it in, but it has no effect this turn.` : `
- This is a normal adaptive turn (calibration is complete). Adapt difficulty using the rules below as usual.`;

    // Phase 6: returning users shouldn't get the same opening topic category
    // as their last session (per the ProgressSnapshot/reports history). This
    // is a soft steer, not a hard ban — never force an awkward question.
    const avoidTopicsList = Array.isArray(avoidTopics) ? avoidTopics.filter(Boolean) : [];
    const avoidTopicsInstructions = avoidTopicsList.length ? `
- This student has a previous session on record. Their last session opened with these topic categories: ${avoidTopicsList.join(', ')}. Prefer a DIFFERENT topic category for this question if one fits just as naturally — avoid repeating the same opening topic across sessions. This is a soft preference: never force an awkward or unnatural question just to dodge a topic.` : '';

    const systemPrompt = `You are an expert English speaking examiner running a live adaptive spoken interview, calibrating difficulty to the CEFR scale (A1-C2) turn by turn.

Rules for adapting difficulty:
- The student's current estimated level is ${approxLevel}. Judge ONLY the most recent answer (the last turn in the transcript).
- Classify the most recent answer's own CEFR level (turnCefrEstimate) based on grammar accuracy, vocabulary range, coherence, and how well it actually answers what was asked. Do NOT judge pronunciation or accent — you only see a text transcript.
- Also output "direction": whether the LAST ANSWER was "harder" (student handled the current question easily, ready for tougher), "same" (matched expectation), or "easier" (student struggled, needs a step down) relative to the question's difficulty. Do not overreact to a single answer — this signal will only be acted on by the caller after two consecutive matching signals.
- If approxLevel is A1/A2: keep the next question short and concrete, never abstract/hypothetical, add a bit of gentle encouragement in quickReply, and never escalate right after a single weak answer.
- If approxLevel is C1/C2: escalate faster, ask a genuine follow-up rooted in specific details from the student's actual last answer (not a generic bank question), and topics can include argumentative/debate prompts.
- Only ask a deeper follow-up ON THE SAME TOPIC as the last question if the last answer left room to go deeper AND approxLevel is B1 or higher. Otherwise move to a fresh topic category.
- Vary topic categories across the session. Categories: intro_daily_life, opinion_reasoning, narrative_experience, hypothetical_planning, argumentative_debate (C1+ only).
- Write natural, everyday spoken English for questions — not textbook-formal English.
${calibrationInstructions}
${avoidTopicsInstructions}
${isLastTurn ? '- This is the FINAL turn of the session. Set "isFinal": true and "nextQuestion": null.' : '- Set "isFinal": false and provide "nextQuestion".'}

Respond with ONLY valid JSON (no markdown fences, no preamble, no explanation outside the JSON). Exact schema:
{
  "turnCefrEstimate": "one of A1|A2|B1|B2|C1|C2",
  "direction": "harder|same|easier",
  "quickReplyEn": "a short (max 12 words) natural conversational reaction to the student's last answer, in English",
  "quickReplyAr": "Gulf Arabic translation/equivalent of quickReplyEn, short",
  "isFinal": ${isLastTurn},
  "nextQuestion": ${isLastTurn ? 'null' : '{"en": "the next question in English", "ar": "Gulf Arabic translation of the question", "type": "talk", "topicCategory": "one of the categories above"}'}
}`;

    const { ok, status, data } = await callGeminiWithRetry({
      apiKey,
      model,
      systemPrompt,
      userText: 'Interview transcript so far:\n\n' + transcript,
      generationConfig: {
        // NOTE: on thinking-enabled Gemini models, internal "thinking" tokens
        // are drawn from this same budget. A tight limit here can let the
        // model burn the whole budget thinking and leave nothing for the
        // actual JSON output, which truncates the response and breaks
        // JSON.parse below. Keep this generous even for a small per-turn reply.
        maxOutputTokens: 1200,
        responseMimeType: 'application/json',
        // القيمة هنا مجرد "نية" افتراضية — lib/geminiCall.js يستبدلها تلقائيًا
        // بالشكل الصح (thinkingLevel أو thinkingBudget) حسب عائلة كل موديل
        // فعليًا يُجرَّب بسلسلة الـfallback.
        thinkingConfig: { thinkingLevel: 'low' }
      }
    });

    if (!ok) {
      res.status(status).json({ error: (data && data.error && data.error.message) || 'Gemini API error' });
      return;
    }

    let parsed, candidate, textOut;
    try {
      ({ parsed, candidate, textOut } = parseGeminiJson(data));
    } catch (parseErr) {
      const c = data.candidates && data.candidates[0];
      console.error('turn.js: failed to parse Gemini JSON', {
        finishReason: c && c.finishReason,
        error: parseErr.message
      });
      res.status(502).json({ error: 'صار خطأ بمعالجة رد نظام الذكاء الاصطناعي. حاول مرة ثانية.' });
      return;
    }

    const shapeError = validateTurnShape(parsed);
    if (shapeError) {
      console.error('turn.js: Gemini JSON has unexpected shape', {
        finishReason: candidate && candidate.finishReason,
        shapeError,
        textPreview: textOut.slice(0, 300)
      });
      res.status(502).json({ error: 'صار خطأ بمعالجة رد نظام الذكاء الاصطناعي. حاول مرة ثانية.' });
      return;
    }

    res.status(200).json(parsed);
  } catch (err) {
    res.status(500).json({ error: 'صار خطأ غير متوقع بالسيرفر. حاول مرة ثانية.' });
  }
};
