// api/analyze.js
// Vercel serverless function — final holistic report: CEFR level + IELTS estimate
// + 4 grouped category scores, computed from the full adaptive interview.
// Requires GEMINI_API_KEY env var (Google AI Studio, free tier).

const { checkRateLimit } = require('../lib/rateLimit');
const { callGeminiWithRetry, parseGeminiJson } = require('../lib/geminiCall');

const LEVELS = ['A1', 'A2', 'B1', 'B2', 'C1', 'C2'];

// تحقق سطحي من شكل رد الذكاء الاصطناعي بعد نجاح JSON.parse — عشان لو رجّع
// JSON صحيح تقنيًا لكن ناقص حقل متوقّع، نرجّع خطأ عربي واضح للفرونت إند
// بدل ما نرسل كائن ناقص يطيح الواجهة.
function validateAnalyzeShape(parsed) {
  if (!parsed || typeof parsed !== 'object') return 'root is not an object';
  if (typeof parsed.summary_ar !== 'string' || !parsed.summary_ar.trim()) return 'missing summary_ar';
  if (!Array.isArray(parsed.categoryScores) || parsed.categoryScores.length !== 4) return 'categoryScores must be an array of 4 items';
  for (const c of parsed.categoryScores) {
    if (!c || typeof c.name_ar !== 'string' || typeof c.score !== 'number' || typeof c.note_ar !== 'string') {
      return 'malformed categoryScores item';
    }
  }
  if (!Array.isArray(parsed.strengths_ar)) return 'strengths_ar must be an array';
  if (!Array.isArray(parsed.weaknesses_ar)) return 'weaknesses_ar must be an array';
  if (!Array.isArray(parsed.corrections)) return 'corrections must be an array';
  if (typeof parsed.recommendation_ar !== 'string' || !parsed.recommendation_ar.trim()) return 'missing recommendation_ar';
  return null; // صحيح
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  // الرايت ليمتر نفسه fail-open داخليًا (يسمح بالطلب لو صار خطأ شبكة/Supabase
  // بالاستدعاء)، لكن لفّيناه هنا كمان بـ try/catch احتياطي عشان أي استثناء
  // غير متوقع (مثلاً بفحص Origin header نفسه) ما يطيح الفنكشن كاملة بخطأ
  // Vercel خام بدل رسالة الخطأ العربية.
  let rateLimitOk = true;
  try {
    rateLimitOk = await checkRateLimit(req);
  } catch (rlErr) {
    console.error('analyze.js: checkRateLimit threw unexpectedly, failing open', rlErr);
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

  const IELTS_BY_CEFR = {
    A1: '2.0–3.0', A2: '3.5–4.0', B1: '4.5–5.5',
    B2: '6.0–6.5', C1: '7.0–8.0', C2: '8.5–9.0'
  };
  const LEVEL_AR = { A1: 'مبتدئ', A2: 'مبتدئ متقدم', B1: 'متوسط', B2: 'متوسط متقدم', C1: 'متقدم', C2: 'محترف' };

  try {
    const { history, turnLevels } = req.body || {};
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

    // ---- Deterministic CEFR calculation: median of the last up-to-5 per-turn
    // levels (never an average), so a single stray answer can't skew the result.
    //
    // ⚠️ ملاحظة معروفة (غير مصلَحة بعد — راجع "يحتاج تحقق" بتقرير المخاطر):
    // turnLevels يوصل هنا من req.body مباشرة بدون تحقق من جلسة محفوظة
    // بالسيرفر. إصلاحها الكامل يحتاج تصميم جلسة (session) بـSupabase تخزن
    // turnCefrEstimate من كل سؤال وقت صيره فعليًا بـapi/turn.js، وهذا
    // يحتاج قرار تصميم (schema + auth) قبل ما يُطبَّق.
    const validLevels = (turnLevels || []).filter(l => LEVELS.includes(l));
    const usedLevels = validLevels.slice(-5);
    const indices = usedLevels.map(l => LEVELS.indexOf(l)).sort((a, b) => a - b);

    let medianIndex = 2;
    if (indices.length > 0) {
      const mid = Math.floor(indices.length / 2);
      medianIndex = indices.length % 2 !== 0
        ? indices[mid]
        : Math.round((indices[mid - 1] + indices[mid]) / 2);
    }
    const spread = indices.length ? (indices[indices.length - 1] - indices[0]) : 0;
    const finalLevel = LEVELS[medianIndex];
    const lowConfidence = usedLevels.length < 5 || spread >= 2;
    const rangeLevel = (lowConfidence && indices.length)
      ? `${LEVELS[indices[0]]}–${LEVELS[indices[indices.length - 1]]}`
      : null;

    const transcript = history.map((h, i) =>
      `Turn ${i + 1} [${h.type}]: ${h.question}\nStudent: ${h.answer}`
    ).join('\n\n');

    const systemPrompt = `You are an expert English examiner writing the FINAL report for a spoken interview that has already been scored. The determined CEFR level is ${finalLevel}${rangeLevel ? ` (uncertain, range ${rangeLevel})` : ''} — do NOT change or re-decide this level, just build the qualitative report around it.

Judge across exactly 4 grouped categories only (never give more granular sub-scores):
- grammar: sentence accuracy, structure variety, connectors
- vocabulary: word range, accuracy in context, appropriateness
- fluency: length/coherence of answers, flow, connecting ideas
- listening_comprehension: how relevant/on-topic each answer actually was to what was asked

You only have a text transcript (from speech-to-text) — never comment on pronunciation or accent, since no real audio was analyzed.

Respond with ONLY valid JSON (no markdown fences, no preamble, no explanation outside the JSON). Exact schema:
{
  "summary_ar": "2-3 sentence overall summary in Arabic of the student's English level",
  "categoryScores": [
    {"name_ar": "القواعد", "score": 0-100, "note_ar": "short Arabic note"},
    {"name_ar": "المفردات", "score": 0-100, "note_ar": "short Arabic note"},
    {"name_ar": "الطلاقة والتواصل", "score": 0-100, "note_ar": "short Arabic note"},
    {"name_ar": "الاستماع والفهم", "score": 0-100, "note_ar": "short Arabic note"}
  ],
  "strengths_ar": ["up to 3 short strengths, in Arabic"],
  "weaknesses_ar": ["up to 3 short areas to improve, in Arabic"],
  "corrections": [{"original": "a short phrase from the student's actual answers with a grammar/vocabulary issue", "corrected": "the corrected version"}],
  "recommendation_ar": "1-2 sentence practical study recommendation in Arabic for reaching the next level"
}
Limit "corrections" to at most 3 items. Keep every string concise.`;

    const { ok, status, data } = await callGeminiWithRetry({
      apiKey,
      model,
      systemPrompt,
      userText: 'Full interview transcript:\n\n' + transcript,
      generationConfig: {
        // NOTE: on thinking-enabled Gemini models, internal "thinking" tokens
        // are drawn from this same budget. A tight limit here can let the
        // model burn the whole budget thinking and leave nothing for the
        // actual JSON output, which truncates the response and breaks
        // JSON.parse below. Keep this generous for a 4-category report.
        maxOutputTokens: 2500,
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
      // Log enough context to diagnose in Vercel logs without exposing
      // internals to the client (e.g. finishReason === 'MAX_TOKENS' means
      // the response got cut off — raise maxOutputTokens further).
      const c = data.candidates && data.candidates[0];
      console.error('analyze.js: failed to parse Gemini JSON', {
        finishReason: c && c.finishReason,
        error: parseErr.message
      });
      res.status(502).json({ error: 'صار خطأ بمعالجة رد نظام الذكاء الاصطناعي. حاول مرة ثانية.' });
      return;
    }

    const shapeError = validateAnalyzeShape(parsed);
    if (shapeError) {
      console.error('analyze.js: Gemini JSON has unexpected shape', {
        finishReason: candidate && candidate.finishReason,
        shapeError,
        textPreview: textOut.slice(0, 300)
      });
      res.status(502).json({ error: 'صار خطأ بمعالجة رد نظام الذكاء الاصطناعي. حاول مرة ثانية.' });
      return;
    }

    parsed.level = finalLevel;
    parsed.levelName_ar = LEVEL_AR[finalLevel];
    parsed.ieltsEstimate = IELTS_BY_CEFR[finalLevel];
    parsed.rangeLevel = rangeLevel;
    parsed.lowConfidence = lowConfidence;

    res.status(200).json(parsed);
  } catch (err) {
    res.status(500).json({ error: 'صار خطأ غير متوقع بالسيرفر. حاول مرة ثانية.' });
  }
};
