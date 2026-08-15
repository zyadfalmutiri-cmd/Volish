// api/plan.js
// Vercel serverless function — generates a personalized ONE-WEEK study plan
// from an already-completed report (weaknesses/strengths/level).
// Requires GEMINI_API_KEY env var (Google AI Studio, free tier).

const { checkRateLimit } = require('../lib/rateLimit');
const { callGeminiWithRetry, parseGeminiJson } = require('../lib/geminiCall');

const FOCUS_VALUES = ['grammar', 'vocabulary', 'fluency', 'listening_comprehension'];

// تحقق سطحي من شكل رد الذكاء الاصطناعي بعد نجاح JSON.parse — عشان لو رجّع
// JSON صحيح تقنيًا لكن ناقص حقل متوقّع، نرجّع خطأ عربي واضح للفرونت إند
// بدل ما نرسل كائن ناقص يطيح الواجهة.
function validatePlanShape(parsed) {
  if (!parsed || typeof parsed !== 'object') return 'root is not an object';
  if (!Array.isArray(parsed.weeklyGoals) || parsed.weeklyGoals.some(g => typeof g !== 'string')) {
    return 'weeklyGoals must be an array of strings';
  }
  if (!Array.isArray(parsed.suggestedExercises)) return 'suggestedExercises must be an array';
  for (const ex of parsed.suggestedExercises) {
    if (!ex || typeof ex.title_ar !== 'string' || typeof ex.description_ar !== 'string' || !FOCUS_VALUES.includes(ex.focus)) {
      return 'malformed suggestedExercises item';
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
    console.error('plan.js: checkRateLimit threw unexpectedly, failing open', rlErr);
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
    const { report } = req.body || {};
    if (!report || !report.level) {
      res.status(400).json({ error: 'Missing "report" object (needs at least a "level" field) in request body.' });
      return;
    }
    const rawSize = JSON.stringify(req.body || {}).length;
    if (rawSize > 20000) {
      res.status(413).json({ error: 'حجم البيانات المرسلة كبير جدًا.' });
      return;
    }

    const weaknesses = (report.weaknesses_ar || []).join('؛ ') || 'غير محدد';
    const strengths = (report.strengths_ar || []).join('؛ ') || 'غير محدد';

    const systemPrompt = `You are an English learning coach. Based on a student's CEFR speaking assessment report, write a practical ONE-WEEK study plan to help them move toward the next CEFR level.

Student's current level: ${report.level}
Weaknesses identified: ${weaknesses}
Strengths identified: ${strengths}

Respond with ONLY valid JSON (no markdown fences, no preamble, no explanation outside the JSON). Exact schema:
{
  "weeklyGoals": ["up to 4 short, specific, achievable goals in Arabic for this week — each tied to one of the weaknesses above"],
  "suggestedExercises": [
    {"title_ar": "short exercise name in Arabic", "description_ar": "1-2 sentence practical description in Arabic of exactly what to do", "focus": "grammar|vocabulary|fluency|listening_comprehension"}
  ]
}
Limit "suggestedExercises" to at most 5 items. Be concrete and specific to this student's actual weaknesses — never generic "practice more" advice.`;

    const { ok, status, data } = await callGeminiWithRetry({
      apiKey,
      model,
      systemPrompt,
      userText: 'Generate this week\'s plan now.',
      generationConfig: {
        // NOTE: on thinking-enabled Gemini models, internal "thinking" tokens
        // are drawn from this same budget. A tight limit here can let the
        // model burn the whole budget thinking and leave nothing for the
        // actual JSON output, which truncates the response and breaks
        // JSON.parse below. Keep this generous for a multi-exercise plan.
        maxOutputTokens: 1500,
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
      console.error('plan.js: failed to parse Gemini JSON', {
        finishReason: c && c.finishReason,
        error: parseErr.message
      });
      res.status(502).json({ error: 'صار خطأ بمعالجة رد نظام الذكاء الاصطناعي. حاول مرة ثانية.' });
      return;
    }

    const shapeError = validatePlanShape(parsed);
    if (shapeError) {
      console.error('plan.js: Gemini JSON has unexpected shape', {
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
