// lib/geminiCall.js
// مساعد موحّد لاستدعاء Gemini API (generateContent) يستخدمه api/turn.js و
// api/analyze.js و api/plan.js.
//
// طبقتين حماية من "high demand" / أخطاء مؤقتة:
// 1) إعادة محاولة (retry + backoff) على نفس النموذج.
// 2) لو نفس النموذج فاضل مزدحم، يتحول تلقائيًا لنموذج مجاني ثاني من نفس
//    المفتاح (fallback) بدل ما يطلع الخطأ للمستخدم مباشرة.

const RETRYABLE_STATUS = new Set([429, 500, 503]); // أخطاء مؤقتة يستاهل نعيد المحاولة فيها

// عدد محاولات إضافية على نفس النموذج قبل ما ننتقل للي بعده
const RETRIES_PER_MODEL = 1;
const BASE_DELAY_MS = 700;

// سلسلة النماذج المجانية البديلة (كلها Flash/Flash-Lite — النماذج المتاحة
// مجانًا بـGoogle AI Studio). ينتقل لها بالترتيب لو النموذج الأساسي فشل.
// تقدر تتحكم فيها عبر متغير بيئة GEMINI_FALLBACK_MODELS مفصول بفواصل،
// بدون ما تلمس الكود، مثال: "gemini-2.5-flash,gemini-3.1-flash-lite"
const DEFAULT_FALLBACK_MODELS = [
  'gemini-2.5-flash',
  'gemini-3.5-flash-lite',
  'gemini-3.1-flash-lite',
  'gemini-2.5-flash-lite'
];

function getFallbackModels(primaryModel) {
  const configured = (process.env.GEMINI_FALLBACK_MODELS || '')
    .split(',')
    .map(s => s.trim())
    .filter(Boolean);
  const list = configured.length ? configured : DEFAULT_FALLBACK_MODELS;
  // ما نكرر النموذج الأساسي لو كان موجود بالقائمة صدفة
  return list.filter(m => m !== primaryModel);
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// يحاول نموذج واحد بس، مع إعادة محاولة محدودة (RETRIES_PER_MODEL) بتأخير متصاعد.
async function tryModel({ apiKey, model, systemPrompt, userText, generationConfig }) {
  let lastStatus = 500;
  let lastData = null;

  for (let attempt = 0; attempt <= RETRIES_PER_MODEL; attempt++) {
    let geminiRes;
    try {
      geminiRes = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            systemInstruction: { parts: [{ text: systemPrompt }] },
            contents: [{ role: 'user', parts: [{ text: userText }] }],
            generationConfig
          })
        }
      );
    } catch (networkErr) {
      if (attempt < RETRIES_PER_MODEL) {
        await sleep(BASE_DELAY_MS * Math.pow(2, attempt));
        continue;
      }
      return { ok: false, status: 502, data: { error: { message: networkErr.message } }, modelUsed: model };
    }

    const data = await geminiRes.json().catch(() => null);

    if (geminiRes.ok) {
      return { ok: true, status: geminiRes.status, data, modelUsed: model };
    }

    lastStatus = geminiRes.status;
    lastData = data;

    if (RETRYABLE_STATUS.has(geminiRes.status) && attempt < RETRIES_PER_MODEL) {
      await sleep(BASE_DELAY_MS * Math.pow(2, attempt));
      continue;
    }

    return { ok: false, status: lastStatus, data: lastData, modelUsed: model };
  }

  return { ok: false, status: lastStatus, data: lastData, modelUsed: model };
}

/**
 * ينادي Gemini generateContent مع إعادة محاولة على نفس النموذج، ولو فشل
 * بالكامل ينتقل تلقائيًا لنموذج مجاني بديل من نفس المفتاح.
 * يرجع { ok, status, data, modelUsed } — modelUsed يفيدك لو تبي تعرف أي
 * نموذج فعليًا رد (تقدر تتجاهله لو ما تحتاجه).
 */
async function callGeminiWithRetry({ apiKey, model, systemPrompt, userText, generationConfig }) {
  const modelsToTry = [model, ...getFallbackModels(model)];

  let result = null;
  for (const candidateModel of modelsToTry) {
    result = await tryModel({ apiKey, model: candidateModel, systemPrompt, userText, generationConfig });
    if (result.ok) return result;

    // خطأ غير قابل لإعادة المحاولة أصلاً (مثلاً 400 طلب غلط) — ما فيه فايدة
    // نجرب نموذج ثاني، لأنه غالبًا نفس الغلط بيصير معه
    if (!RETRYABLE_STATUS.has(result.status)) return result;

    // وإلا نكمل لآخر نموذج بالقائمة
  }

  return result;
}

module.exports = { callGeminiWithRetry };
